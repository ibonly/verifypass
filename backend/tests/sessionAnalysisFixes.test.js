"use strict";

// Regressions for the 2026-09-07 session-analysis fixes: identity continuity
// on the best frontal frame, per-action window measured from the burst,
// direction consistency reviewed (not rejected) by default, frontal-only
// passive median, and the policy-version skew guard.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
// STRICT = the liveness auto-approve rule switched off (tenant knobs). The
// contracts below describe how each signal routes when nothing waives it;
// the default rule (score > autoApprove OR challenge passed → waive liveness
// quality codes) is covered by its own tests.
const STRICT = { thresholds: { liveness: { autoApprove: 1, challengePassApproves: false } } };
const STRICT_T = require("@verifypass/shared").resolveThresholds(STRICT);
const path = require("path");
const { encryptBuffer, computeFrameBinding, verifyLivenessChallenge, assessSequence, assessTrajectory, decide } = require("@verifypass/shared");
const { createMockDb } = require("./helpers/mockDb");
const { runVerification, PIPELINE_VERSION } = require("../src/worker/pipeline");
const config = require("../src/config");

const KEY = crypto.randomBytes(32);
const NOW = Date.now();

// Provider driven by the JSON we store as the "image": pose, passive score and
// an identity similarity the selfie comparison should report for the frame.
function provider() {
  return {
    name: "stub",
    checkLiveness: async buf => { let d = {}; try { d = JSON.parse(buf.toString()); } catch (_) {} return { score: d.score ?? 0.95, faceCount: 1, occluded: false, pose: d.pose || null, faceRatio: d.faceRatio ?? 0.5, raw: { box: { x1: 0, y1: 0, x2: 400, y2: 400 } } }; },
    faceEmbedding: async buf => { let d = {}; try { d = JSON.parse(buf.toString()); } catch (_) {} return { sim: d.sim ?? 1 }; },
    compareEmbeddings: (a, b) => (a.sim === undefined ? b.sim : Math.min(a.sim, b.sim)),
    compareFaces: async () => ({ score: 0.9, idFaceFound: true, raw: {} }),
    extractDocument: async () => ({ available: true, ocrConfidence: 0.9, extractedData: {}, expired: false, raw: {} })
  };
}

