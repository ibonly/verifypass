"use strict";

// Verification worker. Polls job_queue; runs the real verification pipeline
// (Faceplugin liveness + face compare + optional OCR) against MongoDB. Designed
// to run on the cPanel box now and move to a VPS later with zero code change
// (communicates only via DB + shared storage).

require("./src/env");

const config = require("./src/worker/config");
const { createFacepluginProvider } = require("./src/worker/providers/faceplugin");
const { createOnnxProvider } = require("./src/worker/providers/onnx");
const { runVerification, defaultEvidenceKey, PIPELINE_VERSION } = require("./src/worker/pipeline");

const POLL_MS = config.pollMs;
const WORKER_ID = `worker-${process.pid}`;

// Single-worker guard for developer machines: a forgotten worker from an
// earlier code revision keeps polling the same queue and judges sessions with
// stale logic (2026-09-07). Multi-instance deployments set
// WORKER_ALLOW_MULTIPLE=true (each instance still refuses jobs stamped with a
// different policy version, see pipeline.js).
function acquireSingletonLock() {
  if (process.env.WORKER_ALLOW_MULTIPLE === "true") return;
  const fs = require("fs"), path = require("path");
  const file = process.env.WORKER_PIDFILE || path.join(__dirname, ".worker.pid");
  try {
    const other = Number(fs.readFileSync(file, "utf8").trim());
    if (other && other !== process.pid) {
      let alive = false;
      try { process.kill(other, 0); alive = true; } catch (_) { alive = false; }
      if (alive) {
        console.error(`WORKER_ALREADY_RUNNING pid=${other} (${file}). Stop it first, or set WORKER_ALLOW_MULTIPLE=true for a deliberate multi-worker setup.`);
        process.exit(3);
      }
    }
  } catch (_) { /* no pidfile */ }
  fs.writeFileSync(file, String(process.pid));
  const release = () => { try { if (Number(fs.readFileSync(file, "utf8").trim()) === process.pid) fs.unlinkSync(file); } catch (_) { /* noop */ } };
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { release(); process.exit(0); });
}

// ID OCR resolution chain — independent of which biometric engine is in use:
//   1. FACEPLUGIN_IDOCR_URL  — dedicated ID OCR HTTP service (best quality)
//   2. tesseract.js          — local extraction-only OCR (optional npm dep);
//                              results carry validated:false → sessions land
//                              in review with data prefilled, never auto-valid
//   3. provider default      — no OCR → DOCUMENT_OCR_FAILED review
// Failures at any tier degrade to the next instead of crashing the job.
function attachOcr(provider) {
  const { createTesseractOcr } = require("./src/worker/providers/tesseractOcr");
  const tesseract = createTesseractOcr();
  const fallback = tesseract
    ? (buf) => tesseract.extractDocument(buf)
    : provider.extractDocument.bind(provider);

  if (config.faceplugin.idOcrUrl) {
    const ocr = createFacepluginProvider(config.faceplugin);
    provider.extractDocument = async (buf) => {
      try {
        return await ocr.extractDocument(buf);
      } catch (err) {
        console.warn(`ID OCR service failed (${err.message}) — falling back to ${tesseract ? "tesseract.js" : "manual review"}`);
        return fallback(buf);
      }
    };
    provider.ocrEngine = "faceplugin-idocr";
  } else if (tesseract) {
    provider.extractDocument = fallback;
    provider.ocrEngine = "tesseract.js (extraction only)";
  } else {
    provider.ocrEngine = "none (install tesseract.js or set FACEPLUGIN_IDOCR_URL)";
  }
  return provider;
}

function createProvider() {
  const provider = config.provider === "faceplugin"
    ? createFacepluginProvider(config.faceplugin)
    : createOnnxProvider({ modelsDir: config.onnx.modelsDir, matchThreshold: config.onnx.matchThreshold });
  return attachOcr(provider);
}

let deps = null;
function getDeps() {
  if (!deps) {
    deps = {
      db: getDb(),
      provider: createProvider(),
      evidenceKey: defaultEvidenceKey(config),
      // development disables the device-sharing risk signal (dev machines
      // legitimately create many throwaway identities)
      env: config.env,
      // recorded with every result — scores across model versions are not comparable
      modelVersion: config.modelVersion
    };
    console.log(`verification provider: ${deps.provider.name} · ID OCR: ${deps.provider.ocrEngine}`);
  }
  return deps;
}

const { sendWebhook } = require("./src/worker/webhookDispatcher");

