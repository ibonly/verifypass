"use strict";
// Desired-behaviour regressions for L14, L15, L17, L19 (converted from the
// 2026-09-06 diagnostic reproductions). All DB/storage/queue writes are fake;
// image decoding uses sharp on a generated solid-colour JPEG, never a person.
process.env.NODE_ENV = "test";
process.env.REQUIRE_CONSENT = "false";
process.env.QUEUE_BACKEND = "db";
process.env.MAX_LIVENESS_FRAMES_PER_ACTION = "2";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createMockDb } = require("../../backend/tests/helpers/mockDb");
const { setDb } = require("../../backend/src/lib/db");
const { createScope } = require("../../backend/src/middleware/tenantScope");
const sessions = require("../../backend/src/services/sessionService");
const cloud = require("../../backend/src/services/cloudinaryService");
const store = require("../../backend/src/services/evidenceStore");
let writes = 0, deletes = 0;
cloud.uploadEvidenceImage = async () => null;
store.saveEvidence = async ({ onPrepared }) => { writes++; const storagePath = `fake-storage-${writes}`; await onPrepared?.(storagePath); return { checksum: `fake-checksum-${writes}`, storagePath, retentionExpiresAt: new Date() }; };
store.deleteEvidence = async () => { deletes++; };
const { handleUpload } = require("../../backend/src/services/uploadService");
const findings = [];
function barrier(n) { let arrived = 0, release; const wait = new Promise(r => { release = r; }); return async () => { if (++arrived === n) release(); await wait; }; }
async function fixture(status = "started") {
  const db = createMockDb(); setDb(db);
  const tenant = await db.tenant.create({ data: { tenantUid: "tnt_audit_races", status: "active", settings: {} } });
  const scope = createScope(db, tenant.id);
  const created = await sessions.createSession(scope, { verificationType: "FACE_ONLY" }, false);
  await scope.sessions.update(created.sessionId, { status, decisionReason: status === "rejected" ? { reasonCodes: ["LIVENESS_FAILED"] } : null });
  return { db, tenant, scope, created, session: () => scope.sessions.findByUid(created.sessionId) };
}
(async () => {
  // L15: audit failure aborts the retry instead of being swallowed; the counter is durable and fenced.
  let f = await fixture("rejected");
  const originalAudit = f.db.auditLog.create;
  f.db.auditLog.create = async () => { throw new Error("simulated audit failure"); };
  await assert.rejects(sessions.retrySession(f.scope, f.created.sessionId, f.created.sdkToken, { tenantId: f.tenant.id, attemptId: f.created.attemptId }), /simulated audit failure/);
  assert.equal((await f.session()).status, "rejected"); assert.equal((await f.session()).attemptNumber, 1);
  f.db.auditLog.create = originalAudit;
  let attempt = f.created.attemptId, ok = 0;
  for (let i = 0; i < 7; i++) {
    await f.scope.sessions.update(f.created.sessionId, { status: "rejected" });
    try { const r = await sessions.retrySession(f.scope, f.created.sessionId, f.created.sdkToken, { tenantId: f.tenant.id, attemptId: attempt }); attempt = r.attemptId; ok++; }
    catch (e) { assert.equal(e.code, "RETRY_LIMIT_REACHED"); }
  }
  assert.equal(ok, sessions.RETRY_MAX_ATTEMPTS - 1);
  findings.push({ id: "L15", evidence: `Audit failure rolls back the retry; exactly ${ok} retries succeed under the ${sessions.RETRY_MAX_ATTEMPTS}-attempt cap.` });
  f = await fixture();
  const before = await f.session();
  // Reissues run inside serialized transactions (real: write conflicts / P2034 retry; mock: a queue), so concurrency reduces to attempt fencing.
  const reissues = await Promise.allSettled(Array.from({ length: 3 }, () => sessions.reissueChallenge(f.scope, f.created.sessionId, f.created.sdkToken, { tenantId: f.tenant.id, attemptId: f.created.attemptId, excludeActions: [before.livenessChallenge.actions[0]] })));
  assert.equal(reissues.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((await f.session()).reissueCount, 1);
  findings.push({ id: "L15", evidence: "Three synchronized reissues: exactly one succeeds; the others are fenced by the attempt change." });
  // L19: concurrent uploads reserve slots; the losing file is deleted; no staging row lingers.
  f = await fixture(); writes = 0; deletes = 0;
  const sharp = require("../../backend/node_modules/sharp");
  const jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 100, g: 110, b: 120 } } }).jpeg().toBuffer();
  const cur = await f.session();
  const upload = () => handleUpload({ scopedDb: f.scope, tenantUid: f.tenant.tenantUid, sessionUid: f.created.sessionId, sdkToken: f.created.sdkToken, attemptId: cur.attemptId, kind: "liveness", action: cur.livenessChallenge.actions[0], captureMode: "auto", imageBase64: jpeg.toString("base64") });
  // Gate only the PRE-transaction budget read so all three uploads see budget remaining; the commit transaction re-counts.
  const quotaGate = barrier(3); const origList = f.scope.evidence.listForSession;
  f.scope.evidence.listForSession = async (...a) => { const rows = await origList(...a); await quotaGate(); return rows; };
  const accepted = await Promise.allSettled([upload(), upload(), upload()]);
  assert.equal(accepted.filter(r => r.status === "fulfilled").length, 2);
  assert.equal(f.db.evidenceFile.rows.length, 2); assert.equal(deletes, 1); assert.equal(f.db.evidenceStaging.rows.length, 0);
  findings.push({ id: "L19", evidence: "Three simultaneous uploads with a per-action cap of 2: two persist, the loser's file is deleted and its staging row removed." });
  f.scope.evidence.listForSession = origList;
  f = await fixture(); // fresh session: the previous one has spent its per-action budget
  const cur2 = await f.session();
  const upload2 = () => handleUpload({ scopedDb: f.scope, tenantUid: f.tenant.tenantUid, sessionUid: f.created.sessionId, sdkToken: f.created.sdkToken, attemptId: cur2.attemptId, kind: "liveness", action: cur2.livenessChallenge.actions[0], captureMode: "auto", imageBase64: jpeg.toString("base64") });
  f.db.evidenceFile.create = async () => { throw new Error("simulated evidence row failure"); };
  writes = 0; deletes = 0;
  await assert.rejects(upload2(), /simulated evidence row/);
  assert.equal(writes, 1); assert.equal(deletes, 1); assert.equal(f.db.evidenceStaging.rows.length, 0);
  findings.push({ id: "L19", evidence: "Evidence row failure after storage acceptance triggers compensation: the stored object is deleted." });
  // L14 / L17 over real Express routing against the fake DB and queue.
  let enqueueFails = true;
  require("../../backend/src/services/jobService").enqueue = async () => { if (enqueueFails) throw new Error("simulated queue outage"); return { id: "fake-job" }; };
  const express = require("../../backend/node_modules/express");
  const request = require("../../backend/node_modules/supertest");
  const app = express(); app.use(express.json()); app.use("/v1/verification-sessions", require("../../backend/src/routes/captures"));
  app.use((error, req, res, next) => res.status(error.http || 500).json({ code: error.code || "INTERNAL_ERROR" }));
  f = await fixture();
  const post = (fx, route, body = {}) => request(app).post(`/v1/verification-sessions/${fx.created.sessionId}/${route}`).set("X-VP-SDK-Token", fx.created.sdkToken).send({ sdkToken: fx.created.sdkToken, attemptId: fx.created.attemptId, ...body });
  let response = await post(f, "verify");
  assert.equal(response.status, 202); assert.equal((await f.session()).status, "submitted"); assert.equal(f.db.jobQueue.rows.length, 0);
  assert.equal(f.db.outbox.rows.filter(r => r.type === "run_verification" && r.status === "pending").length, 1);
  response = await post(f, "verify");
  assert.equal(response.status, 202);
  findings.push({ id: "L14", evidence: "Queue outage: submit returns 202 with a pending outbox record; a duplicate submit is idempotent (202, still one record)." });
  enqueueFails = false;
  f = await fixture(); await f.scope.sessions.update(f.created.sessionId, { expiresAt: new Date(Date.now() - 60000) });
  response = await post(f, "verify");
  assert.equal(response.status, 410); assert.equal((await f.session()).status, "started");
  findings.push({ id: "L17", evidence: "Submit on an expired session returns 410 SESSION_EXPIRED and leaves the session untouched." });
  // G1 (review 2026-09-07): the challenge clock starts at /challenge/begin.
  f = await fixture();
  const stale = await f.session();
  await f.scope.sessions.update(f.created.sessionId, { livenessChallenge: { ...stale.livenessChallenge, issuedAt: new Date(Date.now() - 20 * 60000).toISOString() } });
  response = await post(f, "verify");
  assert.equal(response.status, 410);
  response = await post(f, "challenge/begin");
  assert.equal(response.status, 200); assert.equal(response.body.refreshed, true); assert.ok(response.body.firstFrameDeadline);
  response = await post(f, "verify");
  assert.equal(response.status, 202);
  findings.push({ id: "G1", evidence: "A challenge issued 20 minutes ago is refused at submit until /challenge/begin restarts the clock; submit then succeeds." });
  setDb(null);
  const results = { date: new Date().toISOString(), mode: "desired-behaviour regressions", proofs: findings.length, findings };
  await fs.writeFile(path.join(__dirname, "concurrency-results.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify(results, null, 2));
})().catch(e => { setDb(null); console.error(e); process.exitCode = 1; });