async function seed({ actions = ["turn_left", "turn_right"], frames, selfie = { score: 0.95, pose: { yaw: 0, pitch: 0 } }, settings = {}, attemptId = "att-1" }) {
  const db = createMockDb();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vp-fix-"));
  const tenant = await db.tenant.create({ data: { tenantUid: "tnt_fix", status: "active", settings } });
  const session = await db.verificationSession.create({ data: { tenantId: tenant.id, sessionUid: "vps_fix", status: "submitted", verificationType: "FACE_ONLY", isLive: false, attemptId, submittedAt: new Date(NOW + 60000), livenessChallenge: { actions, nonce: "n", issuedAt: new Date(NOW).toISOString() } } });
  let n = 0;
  async function add(fileType, label, plainObj, createdAt) {
    const plain = Buffer.from(JSON.stringify({ ...plainObj, n: ++n }));
    const checksum = crypto.createHash("sha256").update(plain).digest("hex");
    const storagePath = path.join(dir, `${n}.enc`);
    await fs.writeFile(storagePath, encryptBuffer(plain, KEY));
    const mode = fileType === "liveness_frame" ? "auto" : null;
    await db.evidenceFile.create({ data: { sessionId: session.id, fileType, label, attemptId, challengeNonce: "n", captureMode: mode, storagePath, checksum, encrypted: true, createdAt, bindingHmac: computeFrameBinding(config.sdkTokenSecret, "n", label || fileType, checksum, [session.tenantId, session.id, attemptId, fileType, mode, null]) } });
  }
  await add("selfie", null, selfie, new Date(NOW + 1000));
  for (const f of frames) await add("liveness_frame", f.action, f.plain, new Date(NOW + f.atMs));
  const run = (env = "test") => runVerification({ sessionUid: "vps_fix", attemptId, policyVersion: PIPELINE_VERSION }, { db, provider: provider(), evidenceKey: KEY, env, screen: async () => ({ hit: false }) });
  return { db, session, run, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

// A genuine burst: frontal early frame, then three turned frames within a second.
function turns({ leftSim = 0.9, rightSim = 0.9, turnedSim = 0.2, startMs = 5000, gapMs = 400 } = {}) {
  const out = []; let t = startMs;
  for (const [action, sign, sim] of [["turn_left", -1, leftSim], ["turn_right", 1, rightSim]]) {
    out.push({ action, atMs: t, plain: { pose: { yaw: sign * 5, pitch: 0 }, sim } }); t += gapMs;
    for (const yaw of [12, 22, 30]) { out.push({ action, atMs: t, plain: { pose: { yaw: sign * yaw, pitch: 0 }, sim: turnedSim, score: 0.4 } }); t += gapMs; }
    t += 1500;
  }
  return out;
}

test("production approval requires a receipt bound to the effective release", async t => {
  const { resolveThresholds } = require("@verifypass/shared");
  const { validationFingerprint } = require("../src/lib/livenessValidation");
  const previous = process.env.LIVENESS_VALIDATION_RECEIPTS;
  t.after(() => { if (previous === undefined) delete process.env.LIVENESS_VALIDATION_RECEIPTS; else process.env.LIVENESS_VALIDATION_RECEIPTS = previous; });
  delete process.env.LIVENESS_VALIDATION_RECEIPTS;
  const unvalidated = await seed({ frames: turns() }); t.after(unvalidated.cleanup);
  const denied = await unvalidated.run("production");
  assert.notEqual(denied.status, "approved");
  assert.ok(denied.reasonCodes.includes("LIVENESS_POLICY_UNVERIFIED"));
  const fingerprint = validationFingerprint({ settings: {}, thresholds: resolveThresholds({}, "stub"), provider: "stub" });
  process.env.LIVENESS_VALIDATION_RECEIPTS = JSON.stringify([{ fingerprint, dataset: "labelled-test-fixture", evaluation: "test-only" }]);
  const validated = await seed({ frames: turns() }); t.after(validated.cleanup);
  assert.equal((await validated.run("production")).status, "approved");
  assert.equal(validated.db.verificationResult.rows[0].rawResult.policy.fingerprint, fingerprint);
});

test("identity continuity: a low similarity on a turned frame no longer rejects when a frontal frame matches", async t => {
  const fx = await seed({ frames: turns({ turnedSim: 0.15 }) }); t.after(fx.cleanup);
  const out = await fx.run();
  assert.equal(out.status, "approved", JSON.stringify(out.reasonCodes));
  const id = fx.db.verificationResult.rows[0].rawResult.livenessIdentity;
  assert.equal(id.aggregation, "best-frontal");
  assert.equal(id.score, 0.9);
  assert.equal(id.frames, 4, "only the frontal frames (5° and 12°) qualify; 22° and 30° do not");
  assert.equal(id.considered, 8);
  const raw = fx.db.verificationResult.rows[0].rawResult;
  assert.equal(raw.decision.status, "approved");
  assert.deepEqual(new Set(raw.consumedEvidenceIds), new Set(fx.db.evidenceFile.rows.map(file => file.id)));
});

test("identity continuity: a frontal frame that does NOT match still rejects; no frontal frame → review", async t => {
  const bad = await seed({ frames: turns({ leftSim: 0.1, rightSim: 0.12 }) }); t.after(bad.cleanup);
  const out = await bad.run();
  assert.equal(out.status, "rejected"); assert.ok(out.reasonCodes.includes("LIVENESS_IDENTITY_MISMATCH"));
  const noFrontal = await seed({ frames: turns().map(f => ({ ...f, plain: { ...f.plain, pose: { yaw: f.plain.pose.yaw < 0 ? -30 : 30, pitch: 0 } } })) }); t.after(noFrontal.cleanup);
  const out2 = await noFrontal.run();
  assert.notEqual(out2.status, "approved");
  assert.ok(out2.reasonCodes.includes("LIVENESS_IDENTITY_UNAVAILABLE"), JSON.stringify(out2.reasonCodes));
});

test("identity continuity: a small face (< 60% of the selfie face) does not qualify", async t => {
  const frames = turns({ turnedSim: 0.9 }).map(f => ({ ...f, plain: { ...f.plain, faceRatio: 0.1 } }));
  const fx = await seed({ frames, selfie: { score: 0.95, pose: { yaw: 0, pitch: 0 }, faceRatio: 0.5 } }); t.after(fx.cleanup);
  const out = await fx.run();
  assert.ok(out.reasonCodes.includes("LIVENESS_IDENTITY_UNAVAILABLE"), JSON.stringify(out.reasonCodes));
});

test("passive aggregate is recorded from frontal frames only and never moves the decision score", async t => {
  const frames = turns().map(f => ({ ...f, plain: { ...f.plain, score: Math.abs(f.plain.pose.yaw) > 15 ? 0.45 : 0.30 } }));
  const fx = await seed({ frames, selfie: { score: 0.94, pose: { yaw: 0, pitch: 0 } } }); t.after(fx.cleanup);
  const out = await fx.run();
  assert.equal(out.status, "approved", JSON.stringify(out.reasonCodes));
  const lv = fx.db.verificationResult.rows[0].rawResult.liveness;
  assert.deepEqual(lv.passiveAggregate.frameScores, [0.3, 0.3, 0.3], "only frontal frames (≤15°) are aggregated, three at most");
  assert.equal(lv.decisionScore, 0.94, "low frontal frames are recorded, not decisive");
  assert.equal(fx.db.verificationResult.rows[0].livenessScore, 0.94);
});

test("tilt frames under the spoof floor count for pose when the action has a live frontal frame; turns need parallax", () => {
  const f = (action, yaw, pitch, score, i, points = null) => ({ action, checksum: `${action}${i}`, captureMode: "auto", createdAt: new Date(NOW + 5000 + i * 300), liveness: { score, faceCount: 1 }, pose: { yaw, pitch }, points });
  const opts = { enforcePose: true, selfieScore: 0.95, now: () => NOW + 60000 };
  // look_up: frontal early frame scores 0.95, the chin-up frames ≤ 0.05 (what the passive model does on real faces)
  const lookUp = { actions: ["look_up"], nonce: "n", issuedAt: new Date(NOW).toISOString() };
  const r = verifyLivenessChallenge(lookUp, [f("look_up", 0, 2, 0.95, 0), f("look_up", 0, -25, 0.03, 1), f("look_up", 0, -38, 0.02, 2), f("look_up", 0, -40, 0.05, 3)], {}, opts);
  assert.equal(r.perAction.look_up.poseOk, true, JSON.stringify(r.perAction.look_up));
  assert.equal(r.ok, true, JSON.stringify(r.reasonCodes));
  // no live frame at all in the action → still fails at the floor
  const dead = verifyLivenessChallenge(lookUp, [f("look_up", 0, 2, 0.04, 0), f("look_up", 0, -25, 0.03, 1), f("look_up", 0, -38, 0.02, 2), f("look_up", 0, -40, 0.05, 3)], {}, opts);
  assert.equal(dead.ok, false); assert.ok(dead.reasonCodes.includes("LIVENESS_CHALLENGE_FAILED"));
  assert.equal(dead.perAction.look_up.failureStage, "passive_floor");
  assert.equal(dead.perAction.look_up.poseChecked, false);
  assert.equal(typeof dead.perAction.look_up.passiveFloor, "number");
  // turn_left: a frontal live frame cannot vouch for near-zero turned frames unless landmarks prove parallax (audit L04)
  const turn = { actions: ["turn_left"], nonce: "n", issuedAt: new Date(NOW).toISOString() };
  const turned = [f("turn_left", -2, 0, 0.95, 0), f("turn_left", -25, 0, 0.03, 1), f("turn_left", -38, 0, 0.02, 2), f("turn_left", -40, 0, 0.05, 3)];
  assert.equal(verifyLivenessChallenge(turn, turned, {}, opts).ok, false);
  const pts = (k) => ({ leftEye: [100, 100], rightEye: [200, 100], nose: [150 - 120 * k, 150], mouthLeft: [110 - 30 * k, 200], mouthRight: [190 - 30 * k, 200] });
  const withParallax = turned.map((x, i) => ({ ...x, points: pts([0, 0.6, 1, 1][i]) }));
  const rp = verifyLivenessChallenge(turn, withParallax, {}, opts);
  assert.equal(rp.perAction.turn_left.rigidity?.ok, true, JSON.stringify(rp.perAction.turn_left));
  assert.equal(rp.ok, true, JSON.stringify(rp.reasonCodes));
});

test("a failing selfie contradicted by passing frontal frames routes to review; frames never lift it to approval", () => {
  assert.equal(decide({ selfie: { faceCount: 1 }, liveness: { score: 0.39, frontalMedian: 0.86, frontalFrames: 3 } }).status, "manual_review");
  assert.equal(decide({ selfie: { faceCount: 1 }, liveness: { score: 0.39, frontalMedian: 0.86, frontalFrames: 1 } }).status, "rejected", "one frame is not enough to contradict");
  assert.equal(decide({ selfie: { faceCount: 1 }, liveness: { score: 0.39, frontalMedian: 0.55, frontalFrames: 3 } }).status, "rejected", "frames must PASS, not merely be better");
  assert.equal(decide({ selfie: { faceCount: 1 }, liveness: { score: 0.55, frontalMedian: 0.99, frontalFrames: 3 } }).status, "manual_review", "borderline selfie stays borderline");
});

test("sequence: the early frame is excluded from the per-action window; coaching time before the movement does not fail", () => {
  const ch = { actions: ["turn_left", "turn_right"], nonce: "n", issuedAt: new Date(NOW).toISOString() };
  const frames = [];
  // early frame at t=1s, burst 12 s later (user needed coaching), then the second action
  for (const [action, base] of [["turn_left", 1000], ["turn_right", 20000]]) {
    frames.push({ action, createdAt: new Date(NOW + base) });
    for (const off of [12000, 12400, 12800]) frames.push({ action, createdAt: new Date(NOW + base + off) });
  }
  const seq = assessSequence(ch, frames);
  assert.equal(seq.actionSpanOk, true, JSON.stringify(seq));
  assert.deepEqual(seq.actions.map(a => a.spanMs), [800, 800]);
  // a burst itself spread over more than 15 s still fails
  const slow = frames.map((f, i) => (i % 4 === 3 ? { ...f, createdAt: new Date(f.createdAt.getTime() + 16000) } : f));
  assert.equal(assessSequence(ch, slow).actionSpanOk, false);
});

test("trajectory: a burst that starts mid-movement (≤ threshold) is still a verified motion", () => {
  const f = (yaw, i) => ({ pose: { yaw, pitch: 0 }, createdAt: new Date(NOW + i * 300) });
  assert.equal(assessTrajectory("turn_left", [f(-12, 0), f(-22, 1), f(-31, 2)]).ok, true);
  assert.equal(assessTrajectory("turn_left", [f(-30, 0), f(-31, 1), f(-30, 2)]).ok, false, "a constant turned pose is not a movement");
});

test("direction consistency: same-sign turns route to review by default and reject only when enforced", () => {
  const ch = { actions: ["turn_left", "turn_right"], nonce: "n", issuedAt: new Date(NOW).toISOString() };
  const frame = (action, yaw, i) => ({ action, checksum: `${action}${i}`, captureMode: "auto", createdAt: new Date(NOW + i * 300 + (action === "turn_right" ? 5000 : 0)), liveness: { score: 0.95, faceCount: 1 }, pose: { yaw, pitch: 0 } });
  const sameSign = [0, 18, 25, 30].flatMap((yaw, i) => [frame("turn_left", yaw, i), frame("turn_right", yaw, i)]);
  const reviewed = verifyLivenessChallenge(ch, sameSign, {}, { enforcePose: true, now: () => NOW + 60000 });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed.reasonCodes));
  assert.equal(reviewed.directionInconsistent, true);
  assert.equal(decide({ livenessChallenge: reviewed }, STRICT_T).status, "manual_review");
  const enforced = verifyLivenessChallenge(ch, sameSign, {}, { enforcePose: true, enforceConsistency: true, now: () => NOW + 60000 });
  assert.equal(enforced.ok, false);
  assert.ok(enforced.reasonCodes.includes("LIVENESS_DIRECTION_INCONSISTENT"));
  // one sign-flipped frame inside a burst does not decide the direction: majority wins
  const flipped = [0, -18, 25, -30].map((yaw, i) => frame("turn_left", yaw, i)).concat([0, 18, 25, 30].map((yaw, i) => frame("turn_right", yaw, i)));
  const r = verifyLivenessChallenge(ch, flipped, {}, { enforcePose: true, now: () => NOW + 60000 });
  assert.equal(r.perAction.turn_left.yawSign, -1);
  assert.deepEqual(r.perAction.turn_left.yawSignVotes, [1, 2]);
  assert.equal(r.directionInconsistent, false);
});