const HANDLERS = {
  cleanup_evidence: payload => require("./src/services/cleanupEvidence").cleanupEvidence(payload),
  run_verification: (payload) => runVerification(payload, getDeps()),
  send_webhook: (payload) => sendWebhook(payload, { db: getDeps().db }),
  expire_sessions: async () => {
    const db = getDb();
    await db.verificationSession.updateMany({
      where: { status: { in: ["created", "started"] }, expiresAt: { lt: new Date() } },
      data: { status: "expired" }
    });
    // Watchdog: sessions stuck in "submitted" (worker died mid-job / job
    // retries exhausted) get a terminal SESSION_TIMEOUT instead of silence.
    const { failStuckSubmitted } = require("./src/worker/watchdog");
    const timedOut = await failStuckSubmitted(db);
    if (timedOut) console.log(`expire_sessions: ${timedOut} stuck submitted session(s) → SESSION_TIMEOUT`);
  },
  // Nightly (0 3 * * *  node scripts/enqueueJob.js telemetry_anomaly):
  // robust-statistics anomaly flags over capture telemetry (roadmap 0.5).
  telemetry_anomaly: async (payload) => {
    const { runTelemetryAnomaly } = require("./src/worker/telemetryAnomaly");
    const r = await runTelemetryAnomaly(getDb(), payload || {});
    console.log(`telemetry_anomaly: analysed ${r.analysed}, flagged ${r.flagged}, written ${r.written}`);
  },
  retention_cleanup: async () => {
    const { storage } = require("@verifypass/shared");
    const db = getDb();
    // Phase 1: cap retention for evidence of dead sessions per tenant policy
    const { capFailedSessionRetention } = require("./src/worker/retention");
    const capped = await capFailedSessionRetention(db);
    if (capped) console.log(`retention_cleanup: capped ${capped} evidence files to failed-session policy`);
    // Phase 2: delete whatever is past its (possibly capped) retention date
    const expired = await db.evidenceFile.findMany({
      where: { retentionExpiresAt: { lt: new Date() } },
      take: 500
    });
    for (const file of expired) {
      await storage.removeStored(file.storagePath); // fs or s3://, idempotent
      // Remove any plaintext Cloudinary mirror (H2/L7 fix)
      if (file.cloudinaryPublicId) {
        const { destroyEvidenceImage } = require("./src/services/cloudinaryService");
        await destroyEvidenceImage(file.cloudinaryPublicId);
      }
      await db.evidenceFile.delete({ where: { id: file.id } });
    }
    if (expired.length) console.log(`retention_cleanup: removed ${expired.length} files`);
    // Sweep expired rate-limit windows (DB-backed limiter counters)
    try {
      if (db.rateLimitCounter) {
        await db.rateLimitCounter.deleteMany({ where: { windowEndsAt: { lt: new Date(Date.now() - 3600_000) } } });
      }
    } catch (err) {
      console.warn(`retention_cleanup: rate-limit sweep failed (${err.message})`);
    }
  }
};

let prisma = null;
function getDb() {
  if (!prisma) {
    require("./src/lib/release").assertGeneratedSchema();
    const { PrismaClient } = require("@prisma/client");
    prisma = new PrismaClient();
  }
  return prisma;
}

async function claimJob(db) {
  // Atomic claim without SKIP LOCKED dependency: optimistic update on id.
  const candidate = await db.jobQueue.findFirst({
    where: { status: "pending", runAfter: { lte: new Date() } },
    orderBy: { id: "asc" }
  });
  if (!candidate) return null;
  const claimed = await db.jobQueue.updateMany({
    where: { id: candidate.id, status: "pending" },
    data: { status: "running", lockedBy: WORKER_ID, lockedAt: new Date(), attempts: { increment: 1 } }
  });
  return claimed.count === 1 ? candidate : null; // lost race → try next tick
}

// Stale-lock reclaim is throttled — it's hygiene, not per-tick work.
let lastReclaim = 0;
const RECLAIM_EVERY_MS = 60_000;

async function tick() {
  const db = getDb();
  await require("./src/services/outbox").flushOutbox(db, require("./src/services/jobService").enqueue);
  // Requeue jobs orphaned by a worker that died mid-run (dev restarts do
  // this constantly) — otherwise their sessions sit in "submitted" forever.
  if (Date.now() - lastReclaim > RECLAIM_EVERY_MS) {
    lastReclaim = Date.now();
    await require("./src/services/reconcileEvidence").reconcileEvidence(db);
    try {
      const { reclaimStaleJobs } = require("./src/worker/watchdog");
      const r = await reclaimStaleJobs(db);
      if (r.requeued || r.failed) {
        console.log(`reclaimStaleJobs: requeued ${r.requeued}, failed ${r.failed} orphaned job(s)`);
      }
    } catch (err) {
      console.error("RECLAIM_ERROR", err.message);
    }
  }
  const job = await claimJob(db);
  if (!job) return;
  const handler = HANDLERS[job.type];
  const heartbeat = setInterval(() => db.jobQueue.updateMany({ where: { id: job.id, status: "running", lockedBy: WORKER_ID }, data: { lockedAt: new Date() } }).catch(err => console.error("LEASE_RENEW_FAILED", err.message)), 15000);
  try {
    if (!handler) throw new Error(`Unknown job type: ${job.type}`);
    await handler(job.payload);
    await db.jobQueue.updateMany({ where: { id: job.id, status: "running", lockedBy: WORKER_ID }, data: { status: "done" } });
  } catch (err) {
    if (/^POLICY_VERSION_MISMATCH/.test(err.message)) {
      // Not this worker's job: hand it back without consuming an attempt so a
      // worker on the right release can take it.
      console.error("POLICY_VERSION_MISMATCH", { jobId: job.id, message: err.message });
      await db.jobQueue.updateMany({
        where: { id: job.id, status: "running", lockedBy: WORKER_ID },
        data: { status: "pending", lockedBy: null, lockedAt: null, attempts: { increment: -1 }, lastError: String(err.message).slice(0, 2000), runAfter: new Date(Date.now() + 5000) }
      });
      clearInterval(heartbeat);
      return;
    }
    const exhausted = job.attempts + 1 >= job.maxAttempts;
    await db.jobQueue.updateMany({
      where: { id: job.id, status: "running", lockedBy: WORKER_ID },
      data: {
        status: exhausted ? "failed" : "pending",
        lastError: String(err.message).slice(0, 2000),
        runAfter: new Date(Date.now() + Math.min(60000 * 2 ** job.attempts, 3600000))
      }
    });
  } finally { clearInterval(heartbeat); }
}

async function main() {
  acquireSingletonLock();
  console.log(`VerifyPass worker ${WORKER_ID} polling every ${POLL_MS}ms (pipeline ${PIPELINE_VERSION})`);
  while (true) {
    try {
      await tick();
    } catch (err) {
      console.error("WORKER_TICK_ERROR", err.message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

if (require.main === module) main();

module.exports = { claimJob, HANDLERS, createProviderForLambda: createProvider };
