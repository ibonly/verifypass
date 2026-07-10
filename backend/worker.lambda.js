"use strict";

// AWS Lambda entry for the verification worker (serverless topology).
//
// Supports BOTH queue backends:
//
//   QUEUE_BACKEND=db (recommended, the deployed configuration):
//     The job_queue TABLE stays the source of truth — same rows, same retry
//     semantics, same dashboards as the polling worker. Instead of polling,
//     the function is invoked with {type:"drain"} and processes pending rows
//     in a bounded loop:
//       - EventBridge fires drain every minute (baseline latency ≤ ~60s)
//       - the API async-invokes drain right after each enqueue (the "kick"),
//         so verifications normally start within seconds
//     Drains are IDEMPOTENT and safe to overlap: claiming is the same
//     optimistic pending→running update the polling worker uses, and
//     reclaimStaleJobs runs first so a Lambda killed mid-drain never strands
//     a job in "running".
//
//   QUEUE_BACKEND=sqs (alternative):
//     SQS triggers with {Records:[...]}; partial-batch failures via
//     batchItemFailures; `notBefore` delay ladder for long webhook retries.
//
// EventBridge also invokes the crons directly: {type:"expire_sessions"}
// (includes the stuck-submitted watchdog) and {type:"retention_cleanup"}.
//
// Sizing: memorySize >= 2048 (CPU scales with memory on Lambda; ONNX
// inference needs it), timeout >= 120s.

require("./src/env");

const config = require("./src/worker/config");
const { defaultEvidenceKey, runVerification } = require("./src/worker/pipeline");
const { sendWebhook } = require("./src/worker/webhookDispatcher");
const { failStuckSubmitted, reclaimStaleJobs } = require("./src/worker/watchdog");

// ---------------------------------------------------------------------------
// Warm state — survives between invocations on a warm container, so ONNX
// sessions / the tesseract worker load once per container, not per job.
// ---------------------------------------------------------------------------
let prisma = null;
function getDb() {
  if (!prisma) {
    const { PrismaClient } = require("@prisma/client");
    prisma = new PrismaClient();
  }
  return prisma;
}

let providerInstance = null;
function getProvider() {
  if (!providerInstance) {
    // reuse the exact provider wiring (incl. the OCR resolution chain)
    const { createProviderForLambda } = require("./worker.js");
    providerInstance = createProviderForLambda();
  }
  return providerInstance;
}

// SQS-backed follow-up dispatch: jobs created BY jobs (webhooks, retries)
// must land back on the queue that actually has a consumer.
async function sqsEnqueue(type, payload, opts = {}) {
  const { enqueue } = require("./src/services/jobService");
  return enqueue(type, payload, opts);
}

function buildDeps() {
  const sqsMode = (process.env.QUEUE_BACKEND || "db").toLowerCase() === "sqs";
  return {
    db: getDb(),
    provider: getProvider(),
    evidenceKey: defaultEvidenceKey(config),
    env: config.env,
    modelVersion: config.modelVersion,
    // db mode: leave undefined → pipeline/dispatcher/watchdog fall back to
    // job_queue rows, which the SAME drain loop then processes (a webhook
    // enqueued by a verification goes out within the same invocation).
    ...(sqsMode ? { enqueueJob: sqsEnqueue } : {})
  };
}

// ---------------------------------------------------------------------------
// db-queue drain: claim → execute → complete, exactly the polling worker's
// tick semantics (optimistic claim, retry backoff, maxAttempts), but in a
// bounded loop that exits well before the function timeout.
// ---------------------------------------------------------------------------
async function drainDbQueue(deps, { maxJobs = 25, budgetMs = 90_000, now = Date.now } = {}) {
  const db = deps.db;
  const { reclaimStaleJobs } = require("./src/worker/watchdog");

  // Same optimistic claim the polling worker uses (inlined — requiring
  // ./index would load the ONNX provider at import time).
  async function claim() {
    const candidate = await db.jobQueue.findFirst({
      where: { status: "pending", runAfter: { lte: new Date(now()) } },
      orderBy: { id: "asc" }
    });
    if (!candidate) return null;
    const claimed = await db.jobQueue.updateMany({
      where: { id: candidate.id, status: "pending" },
      data: { status: "running", lockedBy: "lambda-drain", lockedAt: new Date(now()), attempts: { increment: 1 } }
    });
    return claimed.count === 1 ? candidate : null;
  }

  // a Lambda killed mid-drain leaves rows in "running" — requeue them first
  await reclaimStaleJobs(db).catch(() => {});

  const started = now();
  let processed = 0;
  let failed = 0;
  while (processed + failed < maxJobs && now() - started < budgetMs) {
    const job = await claim();
    if (!job) break; // queue drained
    try {
      await runJob({ type: job.type, payload: job.payload }, deps);
      await db.jobQueue.update({ where: { id: job.id }, data: { status: "done" } });
      processed++;
    } catch (err) {
      const exhausted = job.attempts + 1 >= job.maxAttempts;
      await db.jobQueue.update({
        where: { id: job.id },
        data: {
          status: exhausted ? "failed" : "pending",
          lastError: String(err.message).slice(0, 2000),
          runAfter: new Date(now() + Math.min(60000 * 2 ** job.attempts, 3600000))
        }
      });
      failed++;
    }
  }
  return { processed, failed };
}