test("challenge frames are scored in time order with the previous face box as a detector prior", async t => {
  // a look_up burst whose 2nd and 3rd frames the detector only finds when given the prior box
  const frames = [
    { action: "look_up", atMs: 5000, plain: { pose: { yaw: 0, pitch: 2 }, score: 0.95 } },
    { action: "look_up", atMs: 5400, plain: { pose: { yaw: 0, pitch: -30 }, score: 0.05, needsPrior: true } },
    { action: "look_up", atMs: 5800, plain: { pose: { yaw: 0, pitch: -40 }, score: 0.04, needsPrior: true } },
    { action: "look_up", atMs: 6200, plain: { pose: { yaw: 0, pitch: -38 }, score: 0.06 } },
    ...turns({ startMs: 8000 })
  ];
  const fx = await seed({ actions: ["look_up", "turn_left", "turn_right"], frames }); t.after(fx.cleanup);
  const p = provider(); const base = p.checkLiveness; const calls = [];
  p.checkLiveness = async (buf, opts) => { let d = {}; try { d = JSON.parse(buf.toString()); } catch (_) {} calls.push(!!(opts && opts.priorBox)); const r = await base(buf); if (d.needsPrior && !(opts && opts.priorBox)) return { score: null, faceCount: 0, pose: null, raw: { faces: 0 } }; if (d.needsPrior) r.raw.detection = "tracked-low-confidence"; return r; };
  const out = await runVerification({ sessionUid: "vps_fix", attemptId: "att-1", policyVersion: PIPELINE_VERSION }, { db: fx.db, provider: p, evidenceKey: KEY, env: "test", screen: async () => ({ hit: false }) });
  assert.equal(out.status, "approved", JSON.stringify(out.reasonCodes));
  const lc = fx.db.verificationResult.rows[0].rawResult.livenessChallenge;
  assert.equal(lc.perAction.look_up.poseOk, true);
  assert.equal(lc.evidenceInsufficient, false, "tracked frames count as observations");
  assert.ok(calls.filter(Boolean).length >= 3, "later frames received a prior box");
});

