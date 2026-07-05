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

test("verify: spoofed frame (low liveness) → FAILED", () => {
  const c = { actions: ["blink"], nonce: "x", issuedAt: new Date().toISOString() };
  const r = verifyLivenessChallenge(c, [frame("blink", 0.2)], THRESH);
  assert.equal(r.ok, false);
  assert.ok(r.reasonCodes.includes("LIVENESS_CHALLENGE_FAILED"));
});

test("verify: pose contradicts action (replay/wrong motion) → FAILED", () => {
  const c = { actions: ["turn_left"], nonce: "x", issuedAt: new Date().toISOString() };
  // high liveness but yaw says they turned RIGHT, not left
  const r = verifyLivenessChallenge(c, [frame("turn_left", 0.95, 1, { yaw: 25 })], THRESH);
  assert.equal(r.ok, false);
  assert.ok(r.reasonCodes.includes("LIVENESS_CHALLENGE_FAILED"));
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
