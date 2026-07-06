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

function createProvider() {
  if (config.provider === "faceplugin") {
    return createFacepluginProvider(config.faceplugin);
  }
  // default: server-side ONNX (no license/Docker)
  return createOnnxProvider({ modelsDir: config.onnx.modelsDir, matchThreshold: config.onnx.matchThreshold });
}

let deps = null;
function getDeps() {
  if (!deps) {
    deps = {
      db: getDb(),
      provider: createProvider(),
      evidenceKey: defaultEvidenceKey(config)
    };
    console.log(`verification provider: ${deps.provider.name}`);
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
  },
  retention_cleanup: async () => {
    const fs = require("fs/promises");
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
      try {
        await fs.unlink(file.storagePath);
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
      await db.evidenceFile.delete({ where: { id: file.id } });
    }
    if (expired.length) console.log(`retention_cleanup: removed ${expired.length} files`);
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

async function tick() {
  const db = getDb();
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

module.exports = { claimJob, HANDLERS };
