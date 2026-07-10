"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createMockDb } = require("../../api/tests/helpers/mockDb");
const { failStuckSubmitted } = require("../src/watchdog");

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