test("direction consistency mode: record (default) approves and records; review reviews; reject rejects", async t => {
  // both turns reported with the SAME sign (what the pose model does on this face about half the time)
  const sameSign = turns().map(f => ({ ...f, plain: { ...f.plain, pose: { yaw: Math.abs(f.plain.pose.yaw), pitch: 0 } } }));
  const prev = process.env.CHALLENGE_CONSISTENCY_MODE;
  try {
    delete process.env.CHALLENGE_CONSISTENCY_MODE;
    const rec = await seed({ frames: sameSign }); t.after(rec.cleanup);
    const out = await rec.run();
    assert.equal(out.status, "approved", JSON.stringify(out.reasonCodes));
    const lc = rec.db.verificationResult.rows[0].rawResult.livenessChallenge;
    assert.equal(lc.directionInconsistent, true, "still recorded for calibration");
    assert.equal(rec.db.verificationResult.rows[0].rawResult.policy.consistency, "record");
    process.env.CHALLENGE_CONSISTENCY_MODE = "review";
    const rev = await seed({ frames: sameSign, settings: STRICT }); t.after(rev.cleanup);
    const o2 = await rev.run(); assert.equal(o2.status, "manual_review"); assert.ok(o2.reasonCodes.includes("LIVENESS_DIRECTION_INCONSISTENT"));
    process.env.CHALLENGE_CONSISTENCY_MODE = "reject";
    const rej = await seed({ frames: sameSign }); t.after(rej.cleanup);
    const o3 = await rej.run(); assert.equal(o3.status, "rejected"); assert.ok(o3.reasonCodes.includes("LIVENESS_DIRECTION_INCONSISTENT"));
  } finally { if (prev === undefined) delete process.env.CHALLENGE_CONSISTENCY_MODE; else process.env.CHALLENGE_CONSISTENCY_MODE = prev; }
});

