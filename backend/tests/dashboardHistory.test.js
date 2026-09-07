"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const { createMockDb } = require("./helpers/mockDb");
const { setDb } = require("../src/lib/db");
const { signToken } = require("../src/services/authTokens");

async function fixture(context) {
  const db = createMockDb();
  setDb(db); context.after(() => setDb(null));
  const tenant = await db.tenant.create({ data: { tenantUid: "tenant", status: "active" } });
  const user = await db.user.create({ data: { tenantId: tenant.id, role: "tenant_admin", status: "active" } });
  const session = await db.verificationSession.create({ data: { tenantId: tenant.id, sessionUid: "session", status: "started", attemptId: "current", verificationType: "FACE_ONLY", expiresAt: new Date(Date.now() - 1000) } });
  const app = express();
  app.use("/dashboard", require("../src/routes/dashboard"));
  app.use(require("../src/middleware/errors").errorHandler);
  const get = url => request(app).get(`/dashboard${url}`).set("Authorization", `Bearer ${signToken({ userId: user.id, role: user.role })}`);
  return { db, session, get };
}

test("dashboard displays and filters overdue sessions without mutating them", async context => {
  const { db, session, get } = await fixture(context);
  assert.equal((await get("/sessions")).body.sessions[0].status, "expired");
  assert.equal((await get("/sessions?status=expired")).body.sessions.length, 1);
  assert.equal((await get("/sessions?status=started")).body.sessions.length, 0);
  assert.equal((await get("/stats")).body.byStatus.expired, 1);
  assert.equal((await get("/sessions/session")).body.decision.reasonCodes[0], "SESSION_EXPIRED");
  assert.equal(session.status, "started");
  assert.equal(db.auditLog.rows.length, 0);
});

test("current attempt and historical results never share unrelated evidence", async context => {
  const { db, session, get } = await fixture(context);
  const old = await db.evidenceFile.create({ data: { sessionId: session.id, attemptId: "previous", fileType: "selfie" } });
  const unused = await db.evidenceFile.create({ data: { sessionId: session.id, attemptId: "previous", fileType: "selfie" } });
  const current = await db.evidenceFile.create({ data: { sessionId: session.id, attemptId: "current", fileType: "liveness_frame" } });
  const result = await db.verificationResult.create({ data: { sessionId: session.id, attemptId: "previous", livenessScore: 0.59, rawResult: { consumedEvidenceIds: [old.id], decision: { status: "manual_review", reasonCodes: ["LIVENESS_BORDERLINE"] } } } });
  assert.equal((await get("/sessions/session")).body.liveness, null);
  const historical = await get(`/sessions/session?resultId=${result.id}`);
  assert.equal(historical.status, 200);
  assert.equal(historical.body.status, "manual_review");
  assert.equal(historical.body.currentStatus, "expired");
  assert.equal(historical.body.liveness.score, 0.59);
  const currentFiles = await get("/sessions/session/evidence");
  assert.deepEqual(currentFiles.body.evidence.map(file => file.evidenceId), [current.id]);
  const consumed = await get(`/sessions/session/evidence?resultId=${result.id}`);
  assert.equal(consumed.body.attribution, "consumed");
  assert.deepEqual(consumed.body.evidence.map(file => file.evidenceId), [old.id]);
  assert.ok(!consumed.body.evidence.some(file => file.evidenceId === unused.id));
  assert.equal((await get("/sessions/session/results")).body.results[0].resultId, result.id);
});

test("legacy results stay unbound and foreign results cannot be selected", async context => {
  const { db, session, get } = await fixture(context);
  const legacy = await db.verificationResult.create({ data: { sessionId: session.id, rawResult: {}, faceMatchStatus: "matched", faceMatchScore: null } });
  const foreign = await db.verificationResult.create({ data: { sessionId: "other-session", rawResult: {} } });
  const old = await db.evidenceFile.create({ data: { sessionId: session.id, fileType: "selfie" } });
  await db.evidenceFile.create({ data: { sessionId: session.id, attemptId: "current", fileType: "selfie" } });
  const detail = await get(`/sessions/session?resultId=${legacy.id}`);
  assert.equal(detail.body.legacyResult, true);
  assert.equal(detail.body.status, "unknown");
  const files = await get(`/sessions/session/evidence?resultId=${legacy.id}`);
  assert.equal(files.body.attribution, "legacy-unbound");
  assert.deepEqual(files.body.evidence.map(file => file.evidenceId), [old.id]);
  assert.equal((await get(`/sessions/session?resultId=${foreign.id}`)).status, 404);
  assert.equal((await get(`/sessions/session/evidence?resultId=${foreign.id}`)).status, 404);
  assert.equal((await get("/sessions/session?resultId=invalid")).status, 400);
  assert.equal((await get("/sessions/other/results")).status, 404);
});