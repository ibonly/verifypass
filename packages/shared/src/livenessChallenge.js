"use strict";

// Active liveness challenge–response (server-authoritative anti-spoofing).
//
// The server issues an UNPREDICTABLE, ordered set of actions at session
// creation. The client (browser JS SDK) guides the user through them and
// uploads one or more frames per action. The worker then verifies, on the
// raw pixels, that each action was performed by a live face — so a replayed
// or pre-recorded stream (which can't know the challenge in advance) fails.
//
// This module is pure (no I/O): generation is used by the API, verification
// by the worker, so both sides share one definition.

const crypto = require("crypto");

// Actions the client SDK knows how to prompt + we can verify from pose/landmarks.
const CHALLENGE_ACTIONS = Object.freeze(["blink", "turn_left", "turn_right", "look_up", "smile"]);

const DEFAULT_STEPS = 3;
const DEFAULT_TTL_MS = 10 * 60 * 1000; // challenge must be completed within 10 min

// Pose thresholds (degrees) used when a pose signal is available (ONNX provider).
const POSE = Object.freeze({ yaw: 15, pitch: 12 });

/**
 * Generate a randomized challenge. Distinct actions, random order.
 * @returns {{version:number, actions:string[], nonce:string, issuedAt:string}}
 */
function generateLivenessChallenge({ steps = DEFAULT_STEPS, now = Date.now, randomInt } = {}) {
  const rnd = randomInt || ((n) => crypto.randomInt(n));
  const pool = [...CHALLENGE_ACTIONS];
  const actions = [];
  const count = Math.max(1, Math.min(steps, pool.length));
  for (let i = 0; i < count; i++) {
    actions.push(pool.splice(rnd(pool.length), 1)[0]);
  }
  return {
    version: 1,
    actions,
    nonce: crypto.randomBytes(12).toString("hex"),
    issuedAt: new Date(now()).toISOString()
  };
}

function isChallengeFresh(challenge, { now = Date.now, ttlMs = DEFAULT_TTL_MS } = {}) {
  const t = challenge?.issuedAt ? new Date(challenge.issuedAt).getTime() : NaN;
  if (Number.isNaN(t)) return false;
  return now() - t <= ttlMs;
}

/** Does an observed pose satisfy the requested action? Only used when pose is present. */
function poseMatchesAction(action, pose) {
  if (!pose) return true; // no pose signal (passive provider) → don't gate on pose
  const yaw = Number(pose.yaw) || 0;
  const pitch = Number(pose.pitch) || 0;
  switch (action) {
    case "turn_left": return yaw <= -POSE.yaw;
    case "turn_right": return yaw >= POSE.yaw;
    case "look_up": return pitch <= -POSE.pitch;
    case "look_down": return pitch >= POSE.pitch;
    // blink/smile need landmark/expression signals; if provided as booleans use them,
    // otherwise fall through to liveness-only verification for that step.
    case "blink": return pose.blinked !== false;
    case "smile": return pose.smiled !== false;
    default: return true;
  }
}

/**
 * Verify captured frames satisfy the challenge, on server-computed signals only.
 * @param {object} challenge stored {actions, nonce, issuedAt}
 * @param {Array<{action:string, liveness:{score:number|null, faceCount:number}, pose?:object}>} frames
 * @param {object} thresholds resolveThresholds() output (uses .liveness.reject)
 * @param {object} [opts] { now, ttlMs }
 * @returns {{ok:boolean, aggregateScore:number|null, reasonCodes:string[], perAction:object}}
 */
function verifyLivenessChallenge(challenge, frames = [], thresholds = {}, opts = {}) {
  const reasonCodes = [];
  const perAction = {};
  const rejectAt = thresholds?.liveness?.reject ?? 0.7;

  if (!challenge || !Array.isArray(challenge.actions) || challenge.actions.length === 0) {
    // No challenge on this session — nothing to verify here.
    return { ok: true, aggregateScore: null, reasonCodes: [], perAction };
  }

  if (!isChallengeFresh(challenge, opts)) {
    return { ok: false, aggregateScore: null, reasonCodes: ["LIVENESS_CHALLENGE_EXPIRED"], perAction };
  }

  const byAction = new Map();
  for (const f of frames) {
    if (!f || !f.action) continue;
    if (!byAction.has(f.action)) byAction.set(f.action, []);
    byAction.get(f.action).push(f);
  }

  const bestScores = [];
  for (const action of challenge.actions) {
    const candidates = byAction.get(action) || [];
    const usable = candidates.filter((c) => c.liveness && c.liveness.faceCount === 1);
    if (usable.length === 0) {
      reasonCodes.push("LIVENESS_CHALLENGE_INCOMPLETE");
      perAction[action] = { present: candidates.length > 0, live: false, poseOk: false };
      continue;
    }
    const live = usable.find((c) => typeof c.liveness.score === "number" && c.liveness.score >= rejectAt && poseMatchesAction(action, c.pose));
    if (!live) {
      reasonCodes.push("LIVENESS_CHALLENGE_FAILED");
      perAction[action] = { present: true, live: false, poseOk: false };
      continue;
    }
    perAction[action] = { present: true, live: true, poseOk: true, score: live.liveness.score };
    bestScores.push(live.liveness.score);
  }

  const ok = reasonCodes.length === 0;
  const aggregateScore = bestScores.length ? Math.min(...bestScores) : null;
  // de-dupe reason codes
  return { ok, aggregateScore, reasonCodes: [...new Set(reasonCodes)], perAction };
}

module.exports = {
  CHALLENGE_ACTIONS,
  DEFAULT_STEPS,
  DEFAULT_TTL_MS,
  generateLivenessChallenge,
  isChallengeFresh,
  poseMatchesAction,
  verifyLivenessChallenge
};
