"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  generateLivenessChallenge,
  isChallengeFresh,
  verifyLivenessChallenge,
  CHALLENGE_ACTIONS, computeFrameBinding, verifyFrameBinding } = require("../src/livenessChallenge");

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