// ---------------------------------------------------------------------------
// Job execution (shared by drain, SQS and direct invokes)
// ---------------------------------------------------------------------------
async function runJob(job, deps) {
  switch (job.type) {
    case "drain":
      return drainDbQueue(deps, job.payload || {});
    case "run_verification":
      return runVerification(job.payload, deps);
    case "send_webhook":
      return sendWebhook(job.payload, { db: deps.db, enqueueJob: deps.enqueueJob });
    case "expire_sessions": {
      await deps.db.verificationSession.updateMany({
        where: { status: { in: ["created", "started"] }, expiresAt: { lt: new Date() } },
        data: { status: "expired" }
      });
      // dead-letter safety net: sessions whose SQS message was lost/exhausted
      const timedOut = await failStuckSubmitted(deps.db, { enqueueJob: deps.enqueueJob });
      // harmless in SQS topology, but sweeps any legacy db-queue rows
      await reclaimStaleJobs(deps.db).catch(() => {});
      return { timedOut };
    }
    case "retention_cleanup": {
      const { storage } = require("@verifypass/shared");
      const { capFailedSessionRetention } = require("./src/worker/retention");
      await capFailedSessionRetention(deps.db);
      const expired = await deps.db.evidenceFile.findMany({
        where: { retentionExpiresAt: { lt: new Date() } }, take: 500
      });
      for (const file of expired) {
        await storage.removeStored(file.storagePath);
        await deps.db.evidenceFile.delete({ where: { id: file.id } });
      }
      try {
        if (deps.db.rateLimitCounter) {
          await deps.db.rateLimitCounter.deleteMany({ where: { windowEndsAt: { lt: new Date(Date.now() - 3600_000) } } });
        }
      } catch { /* mock dbs without the model */ }
      return { removed: expired.length };
    }
    default:
      throw new Error(`Unknown job type: ${job.type}`);
  }
}

/**
 * Build the handler with injectable deps/executor (unit tests use fakes).
 */
function buildHandler({ deps, execute, enqueue, now = Date.now } = {}) {
  return async function handler(event) {
    // deps are only materialized when no executor was injected — tests pass
    // a fake `execute` and must not touch Prisma/AWS at all
    const exec = execute || ((job) => runJob(job, deps || buildDeps()));
    const requeue = enqueue || sqsEnqueue;

    // Direct invoke (EventBridge Scheduler crons)
    if (!event || !Array.isArray(event.Records)) {
      const job = { type: event?.type, payload: event?.payload || {} };
      const result = await exec(job);
      return { ok: true, result };
    }

    // SQS batch — report per-message failures so only failed jobs redeliver
    const batchItemFailures = [];
    for (const record of event.Records) {
      try {
        const job = JSON.parse(record.body);

        // Delay ladder: not due yet → re-enqueue the next hop and ack this one
        if (job.notBefore && new Date(job.notBefore).getTime() > now()) {
          await requeue(job.type, job.payload, {
            runAfter: new Date(job.notBefore),
            maxAttempts: job.maxAttempts
          });
          continue;
        }

        await exec(job);
      } catch (err) {
        console.error("JOB_FAILED", {
          messageId: record.messageId,
          err: err && err.message
        });
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}

module.exports = { handler: buildHandler(), buildHandler, runJob, drainDbQueue };