test("trajectory start uses the conservative yaw candidate when the pose carries one", () => {
  const f = (yaw, near, i) => ({ pose: { yaw, yawNear: near, pitch: 0 }, createdAt: new Date(NOW + i * 300) });
  // early frame inflated to 24° by the larger candidate but 8° by the smaller: still a frontal start
  assert.equal(assessTrajectory("turn_left", [f(-24, 8, 0), f(-40, 30, 1), f(-55, 50, 2)]).ok, true);
  assert.equal(assessTrajectory("turn_left", [f(-30, 28, 0), f(-40, 30, 1), f(-55, 50, 2)]).ok, false, "both candidates turned → not a frontal start");
  assert.equal(assessTrajectory("turn_left", [f(-20, 18, 0), f(-24, 22, 1), f(-27, 25, 2)]).ok, false, "a head parked near the target angle does not travel a full threshold");
  const g = (pitch, i) => ({ pose: { yaw: 0, pitch }, createdAt: new Date(NOW + i * 300) });
  assert.equal(assessTrajectory("look_up", [g(13, 0), g(30, 1), g(38, 2)]).ok, true, "a 13° pitch start on a low-held phone is still a frontal start");
  assert.equal(assessTrajectory("turn_left", [f(-17, 16, 0), f(-40, 30, 1), f(-72, 50, 2)]).ok, true, "a start 25% over the threshold still counts when the burst then moves far");
});

