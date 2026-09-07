"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  generateLivenessChallenge,
  isChallengeFresh,
  verifyLivenessChallenge,
  CHALLENGE_ACTIONS, CHALLENGE_POOL, computeFrameBinding, verifyFrameBinding } = require("../src/livenessChallenge");

const THRESH = { liveness: { reject: 0.7, pass: 0.85 } };

test("generateLivenessChallenge: distinct actions, ordered, with nonce + issuedAt", () => {
  const c = generateLivenessChallenge({ steps: 3 });
  assert.equal(c.actions.length, 3);
  assert.equal(new Set(c.actions).size, 3); // distinct
  for (const a of c.actions) assert.ok(CHALLENGE_ACTIONS.includes(a));
  assert.match(c.nonce, /^[0-9a-f]{24}$/);
  assert.ok(!Number.isNaN(new Date(c.issuedAt).getTime()));
});

test("generateLivenessChallenge: unpredictable across calls", () => {
  const seqs = new Set();
  for (let i = 0; i < 20; i++) seqs.add(generateLivenessChallenge().actions.join(","));
  assert.ok(seqs.size > 1, "challenge order should vary");
});

test("isChallengeFresh: within TTL true, stale false", () => {
  const now = Date.now();
  const fresh = { issuedAt: new Date(now - 60_000).toISOString() };
  const stale = { issuedAt: new Date(now - 20 * 60_000).toISOString() };
  assert.equal(isChallengeFresh(fresh, { now: () => now }), true);
  assert.equal(isChallengeFresh(stale, { now: () => now }), false);
});

function frame(action, score, faceCount = 1, pose = null) {
  return { action, liveness: { score, faceCount }, pose };
}

test("verify: all actions live → ok, aggregate is the min score", () => {
  const c = { actions: ["blink", "turn_left"], nonce: "x", issuedAt: new Date().toISOString() };
  const frames = [frame("blink", 0.95), frame("turn_left", 0.88, 1, { yaw: -20 })];
  const r = verifyLivenessChallenge(c, frames, THRESH);
  assert.equal(r.ok, true);
  assert.equal(r.reasonCodes.length, 0);
  assert.equal(r.aggregateScore, 0.88);
});

test("verify: missing a required action → INCOMPLETE, not ok", () => {
  const c = { actions: ["blink", "turn_left"], nonce: "x", issuedAt: new Date().toISOString() };
  const r = verifyLivenessChallenge(c, [frame("blink", 0.95)], THRESH);
  assert.equal(r.ok, false);
  assert.ok(r.reasonCodes.includes("LIVENESS_CHALLENGE_INCOMPLETE"));
});

test("verify: confidently-spoof frame (below challenge floor) → FAILED", () => {
  const c = { actions: ["blink"], nonce: "x", issuedAt: new Date().toISOString() };
  const r = verifyLivenessChallenge(c, [frame("blink", 0.2)], THRESH);
  assert.equal(r.ok, false);
  assert.ok(r.reasonCodes.includes("LIVENESS_CHALLENGE_FAILED"));
});

