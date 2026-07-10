"use strict";

// Verification worker. Polls job_queue; runs the real verification pipeline
// (Faceplugin liveness + face compare + optional OCR) against MySQL. Designed
// to run on the cPanel box now and move to a VPS later with zero code change
// (communicates only via DB + shared storage).

require("./src/env");

const config = require("./src/config");
const { createFacepluginProvider } = require("./src/providers/faceplugin");
const { createOnnxProvider } = require("./src/providers/onnx");
const { runVerification, defaultEvidenceKey, PIPELINE_VERSION } = require("./src/pipeline");

const POLL_MS = config.pollMs;
const WORKER_ID = `worker-${process.pid}`;

// ID OCR resolution chain — independent of which biometric engine is in use:
//   1. FACEPLUGIN_IDOCR_URL  — dedicated ID OCR HTTP service (best quality)
//   2. tesseract.js          — local extraction-only OCR (optional npm dep);
//                              results carry validated:false → sessions land
//                              in review with data prefilled, never auto-valid
//   3. provider default      — no OCR → DOCUMENT_OCR_FAILED review
// Failures at any tier degrade to the next instead of crashing the job.
function attachOcr(provider) {
  const { createTesseractOcr } = require("./src/providers/tesseractOcr");
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

const { sendWebhook } = require("./src/webhookDispatcher");

const HANDLERS = {
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
    const { failStuckSubmitted } = require("./src/watchdog");
    const timedOut = await failStuckSubmitted(db);
    if (timedOut) console.log(`expire_sessions: ${timedOut} stuck submitted session(s) → SESSION_TIMEOUT`);
  },
  retention_cleanup: async () => {
    const { storage } = require("@verifypass/shared");
    const db = getDb();
    // Phase 1: cap retention for evidence of dead sessions per tenant policy
    const { capFailedSessionRetention } = require("./src/retention");
    const capped = await capFailedSessionRetention(db);
    if (capped) console.log(`retention_cleanup: capped ${capped} evidence files to failed-session policy`);
    // Phase 2: delete whatever is past its (possibly capped) retention date
    const expired = await db.evidenceFile.findMany({
      where: { retentionExpiresAt: { lt: new Date() } },
      take: 500
    });
    for (const file of expired) {
      await storage.removeStored(file.storagePath); // fs or s3://, idempotent
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
  // Requeue jobs orphaned by a worker that died mid-run (dev restarts do
  // this constantly) — otherwise their sessions sit in "submitted" forever.
  if (Date.now() - lastReclaim > RECLAIM_EVERY_MS) {
    lastReclaim = Date.now();
    try {
      const { reclaimStaleJobs } = require("./src/watchdog");
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
  try {
    if (!handler) throw new Error(`Unknown job type: ${job.type}`);
    await handler(job.payload);
    await db.jobQueue.update({ where: { id: job.id }, data: { status: "done" } });
  } catch (err) {
    const exhausted = job.attempts + 1 >= job.maxAttempts;
    await db.jobQueue.update({
      where: { id: job.id },
      data: {
        status: exhausted ? "failed" : "pending",
        lastError: String(err.message).slice(0, 2000),
        runAfter: new Date(Date.now() + Math.min(60000 * 2 ** job.attempts, 3600000))
      }
    });
  }
}

async function main() {
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
