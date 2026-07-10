"use strict";

// Retry flow: reopen rejected/review/failed sessions, audit-logged attempt
// counter, hard cap, manual-upload suggestion after 3 camera attempts.

const test = require("node:test");
const assert = require("node:assert/strict");

const { setDb } = require("../src/lib/db");
const { createMockDb } = require("./helpers/mockDb");
const { tenantScope } = require("../src/middleware/tenantScope");
const {
  createSession, retrySession, RETRY_MAX_ATTEMPTS, RETRY_MANUAL_UPLOAD_AFTER
} = require("../src/services/sessionService");

function scopeFor(tenant) {
  const req = { tenant };
  tenantScope(req, {}, () => {});
  return req.scopedDb;
}

async function setup({ type = "ID_AND_FACE", status = "rejected" } = {}) {
  const db = createMockDb();
  setDb(db); // audit() writes through the global db
  const tenant = await db.tenant.create({ data: { tenantUid: "tnt_rt", companyName: "R", status: "active" } });
  const scope = scopeFor(tenant);
  const created = await createSession(scope, { customerReference: "C1", verificationType: type }, false);
  await scope.sessions.update(created.sessionId, {
    status,
    decisionReason: { reasonCodes: ["LIVENESS_FAILED"] },
    completedAt: new Date()
  });
  return { db, tenant, scope, created };
}

test("retry reopens a rejected session: started, fresh challenge, audit-logged", async () => {
  const { db, tenant, scope, created } = await setup();
  // capture the VALUE — the mock db returns live row references
  const nonceBefore = (await scope.sessions.findByUid(created.sessionId)).livenessChallenge.nonce;

  const r = await retrySession(scope, created.sessionId, created.sdkToken, { tenantId: tenant.id });
  assert.equal(r.status, "started");
  assert.equal(r.attempts, 2);
  assert.equal(r.maxAttempts, RETRY_MAX_ATTEMPTS);
  assert.equal(r.manualUploadSuggested, false, "attempt 2 is still a camera attempt");
  assert.ok(Array.isArray(r.livenessChallenge.actions) && r.livenessChallenge.actions.length > 0);

  const after = await scope.sessions.findByUid(created.sessionId);
  assert.equal(after.status, "started");
  assert.equal(after.completedAt, null);
  assert.notEqual(after.livenessChallenge.nonce, nonceBefore, "challenge must be REISSUED");

  const logs = await db.auditLog.findMany({ where: { action: "session.retry" } });
  assert.equal(logs.length, 1, "every retry is logged");
  assert.equal(logs[0].metadata.previousStatus, "rejected");
  assert.deepEqual(logs[0].metadata.previousReasonCodes, ["LIVENESS_FAILED"]);
});

test("manual_review and failed sessions are retryable; active ones are not", async () => {
  for (const status of ["manual_review", "failed"]) {
    const { tenant, scope, created } = await setup({ status });
    const r = await retrySession(scope, created.sessionId, created.sdkToken, { tenantId: tenant.id });
    assert.equal(r.status, "started", `${status} must be retryable`);
  }
  const { tenant, scope, created } = await setup({ status: "started" });
  await assert.rejects(
    () => retrySession(scope, created.sessionId, created.sdkToken, { tenantId: tenant.id }),
    /cannot retry/
  );
});

test("wrong SDK token → INVALID_API_KEY (retry is holder-only)", async () => {
  const { tenant, scope, created } = await setup();
  await assert.rejects(
    () => retrySession(scope, created.sessionId, "sdk_v1_forged", { tenantId: tenant.id }),
    (err) => err.code === "INVALID_API_KEY"
  );
});

test("manual upload suggested AFTER 3 camera attempts; cap at 5 total", async () => {
  const { tenant, scope, created } = await setup();

  const again = async () => {
    // each retry ends rejected again → user tries once more
    const r = await retrySession(scope, created.sessionId, created.sdkToken, { tenantId: tenant.id });
    await scope.sessions.update(created.sessionId, { status: "rejected" });
    return r;
  };

  const r2 = await again(); // attempt 2
  const r3 = await again(); // attempt 3
  const r4 = await again(); // attempt 4 — camera attempts exhausted
  assert.equal(r2.manualUploadSuggested, false);
  assert.equal(r3.manualUploadSuggested, false);
  assert.equal(r4.manualUploadSuggested, true, `attempt 4 > ${RETRY_MANUAL_UPLOAD_AFTER} camera attempts → offer file upload`);

  const r5 = await again(); // attempt 5 — the last one
  assert.equal(r5.attempts, RETRY_MAX_ATTEMPTS);
  assert.equal(r5.attemptsRemaining, 0);

  await assert.rejects(
    () => retrySession(scope, created.sessionId, created.sdkToken, { tenantId: tenant.id }),
    (err) => err.code === "RETRY_LIMIT_REACHED"
  );
});

test("ID_ONLY retry reissues NO challenge (that flow has no liveness step)", async () => {
  const { tenant, scope, created } = await setup({ type: "ID_ONLY" });
  const r = await retrySession(scope, created.sessionId, created.sdkToken, { tenantId: tenant.id });
  assert.equal(r.livenessChallenge, null);
  const after = await scope.sessions.findByUid(created.sessionId);
  assert.equal(after.livenessChallenge, null);
});

test("cross-tenant session is invisible to retry (404, never 403)", async () => {
  const { db, created } = await setup();
  const other = await db.tenant.create({ data: { tenantUid: "tnt_other", companyName: "O", status: "active" } });
  const otherScope = scopeFor(other);
  await assert.rejects(
    () => retrySession(otherScope, created.sessionId, created.sdkToken, { tenantId: other.id }),
    (err) => err.code === "SESSION_NOT_FOUND"
  );
});
