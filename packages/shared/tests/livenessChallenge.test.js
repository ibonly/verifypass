"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  generateLivenessChallenge,
  isChallengeFresh,
  verifyLivenessChallenge,
  CHALLENGE_ACTIONS
} = require("../src/livenessChallenge");

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
  const frames = [frame("look_up", 0.12, 1)]; // harsh backlight → very low score
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
