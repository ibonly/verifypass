"use strict";

// Stuck-session watchdog.
//
// A session enters "submitted" when the SDK calls /verify; the worker
// normally finalizes it within seconds. But if the worker process died
// mid-job, or the run_verification job exhausted its retries, the session
// would sit in "submitted" FOREVER — expire_sessions only covers
// created/started, and consumers polling waitForResult would never get a
// terminal answer.
//
// Rule: submitted for longer than staleMinutes AND no pending/running
// run_verification job for it → fail with SESSION_TIMEOUT and notify via
// webhook. If a job is still queued, it's backlog, not death — leave it.

// A job lock older than this is DEAD — the worker that claimed it crashed or
// was restarted mid-job (very common in dev). 5 min is far beyond any
// legitimate single-job runtime (provider timeout is 20s per call).
const STALE_LOCK_MS = 5 * 60 * 1000;

/**
 * Requeue jobs whose worker died mid-run. Without this, a job stuck in
 * "running" is NEVER picked up again (claimJob only takes "pending") — the
 * session behind it sits in "submitted" forever, and failStuckSubmitted
 * spares it because an "open" job appears to exist. Jobs that already used
 * all their attempts are marked failed instead of looping.
 * @returns {{requeued:number, failed:number}}
 */
async function reclaimStaleJobs(db, { staleMs = STALE_LOCK_MS, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - staleMs);
  const stale = await db.jobQueue.findMany({
    where: { status: "running", lockedAt: { lt: cutoff } },
    take: 200
  });
  let requeued = 0;
  let failed = 0;
  for (const job of stale) {
    const exhausted = (job.attempts || 0) >= (job.maxAttempts || 5);
    await db.jobQueue.updateMany({
      where: { id: job.id, status: "running" }, // optimistic — skip if a worker just finished it
      data: exhausted
        ? { status: "failed", lastError: "stale lock reclaimed — worker died mid-job (attempts exhausted)" }
        : { status: "pending", lockedBy: null, lockedAt: null, runAfter: now, lastError: "stale lock reclaimed — worker died mid-job" }
    });
    if (exhausted) failed++; else requeued++;
  }
  return { requeued, failed };
}

async function failStuckSubmitted(db, { staleMinutes = 30, now = new Date(), enqueueJob } = {}) {
  const dispatch = enqueueJob || ((type, jobPayload, opts = {}) =>
    db.jobQueue.create({ data: { type, payload: jobPayload, status: "pending", runAfter: opts.runAfter || now, maxAttempts: opts.maxAttempts || 5 } }));
  const cutoff = new Date(now.getTime() - staleMinutes * 60 * 1000);
  const stuck = await db.verificationSession.findMany({
    where: { status: "submitted", updatedAt: { lt: cutoff } },
    take: 200
  });
  if (!stuck.length) return 0;

  const openJobs = await db.jobQueue.findMany({
    where: { type: "run_verification", status: { in: ["pending", "running"] } }
  });
  // A "running" job with a dead lock is not alive — it must not shield its
  // session from the timeout (reclaimStaleJobs normally requeues it first,
  // but exhausted jobs go straight to failed and stop shielding here too).
  const lockCutoff = new Date(now.getTime() - STALE_LOCK_MS);
  const alive = openJobs.filter((j) =>
    j.status === "pending" || (j.lockedAt && new Date(j.lockedAt) >= lockCutoff));
  const queued = new Set(alive.map((j) => j.payload && j.payload.sessionUid).filter(Boolean));

  let failed = 0;
  for (const s of stuck) {
    if (queued.has(s.sessionUid)) continue; // job still queued — backlog, let it run

    // Optimistic status guard: never stomp a session a racing worker just finalized.
    const updated = await db.verificationSession.updateMany({
      where: { id: s.id, status: "submitted" },
      data: {
        status: "failed",
        riskLevel: "high",
        decisionReason: { reasonCodes: ["SESSION_TIMEOUT"] },
        completedAt: now
      }
    });
    if (!updated || updated.count === 0) continue;

    await db.auditLog.create({
      data: {
        tenantId: s.tenantId, sessionId: s.id, actorType: "system",
        action: "session.timeout",
        metadata: { staleMinutes, submittedAt: s.updatedAt },
        riskEvent: false
      }
    });
    await dispatch("send_webhook", {
      tenantId: String(s.tenantId), sessionUid: s.sessionUid, event: "verification.failed"
    });
    failed++;
  }
  return failed;
}

module.exports = { failStuckSubmitted, reclaimStaleJobs, STALE_LOCK_MS };