test("verify: STRONG selfie disarms the spoof floor — backlit/tilted action frames must not fail a proven-live user", () => {
  const c = { actions: ["look_up"], nonce: "x", issuedAt: new Date().toISOString() };
  const frames = [frame("look_up", 0.25, 1)]; // harsh backlight → low score, above raised soft floor (0.2)
  const r = verifyLivenessChallenge(c, frames, THRESH, { selfieScore: 0.91 });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("verify: weak selfie keeps the spoof floor armed (replay can't fake a strong selfie)", () => {
  const c = { actions: ["look_up"], nonce: "x", issuedAt: new Date().toISOString() };
  const frames = [frame("look_up", 0.12, 1)];
  const r = verifyLivenessChallenge(c, frames, THRESH, { selfieScore: 0.6 });
  assert.equal(r.ok, false);
  assert.ok(r.reasonCodes.includes("LIVENESS_CHALLENGE_FAILED"));
});

test("verify: MID-ACTION frames with modest scores pass — frontal-biased models score turned heads low", () => {
  const c = { actions: ["turn_right", "look_up"], nonce: "x", issuedAt: new Date().toISOString() };
  const frames = [
    frame("turn_right", 0.45, 1, { yaw: 22 }),  // turned head: low-ish score is EXPECTED
    frame("look_up", null, 1, { pitch: -18 })    // no score signal at all on this frame
  ];
  const r = verifyLivenessChallenge(c, frames, THRESH);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("verify: pose magnitude proves movement regardless of sign (mirror-proof)", () => {
  const c = { actions: ["turn_left"], nonce: "x", issuedAt: new Date().toISOString() };
  // sign conventions vary by model/mirroring — |yaw| past threshold = a real turn
  const r = verifyLivenessChallenge(c, [frame("turn_left", 0.9, 1, { yaw: 25 })], THRESH);
  assert.equal(r.ok, true);
});

test("verify: strictDirection enforces the sign once conventions are calibrated", () => {
  const c = { actions: ["turn_left"], nonce: "x", issuedAt: new Date().toISOString() };
  const opts = { enforcePose: true, strictDirection: true };
  const wrongWay = verifyLivenessChallenge(c, [frame("turn_left", 0.9, 1, { yaw: 25 })], THRESH, opts);
  assert.equal(wrongWay.ok, false);
  const rightWay = verifyLivenessChallenge(c, [frame("turn_left", 0.9, 1, { yaw: -25 })], THRESH, opts);
  assert.equal(rightWay.ok, true);
});

test("verify: pose below threshold is OBSERVATIONAL by default (uncalibrated units must not reject)", () => {
  const c = { actions: ["turn_right"], nonce: "x", issuedAt: new Date().toISOString() };
  const frames = [
    frame("turn_right", 0.95, 1, { yaw: 3 }),
    frame("turn_right", 0.96, 1, { yaw: 5 })
  ];
  const r = verifyLivenessChallenge(c, frames, THRESH);
  assert.equal(r.ok, true, JSON.stringify(r));
  // ...but the shortfall + observed magnitudes are recorded for calibration
  assert.equal(r.perAction.turn_right.poseOk, false);
  assert.equal(r.perAction.turn_right.poseEnforced, false);
  assert.equal(r.perAction.turn_right.maxAbsYaw, 5);
});

test("verify: enforcePose turns the same shortfall into FAILED", () => {
  const c = { actions: ["turn_right"], nonce: "x", issuedAt: new Date().toISOString() };
  const frames = [frame("turn_right", 0.95, 1, { yaw: 3 })];
  const r = verifyLivenessChallenge(c, frames, THRESH, { enforcePose: true });
  assert.equal(r.ok, false);
  assert.ok(r.reasonCodes.includes("LIVENESS_CHALLENGE_FAILED"));
  assert.equal(r.perAction.turn_right.maxAbsYaw, 3);
});

test("verify: doubled detection on a turned head (faceCount 2) is still usable", () => {
  // profile faces make detectors split/double-count; the SELFIE gate owns
  // genuine multi-person rejection
  const c = { actions: ["turn_left"], nonce: "x", issuedAt: new Date().toISOString() };
  const r = verifyLivenessChallenge(c, [frame("turn_left", 0.5, 2, { yaw: -20 })], THRESH);
  assert.equal(r.ok, true);
});

test("verify: no face on a challenge frame → INCOMPLETE", () => {
  const c = { actions: ["blink"], nonce: "x", issuedAt: new Date().toISOString() };
  const r = verifyLivenessChallenge(c, [frame("blink", 0.95, 0)], THRESH);
  assert.equal(r.ok, false);
  assert.ok(r.reasonCodes.includes("LIVENESS_CHALLENGE_INCOMPLETE"));
});

test("verify: stale challenge → EXPIRED regardless of frames", () => {
  const c = { actions: ["blink"], nonce: "x", issuedAt: new Date(Date.now() - 60 * 60_000).toISOString() };
  const r = verifyLivenessChallenge(c, [frame("blink", 0.99)], THRESH);
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasonCodes, ["LIVENESS_CHALLENGE_EXPIRED"]);
});

test("verify: no challenge on session → ok (nothing to verify)", () => {
  const r = verifyLivenessChallenge(null, [], THRESH);
  assert.equal(r.ok, true);
});

// --- FV-1: frames are bound to actions by a distinct checksum ---

function cframe(action, score, checksum, faceCount = 1, pose = null) {
  return { action, liveness: { score, faceCount }, pose, checksum };
}

test("FV-1: one frame relabeled across every action → DUPLICATE_FRAME, not ok", () => {
  const c = { actions: ["turn_left", "turn_right", "smile"], nonce: "x", issuedAt: new Date().toISOString() };
  // The classic bypass: upload ONE genuine frame three times, once per action.
  const frames = [
    cframe("turn_left", 0.9, "sha_same"),
    cframe("turn_right", 0.9, "sha_same"),
    cframe("smile", 0.9, "sha_same")
  ];
  const r = verifyLivenessChallenge(c, frames, THRESH);
  assert.equal(r.ok, false);
  assert.ok(r.reasonCodes.includes("LIVENESS_CHALLENGE_DUPLICATE_FRAME"), JSON.stringify(r.reasonCodes));
});

test("FV-1: distinct frame per action → ok", () => {
  const c = { actions: ["turn_left", "smile"], nonce: "x", issuedAt: new Date().toISOString() };
  const frames = [
    cframe("turn_left", 0.9, "sha_a", 1, { yaw: -20 }),
    cframe("smile", 0.9, "sha_b")
  ];
  const r = verifyLivenessChallenge(c, frames, THRESH);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("FV-1: a duplicate copy added alongside a real distinct frame does not reject the honest action", () => {
  const c = { actions: ["turn_left", "smile"], nonce: "x", issuedAt: new Date().toISOString() };
  const frames = [
    cframe("turn_left", 0.9, "sha_a", 1, { yaw: -20 }),
    cframe("smile", 0.9, "sha_b"),      // honest frame for smile
    cframe("smile", 0.9, "sha_a")       // attacker copies turn_left's frame under smile
  ];
  const r = verifyLivenessChallenge(c, frames, THRESH);
  assert.equal(r.ok, true, JSON.stringify(r)); // smile still satisfied by its own distinct frame
});

test("FV-1: frames without checksums stay always-distinct (legacy/back-compat)", () => {
  const c = { actions: ["turn_left", "smile"], nonce: "x", issuedAt: new Date().toISOString() };
  const frames = [frame("turn_left", 0.9, 1, { yaw: -20 }), frame("smile", 0.9)];
  const r = verifyLivenessChallenge(c, frames, THRESH);
  assert.equal(r.ok, true);
});

// --- FV-2: a strong selfie softens but never disarms the spoof floor ---

test("FV-2: near-zero junk frame FAILS even with a strong selfie", () => {
  const c = { actions: ["look_up"], nonce: "x", issuedAt: new Date().toISOString() };
  const frames = [frame("look_up", 0.03, 1)]; // blank/non-face junk scores ~0
  const r = verifyLivenessChallenge(c, frames, THRESH, { selfieScore: 0.98 });
  assert.equal(r.ok, false);
  assert.ok(r.reasonCodes.includes("LIVENESS_CHALLENGE_FAILED"));
});

test("FV-2: genuine backlit frame (above soft floor) still passes with a strong selfie", () => {
  const c = { actions: ["look_up"], nonce: "x", issuedAt: new Date().toISOString() };
  const frames = [frame("look_up", 0.25, 1)]; // real but backlit head — above raised soft floor (0.2)
  const r = verifyLivenessChallenge(c, frames, THRESH, { selfieScore: 0.91 });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("P0 binding: compute/verify round-trip", () => {
  const hmac = computeFrameBinding("secret", "nonce-1", "turn_left", "abc123");
  assert.ok(/^[0-9a-f]{64}$/.test(hmac));
  assert.equal(verifyFrameBinding("secret", {
    challengeNonce: "nonce-1", action: "turn_left", checksum: "abc123", bindingHmac: hmac
  }), true);
});

test("P0 binding: tampered action, checksum, nonce or secret all fail", () => {
  const hmac = computeFrameBinding("secret", "nonce-1", "turn_left", "abc123");
  const base = { challengeNonce: "nonce-1", action: "turn_left", checksum: "abc123", bindingHmac: hmac };
  assert.equal(verifyFrameBinding("secret", { ...base, action: "turn_right" }), false);
  assert.equal(verifyFrameBinding("secret", { ...base, checksum: "zzz" }), false);
  assert.equal(verifyFrameBinding("secret", { ...base, challengeNonce: "nonce-2" }), false);
  assert.equal(verifyFrameBinding("other-secret", base), false);
  assert.equal(verifyFrameBinding("secret", { ...base, bindingHmac: null }), false);
  assert.equal(verifyFrameBinding("secret", {}), false);
});

test("generation pool excludes smile (pose-verifiable actions only)", () => {
  assert.ok(!CHALLENGE_POOL.includes("smile"));
  assert.ok(CHALLENGE_POOL.includes("turn_left") && CHALLENGE_POOL.includes("turn_right") && CHALLENGE_POOL.includes("look_up"));
  for (let i = 0; i < 25; i++) {
    for (const a of generateLivenessChallenge().actions) {
      assert.notEqual(a, "smile", "generator must never issue smile");
      assert.ok(CHALLENGE_POOL.includes(a));
    }
  }
  // legacy sessions: smile stays an ACCEPTED action for upload/verify
  assert.ok(CHALLENGE_ACTIONS.includes("smile"));
});

test("enforcePose: no pose on ANY frame = provider outage → poseProviderUnavailable (review), not a customer rejection", () => {
  const c = { actions: ["turn_left"], nonce: "x", issuedAt: new Date().toISOString() };
  const frames = [frame("turn_left", 0.9, 1)]; // faceCount ok, no pose at all
  const r = verifyLivenessChallenge(c, frames, THRESH, { enforcePose: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.poseProviderUnavailable, true);
});

test("enforcePose: pose present on other actions but missing on this one → LIVENESS_POSE_UNAVAILABLE (fail)", () => {
  const c = { actions: ["turn_left", "turn_right"], nonce: "x", issuedAt: new Date().toISOString() };
  const frames = [frame("turn_left", 0.9, 1, { yaw: 20, pitch: 0 }), frame("turn_right", 0.9, 1)];
  const r = verifyLivenessChallenge(c, frames, THRESH, { enforcePose: true });
  assert.equal(r.ok, false);
  assert.ok(r.reasonCodes.includes("LIVENESS_POSE_UNAVAILABLE"), JSON.stringify(r));
});

test("enforcePose: smile without pose still passes (legacy expression action, no pose flag exists)", () => {
  const c = { actions: ["smile"], nonce: "x", issuedAt: new Date().toISOString() };
  const frames = [frame("smile", 0.9, 1)];
  const r = verifyLivenessChallenge(c, frames, THRESH, { enforcePose: true });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("enforcePose OFF: head-movement action with no pose keeps passing (calibration mode)", () => {
  const c = { actions: ["turn_left"], nonce: "x", issuedAt: new Date().toISOString() };
  const frames = [frame("turn_left", 0.9, 1)];
  const r = verifyLivenessChallenge(c, frames, THRESH, {});
  assert.equal(r.ok, true, JSON.stringify(r));
});

// --- Multi-frame trajectory (soft motion evidence) -------------------------
const tframe = (action, yaw, tOffsetMs, checksum) => ({
  action, liveness: { score: 0.9, faceCount: 1 }, pose: { yaw, pitch: 0 },
  checksum, createdAt: new Date(1_700_000_000_000 + tOffsetMs).toISOString()
});

test("trajectory: burst that starts near frontal and reaches threshold → motion verified", () => {
  const c = { actions: ["turn_left"], nonce: "x", issuedAt: new Date().toISOString() };
  const frames = [tframe("turn_left", -4, 0, "a"), tframe("turn_left", -16, 350, "b"), tframe("turn_left", -24, 700, "c")];
  const r = verifyLivenessChallenge(c, frames, THRESH, { enforcePose: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.motionUnverified, false);
  assert.equal(r.perAction.turn_left.trajectoryOk, true);
});

test("trajectory: every frame already at the angle (photo held turned) → motionUnverified (soft)", () => {
  const c = { actions: ["turn_left"], nonce: "x", issuedAt: new Date().toISOString() };
  const frames = [tframe("turn_left", -25, 0, "a"), tframe("turn_left", -25, 350, "b"), tframe("turn_left", -26, 700, "c")];
  const r = verifyLivenessChallenge(c, frames, THRESH, { enforcePose: true });
  assert.equal(r.ok, true, "magnitude check still passes");
  assert.equal(r.motionUnverified, true);
  assert.equal(r.perAction.turn_left.trajectoryOk, false);
});

test("trajectory: fewer than 3 posed frames → not judged (no false review)", () => {
  const c = { actions: ["turn_left"], nonce: "x", issuedAt: new Date().toISOString() };
  const frames = [tframe("turn_left", -25, 0, "a"), tframe("turn_left", -25, 350, "b")];
  const r = verifyLivenessChallenge(c, frames, THRESH, { enforcePose: true });
  assert.equal(r.motionUnverified, false);
  assert.equal(r.perAction.turn_left.trajectoryChecked, false);
});

// --- Batch 1 (v5 A1/A2): composition, direction consistency, sequence ---------
test("generator: every challenge contains BOTH turns and one third-slot action (tilt or expression); exclusions respected", () => {
  const THIRD = ["look_up", "look_down", "blink", "open_mouth"];
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    const c = generateLivenessChallenge();
    assert.ok(c.actions.includes("turn_left") && c.actions.includes("turn_right"), c.actions.join(","));
    const third = c.actions.filter((a) => THIRD.includes(a));
    assert.equal(third.length, 1); seen.add(third[0]);
    assert.equal(c.actions.length, 3);
  }
  assert.ok(seen.size === 2, "third slot should vary");
  const c2 = generateLivenessChallenge({ excludeActions: ["look_up", "blink", "open_mouth"] });
  assert.ok(c2.actions.includes("look_down") && !c2.actions.includes("look_up"));
  const c3 = generateLivenessChallenge({ excludeActions: THIRD });
  assert.deepEqual([...c3.actions].sort(), ["turn_left", "turn_right"]);
});

const NOW = () => 1_700_000_000_000 + 60_000;
const pframe = (action, yaw, pitch, tMs, checksum) => ({
  action, liveness: { score: 0.9, faceCount: 1 }, pose: { yaw, pitch }, checksum,
  createdAt: new Date(1_700_000_000_000 + tMs).toISOString()
});

test("consistency: opposite-signed peak yaw across the two turns is ok; same sign is flagged (enforced only when opted in)", () => {
  const c = { actions: ["turn_left", "turn_right", "look_up"], nonce: "x", issuedAt: new Date(1_700_000_000_000).toISOString() };
  // Two strong frames per turn: the direction sign is a majority vote over
  // frames past the threshold (a single profile frame's sign is unreliable).
  const good = [pframe("turn_left", 20, 0, 1000, "a"), pframe("turn_left", 24, 0, 1300, "a2"), pframe("turn_right", -22, 0, 3000, "b"), pframe("turn_right", -25, 0, 3300, "b2"), pframe("look_up", 0, -15, 5000, "c")];
  const r1 = verifyLivenessChallenge(c, good, THRESH, { now: NOW, enforcePose: true, enforceConsistency: true });
  assert.equal(r1.ok, true, JSON.stringify(r1.reasonCodes));
  assert.equal(r1.consistency.ok, true);
  const bad = [pframe("turn_left", 20, 0, 1000, "a"), pframe("turn_left", 24, 0, 1300, "a2"), pframe("turn_right", 21, 0, 3000, "b"), pframe("turn_right", 26, 0, 3300, "b2"), pframe("look_up", 0, -15, 5000, "c")];
  const rRecord = verifyLivenessChallenge(c, bad, THRESH, { now: NOW, enforcePose: true });
  assert.equal(rRecord.ok, true, "direction consistency is REVIEW by default (pose sign reliability unproven)");
  assert.equal(rRecord.consistency.ok, false);
  assert.equal(rRecord.directionInconsistent, true);
  const rEnforce = verifyLivenessChallenge(c, bad, THRESH, { now: NOW, enforcePose: true, enforceConsistency: true });
  assert.equal(rEnforce.ok, false);
  assert.ok(rEnforce.reasonCodes.includes("LIVENESS_DIRECTION_INCONSISTENT"));
  // one strong frame per turn cannot resolve a sign → unresolved, never a failure
  const single = [pframe("turn_left", 20, 0, 1000, "a"), pframe("turn_right", 21, 0, 3000, "b"), pframe("look_up", 0, -15, 5000, "c")];
  const rSingle = verifyLivenessChallenge(c, single, THRESH, { now: NOW, enforcePose: true, enforceConsistency: true });
  assert.equal(rSingle.consistency.ok, null);
  assert.equal(rSingle.directionInconsistent, false);
});

test("sequence: issued order + tight windows pass; out-of-order or slow uploads are flagged (enforced when opted in)", () => {
  const c = { actions: ["turn_left", "turn_right", "look_up"], nonce: "x", issuedAt: new Date(1_700_000_000_000).toISOString() };
  const ok = [pframe("turn_left", 20, 0, 4000, "a"), pframe("turn_left", 22, 0, 4400, "a2"), pframe("turn_right", -20, 0, 7000, "b"), pframe("look_up", 0, -15, 9500, "c")];
  const r = verifyLivenessChallenge(c, ok, THRESH, { now: NOW, enforcePose: true, enforceSequence: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.sequence.ok, true);
  // out of order: turn_right frames BEFORE turn_left's
  const ooo = [pframe("turn_left", 20, 0, 7000, "a"), pframe("turn_right", -20, 0, 4000, "b"), pframe("look_up", 0, -15, 9500, "c")];
  assert.equal(verifyLivenessChallenge(c, ooo, THRESH, { now: NOW, enforcePose: true }).sequence.orderOk, false);
  assert.ok(verifyLivenessChallenge(c, ooo, THRESH, { now: NOW, enforcePose: true, enforceSequence: true }).reasonCodes.includes("LIVENESS_CHALLENGE_SEQUENCE_INVALID"));
  // slow: 3 minutes between actions (frame library uploaded at leisure)
  const slow = [pframe("turn_left", 20, 0, 4000, "a"), pframe("turn_right", -20, 0, 120000, "b"), pframe("look_up", 0, -15, 200000, "c")];
  const rs = verifyLivenessChallenge(c, slow, THRESH, { now: NOW, enforcePose: true });
  assert.equal(rs.sequence.challengeSpanOk, false);
});

test("manual capture: any manually captured frame marks the challenge manualCapture (review), auto/fallback do not", () => {
  const c = { actions: ["turn_left"], nonce: "x", issuedAt: new Date().toISOString() };
  const f = (mode) => ({ action: "turn_left", liveness: { score: 0.9, faceCount: 1 }, pose: { yaw: 20, pitch: 0 }, checksum: "a", captureMode: mode });
  assert.equal(verifyLivenessChallenge(c, [f("auto")], THRESH, { enforcePose: true }).manualCapture, false);
  assert.equal(verifyLivenessChallenge(c, [f("fallback")], THRESH, { enforcePose: true }).manualCapture, true);
  const r = verifyLivenessChallenge(c, [f("manual")], THRESH, { enforcePose: true });
  assert.equal(r.manualCapture, true);
  assert.equal(r.perAction.turn_left.manualFrames, 1);
});


// --- Free geometry signals (v7): rigidity, EAR/MAR ---------------------------
const { assessRigidity, assessExpression, affineLSQ, eyeAspectRatio, mouthAspectRatio } = require("../src/livenessChallenge");
// a frontal face: eyes 40 px apart, nose 2.5 cm (~0.4 IOD) in FRONT of the eye/mouth plane
function facePoints(yawDeg, { flat = false } = {}) {
  const r = yawDeg * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
  const P3 = { leftEye: [-20, 0, 0], rightEye: [20, 0, 0], mouthLeft: [-14, 34, 0], mouthRight: [14, 34, 0], nose: [0, 18, flat ? 0 : 16] };
  const out = {};
  for (const [k, [x, y, z]] of Object.entries(P3)) out[k] = [100 + x * cos + z * sin, 100 + y]; // rotate about the vertical axis, weak perspective
  return out;
}
test("rigidity: a real head turn shows nose parallax (ok); a flat photo turned the same way does not", () => {
  const real = [0, 15, 30, 45].map((d) => facePoints(d));
  const flat = [0, 15, 30, 45].map((d) => facePoints(d, { flat: true }));
  const r = assessRigidity(real), f = assessRigidity(flat);
  assert.ok(r && r.ok === true && r.maxResidual > 0.1, JSON.stringify(r));
  assert.ok(f && f.ok === false && f.maxResidual < 0.02, JSON.stringify(f));
  assert.equal(assessRigidity([facePoints(0), facePoints(8), facePoints(15)]), null, "too little motion → no verdict");
  assert.equal(assessRigidity([facePoints(0), facePoints(20)]), null, "needs ≥3 frames");
});
test("affineLSQ recovers a known transform", () => {
  const src = [[0, 0], [10, 0], [0, 10], [10, 10]];
  const A = [1.2, 0.1, 5, -0.2, 0.9, 3];
  const dst = src.map(([x, y]) => [A[0] * x + A[1] * y + A[2], A[3] * x + A[4] * y + A[5]]);
  const est = affineLSQ(src, dst);
  est.forEach((v, i) => assert.ok(Math.abs(v - A[i]) < 1e-6));
});
test("EAR/MAR + assessExpression: blink needs a closed frame; open mouth needs a high MAR", () => {
  const lm = new Array(136).fill(0);
  const set = (i, x, y) => { lm[i * 2] = x; lm[i * 2 + 1] = y; };
  // open eyes: corners 0/3 at x=0/30, lids 1,2 at y=-5 and 4,5 at y=+5
  [[36, 0, 0], [39, 30, 0], [37, 10, -5], [38, 20, -5], [41, 10, 5], [40, 20, 5], [42, 40, 0], [45, 70, 0], [43, 50, -5], [44, 60, -5], [47, 50, 5], [46, 60, 5]].forEach(([i, x, y]) => set(i, x, y));
  const open = eyeAspectRatio(lm); assert.ok(open > 0.3);
  [[37, 10, -1], [38, 20, -1], [41, 10, 1], [40, 20, 1], [43, 50, -1], [44, 60, -1], [47, 50, 1], [46, 60, 1]].forEach(([i, x, y]) => set(i, x, y));
  const closed = eyeAspectRatio(lm); assert.ok(closed < 0.6 * open);
  const b = assessExpression("blink", [{ expr: { ear: open, mar: 0.1 } }, { expr: { ear: closed, mar: 0.1 } }, { expr: { ear: open, mar: 0.1 } }]);
  assert.equal(b.ok, true);
  assert.equal(assessExpression("blink", [{ expr: { ear: open, mar: 0.1 } }, { expr: { ear: open * 0.9, mar: 0.1 } }, { expr: { ear: open, mar: 0.1 } }]).ok, false);
  [[60, 0, 0], [64, 40, 0], [61, 10, -8], [67, 10, 8], [62, 20, -8], [66, 20, 8], [63, 30, -8], [65, 30, 8]].forEach(([i, x, y]) => set(i, x, y));
  assert.ok(mouthAspectRatio(lm) >= 0.35);
  assert.equal(assessExpression("open_mouth", [{ expr: { ear: 0.3, mar: 0.05 } }, { expr: { ear: 0.3, mar: 0.2 } }, { expr: { ear: 0.3, mar: mouthAspectRatio(lm) } }]).ok, true);
});
