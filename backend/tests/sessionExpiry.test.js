"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMockDb } = require("./helpers/mockDb");
const { expireSessions, effectiveSessionStatus } = require("../src/services/sessionExpiry");

const now = new Date("2026-09-07T18:00:00Z");
async function seed(db, data = {}) {
  return db.verificationSession.create({ data: { tenantId: "tenant", sessionUid: "session", status: "started", attemptId: "attempt-one", expiresAt: new Date(now.getTime() - 1000), ...data } });
}

test("expiry is bounded, audited, idempotent and preserves previous results/evidence", async () => {
  const db = createMockDb();
  const first = await seed(db);
  await seed(db, { sessionUid: "second", status: "created" });
  await db.verificationResult.create({ data: { sessionId: first.id, attemptId: "older" } });
  await db.evidenceFile.create({ data: { sessionId: first.id, attemptId: "older" } });
  assert.equal(await expireSessions(db, { now, take: 1 }), 1);
  assert.equal(await expireSessions(db, { now }), 1);
  assert.equal(await expireSessions(db, { now }), 0);
  assert.equal(db.auditLog.rows.length, 2);
  assert.equal(db.auditLog.rows[0].metadata.attemptId, "attempt-one");
  assert.equal(first.status, "expired");
  assert.equal(first.completedAt, now);
  assert.equal(db.verificationResult.rows.length, 1);
  assert.equal(db.evidenceFile.rows.length, 1);
});

test("submitted, decided, unexpired and undated sessions are left untouched", async () => {
  const db = createMockDb();
  for (const status of ["submitted", "approved", "manual_review", "rejected"]) await seed(db, { status });
  await seed(db, { expiresAt: new Date(now.getTime() + 1000) });
  await seed(db, { expiresAt: undefined });
  assert.equal(await expireSessions(db, { now }), 0);
  assert.equal(effectiveSessionStatus({ status: "started", expiresAt: now }, now), "expired");
  assert.equal(effectiveSessionStatus({ status: "submitted", expiresAt: now }, now), "submitted");
});

test("submission, completion or renewal racing the sweep prevents expiration", async () => {
  for (const change of [{ status: "submitted" }, { status: "approved" }, { attemptId: "attempt-two" }, { expiresAt: new Date(now.getTime() + 1000) }]) {
    const db = createMockDb();
    const session = await seed(db);
    const original = db.$transaction;
    db.$transaction = async callback => {
      await db.verificationSession.updateMany({ where: { id: session.id }, data: change });
      return original(callback);
    };
    assert.equal(await expireSessions(db, { now }), 0);
    assert.notEqual(session.status, "expired");
    assert.equal(db.auditLog.rows.length, 0);
  }
});

test("an audit write failure rolls back the expiry transition", async () => {
  const db = createMockDb();
  await seed(db);
  db.auditLog.create = async () => { throw new Error("audit unavailable"); };
  await assert.rejects(expireSessions(db, { now }), /audit unavailable/);
  assert.equal(db.verificationSession.rows[0].status, "started");
});