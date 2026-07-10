"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createMockDb } = require("./helpers/mockDb");
const { failStuckSubmitted, reclaimStaleJobs } = require("../src/worker/watchdog");

const MIN = 60 * 1000;

async function seed(db, { status = "submitted", ageMinutes = 60, uid = "vps_W1" } = {}) {
  const tenant = await db.tenant.create({ data: { tenantUid: `tnt_${uid}`, companyName: "W", status: "active" } });
  return db.verificationSession.create({
    data: {
      sessionUid: uid, tenantId: tenant.id, status,
      verificationType: "ID_AND_FACE", isLive: false,
      updatedAt: new Date(Date.now() - ageMinutes * MIN)
    }
  });
}

test("stuck submitted with NO queued job → failed with SESSION_TIMEOUT + webhook", async () => {
  const db = createMockDb();
  const s = await seed(db, { ageMinutes: 60 });

  const n = await failStuckSubmitted(db, { staleMinutes: 30 });
  assert.equal(n, 1);

  const after = await db.verificationSession.findFirst({ where: { id: s.id } });
  assert.equal(after.status, "failed");
  assert.deepEqual(after.decisionReason.reasonCodes, ["SESSION_TIMEOUT"]);
  assert.ok(after.completedAt, "terminal answer, not silence");

  const jobs = await db.jobQueue.findMany({ where: { type: "send_webhook" } });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].payload.event, "verification.failed");

  const audits = await db.auditLog.findMany({ where: { action: "session.timeout" } });
  assert.equal(audits.length, 1);
});

test("stuck submitted WITH a queued job → left alone (backlog, not death)", async () => {
  const db = createMockDb();
  const s = await seed(db, { ageMinutes: 60 });
  await db.jobQueue.create({
    data: { type: "run_verification", payload: { sessionUid: s.sessionUid }, status: "pending", runAfter: new Date(), maxAttempts: 5 }
  });

  const n = await failStuckSubmitted(db, { staleMinutes: 30 });
  assert.equal(n, 0);
  const after = await db.verificationSession.findFirst({ where: { id: s.id } });
  assert.equal(after.status, "submitted");
});

test("recently submitted sessions are not touched", async () => {
  const db = createMockDb();
  await seed(db, { ageMinutes: 5 });
  const n = await failStuckSubmitted(db, { staleMinutes: 30 });
  assert.equal(n, 0);
});

test("non-submitted statuses are never touched", async () => {
  const db = createMockDb();
  await seed(db, { status: "manual_review", ageMinutes: 600 });
  const n = await failStuckSubmitted(db, { staleMinutes: 30 });
  assert.equal(n, 0);
});

// --------------------------------------------------------------------------
// Stale running-job reclaim — the "stuck on submitted" root cause: a worker
// dying mid-job (dev restarts!) left the job in "running" forever; claimJob
// only takes "pending", and the old watchdog spared the session because an
// open job existed.
// --------------------------------------------------------------------------

async function seedJob(db, { status = "running", lockedAgeMin = 60, attempts = 1, maxAttempts = 5, uid = "vps_J1" } = {}) {
  return db.jobQueue.create({
    data: {
      type: "run_verification", payload: { sessionUid: uid },
      status, attempts, maxAttempts,
      runAfter: new Date(),
      lockedBy: "worker-dead",
      lockedAt: new Date(Date.now() - lockedAgeMin * MIN)
    }
  });
}

test("reclaim: stale running job → back to pending (session gets finalized)", async () => {
  const db = createMockDb();
  const job = await seedJob(db, { lockedAgeMin: 10 });
  const r = await reclaimStaleJobs(db);
  assert.equal(r.requeued, 1);
  const after = await db.jobQueue.findFirst({ where: { id: job.id } });
  assert.equal(after.status, "pending", "claimJob can pick it up again");
  assert.match(after.lastError, /stale lock reclaimed/);
});

test("reclaim: FRESH running job is left alone (worker still on it)", async () => {
  const db = createMockDb();
  const job = await seedJob(db, { lockedAgeMin: 1 });
  const r = await reclaimStaleJobs(db);
  assert.equal(r.requeued + r.failed, 0);
  assert.equal((await db.jobQueue.findFirst({ where: { id: job.id } })).status, "running");
});

test("reclaim: exhausted attempts → failed, not an infinite crash loop", async () => {
  const db = createMockDb();
  const job = await seedJob(db, { lockedAgeMin: 10, attempts: 5, maxAttempts: 5 });
  const r = await reclaimStaleJobs(db);
  assert.equal(r.failed, 1);
  assert.equal((await db.jobQueue.findFirst({ where: { id: job.id } })).status, "failed");
});

test("watchdog no longer shielded by a DEAD running job", async () => {
  const db = createMockDb();
  const s = await seed(db, { ageMinutes: 60 });
  await seedJob(db, { lockedAgeMin: 60, uid: s.sessionUid }); // orphaned lock for THIS session

  const n = await failStuckSubmitted(db, { staleMinutes: 30 });
  assert.equal(n, 1, "a dead lock must not keep the session in limbo");
  const after = await db.verificationSession.findFirst({ where: { id: s.id } });
  assert.equal(after.status, "failed");
});