test("policy-version guard: a worker refuses a job stamped for a different policy without touching the session", async t => {
  const fx = await seed({ frames: turns() }); t.after(fx.cleanup);
  await assert.rejects(runVerification({ sessionUid: "vps_fix", attemptId: "att-1", policyVersion: "some-other-policy" }, { db: fx.db, provider: provider(), evidenceKey: KEY, env: "test" }), /POLICY_VERSION_MISMATCH/);
  assert.equal(fx.session.status, "submitted");
  assert.equal(fx.db.verificationResult.rows.length, 0);
});

test("faceMatchStatus is 'review', not 'matched', when the document carries no face", async t => {
  const fx = await seed({ frames: turns() }); t.after(fx.cleanup);
  const p = provider();
  p.compareFaces = async () => ({ score: null, idFaceFound: false, raw: {} });
  await fx.db.verificationSession.updateMany({ where: { id: fx.session.id }, data: { verificationType: "ID_AND_FACE" } });
  const plain = Buffer.from(JSON.stringify({ score: 0.01 }));
  const checksum = crypto.createHash("sha256").update(plain).digest("hex");
  const storagePath = path.join(os.tmpdir(), `vp-fix-id-${Date.now()}.enc`);
  await fs.writeFile(storagePath, encryptBuffer(plain, KEY)); t.after(() => fs.rm(storagePath, { force: true }));
  await fx.db.evidenceFile.create({ data: { sessionId: fx.session.id, fileType: "id_front", label: null, attemptId: "att-1", challengeNonce: "n", storagePath, checksum, encrypted: true, createdAt: new Date(NOW + 500), bindingHmac: computeFrameBinding(config.sdkTokenSecret, "n", "id_front", checksum, [fx.session.tenantId, fx.session.id, "att-1", "id_front", null, null]) } });
  const out = await runVerification({ sessionUid: "vps_fix", attemptId: "att-1", policyVersion: PIPELINE_VERSION }, { db: fx.db, provider: p, evidenceKey: KEY, env: "test", screen: async () => ({ hit: false }) });
  assert.equal(out.status, "manual_review");
  assert.equal(fx.db.verificationResult.rows[0].faceMatchStatus, "review");
});
