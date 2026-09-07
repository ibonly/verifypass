"use strict";

// G1 (audit remediation review 2026-09-07): the challenge clock must start
// when the user reaches the liveness step, not at session creation — the
// enforced issue→first-frame window (3 min) and the 10-min challenge TTL
// otherwise reject honest ID_AND_FACE users who capture a document first, or
// anyone who opens the hosted link late.

const test = require("node:test");
const assert = require("node:assert/strict");
const { setDb } = require("../src/lib/db");
const { createMockDb } = require("./helpers/mockDb");
const { createScope } = require("../src/middleware/tenantScope");
const { createSession, beginChallenge, submitSession } = require("../src/services/sessionService");
const { verifyLivenessChallenge, isChallengeFresh, SEQUENCE_LIMITS, DEFAULT_TTL_MS } = require("@verifypass/shared");

async function setup() {
  const db = createMockDb(); setDb(db);
  const tenant = await db.tenant.create({ data: { tenantUid: "tnt_begin", status: "active" } });
  const scope = createScope(db, tenant.id);
  const created = await createSession(scope, { verificationType: "ID_AND_FACE" }, false);
  const session = await scope.sessions.findByUid(created.sessionId);
  return { db, scope, created, session };
}

// Good two-turn burst: 3 distinct frames per action, opposite-signed yaw,
// starting near frontal, well inside the per-action window.
function goodFrames(firstAtMs) {
  const frames = []; let t = firstAtMs, i = 0;
  for (const action of ["turn_left", "turn_right"]) {
    for (const yaw of [0, 10, 20]) { frames.push({ action, checksum: `c${i++}`, createdAt: new Date(t), captureMode: "auto", liveness: { score: 0.95, faceCount: 1 }, pose: { yaw: action === "turn_left" ? -yaw : yaw, pitch: 0 } }); t += 400; }
    t += 1500;
  }
  return frames;
}

test("begin refreshes issuedAt when no frame exists, keeps the nonce, audits, and reports both clocks", async () => {
  const { db, scope, created, session } = await setup();
  const before = { ...session.livenessChallenge };
  // Session created 4 minutes ago (integrator created it, user opened late).
  session.livenessChallenge = { ...before, issuedAt: new Date(Date.now() - 4 * 60000).toISOString() };
  const out = await beginChallenge(scope, created.sessionId, created.sdkToken, { attemptId: created.attemptId });
  assert.equal(out.refreshed, true);
  const after = (await scope.sessions.findByUid(created.sessionId)).livenessChallenge;
  assert.equal(after.nonce, before.nonce, "nonce unchanged so document bindings survive");
  assert.deepEqual(after.actions, before.actions);
  assert.ok(Date.now() - new Date(after.issuedAt).getTime() < 5000);
  assert.equal(after.begunAt, after.issuedAt);
  assert.equal(db.auditLog.rows.filter(r => r.action === "challenge.begun").length, 1);
  assert.equal(new Date(out.challengeExpiresAt).getTime() - new Date(out.challengeIssuedAt).getTime(), DEFAULT_TTL_MS);
  assert.equal(new Date(out.firstFrameDeadline).getTime() - new Date(out.challengeIssuedAt).getTime(), SEQUENCE_LIMITS.maxIssueToFirstMs);
  assert.ok(out.sessionExpiresAt);
});

test("a slow document step no longer fails the sequence rule once begin is called", async () => {
  const { scope, created, session } = await setup();
  const createdAt = Date.now() - 4 * 60000;
  session.livenessChallenge = { ...session.livenessChallenge, actions: ["turn_left", "turn_right"], issuedAt: new Date(createdAt).toISOString() };
  const frames = goodFrames(Date.now() + 5000); // first frame 5s after begin, 4 min after creation
  // Without begin: the 3-minute issue→first-frame window rejects the session.
  const stale = verifyLivenessChallenge(session.livenessChallenge, frames, {}, { enforcePose: true, now: () => Date.now() + 10000 });
  assert.equal(stale.ok, false);
  assert.ok(stale.reasonCodes.includes("LIVENESS_CHALLENGE_SEQUENCE_INVALID"));
  await beginChallenge(scope, created.sessionId, created.sdkToken, { attemptId: created.attemptId });
  const fresh = (await scope.sessions.findByUid(created.sessionId)).livenessChallenge;
  const ok = verifyLivenessChallenge(fresh, frames, {}, { enforcePose: true, now: () => Date.now() + 10000 });
  assert.equal(ok.ok, true, JSON.stringify(ok.reasonCodes));
  assert.equal(ok.sequence.issueOk, true);
});

test("begin is a no-op once a frame exists for the current challenge (cannot extend a challenge with evidence)", async () => {
  const { db, scope, created, session } = await setup();
  const issuedAt = new Date(Date.now() - 60000).toISOString();
  session.livenessChallenge = { ...session.livenessChallenge, issuedAt };
  await db.evidenceFile.create({ data: { sessionId: session.id, attemptId: created.attemptId, fileType: "liveness_frame", label: session.livenessChallenge.actions[0], challengeNonce: session.livenessChallenge.nonce } });
  const out = await beginChallenge(scope, created.sessionId, created.sdkToken, { attemptId: created.attemptId });
  assert.equal(out.refreshed, false);
  assert.equal((await scope.sessions.findByUid(created.sessionId)).livenessChallenge.issuedAt, issuedAt);
  assert.equal(db.auditLog.rows.filter(r => r.action === "challenge.begun").length, 0);
});

test("begin is fenced like every other mutation: wrong attempt, wrong token, terminal status, no challenge", async () => {
  const { scope, created } = await setup();
  await assert.rejects(beginChallenge(scope, created.sessionId, created.sdkToken, { attemptId: "stale" }), /Attempt changed/);
  await assert.rejects(beginChallenge(scope, created.sessionId, created.sdkToken, {}), /attemptId is required/);
  await assert.rejects(beginChallenge(scope, created.sessionId, "sdk_bogus", { attemptId: created.attemptId }), /INVALID_API_KEY|invalid/i);
  // (the mock rolls back by replacing row objects, so mutate through the scope, not the stale reference)
  await scope.sessions.update(created.sessionId, { status: "submitted" });
  await assert.rejects(beginChallenge(scope, created.sessionId, created.sdkToken, { attemptId: created.attemptId }), /cannot begin/);
  await scope.sessions.update(created.sessionId, { status: "started", livenessChallenge: null });
  await assert.rejects(beginChallenge(scope, created.sessionId, created.sdkToken, { attemptId: created.attemptId }), /no liveness challenge/);
});

test("submit accepts a challenge that was begun within the TTL even though it was issued long before", async () => {
  const { db, scope, created, session } = await setup();
  session.status = "started"; session.consentAt = new Date();
  session.livenessChallenge = { ...session.livenessChallenge, issuedAt: new Date(Date.now() - 20 * 60000).toISOString() };
  assert.equal(isChallengeFresh(session.livenessChallenge), false);
  await assert.rejects(submitSession(scope, created.sessionId, created.sdkToken, created.attemptId, {}), /expired/i);
  await beginChallenge(scope, created.sessionId, created.sdkToken, { attemptId: created.attemptId });
  const r = await submitSession(scope, created.sessionId, created.sdkToken, created.attemptId, {});
  assert.equal(r.status, "submitted");
  assert.equal(db.outbox.rows.filter(x => x.type === "run_verification").length, 1);
});
