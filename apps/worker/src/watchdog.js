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

async function failStuckSubmitted(db, { staleMinutes = 30, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - staleMinutes * 60 * 1000);
  const stuck = await db.verificationSession.findMany({
    where: { status: "submitted", updatedAt: { lt: cutoff } },
    take: 200
  });
  if (!stuck.length) return 0;

  const openJobs = await db.jobQueue.findMany({
    where: { type: "run_verification", status: { in: ["pending", "running"] } }
  });
  const queued = new Set(openJobs.map((j) => j.payload && j.payload.sessionUid).filter(Boolean));

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
    await db.jobQueue.create({
      data: {
        type: "send_webhook",
        payload: { tenantId: String(s.tenantId), sessionUid: s.sessionUid, event: "verification.failed" },
        status: "pending",
        runAfter: now,
        maxAttempts: 5
      }
    });
    failed++;
  }
  return failed;
}

module.exports = { failStuckSubmitted };
