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
// "blink" was removed from the pool: eye-band motion detection is too easily
// confounded by lighting flicker/exposure changes, producing false triggers
// and unreliable verification. (Verification code paths for blink remain for
// any sessions issued before the change.)
const CHALLENGE_ACTIONS = Object.freeze(["turn_left", "turn_right", "look_up", "smile"]);

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

// Anti-spoof floor for MID-ACTION frames. Deliberately far below
// liveness.reject: passive liveness models are frontal-biased, so a genuine
// turned/tilted head legitimately scores low. The SELFIE carries the strict
// passive-liveness gate; challenge frames only prove the action happened on
// a face, and only a confidently-spoof score fails them.
const CHALLENGE_SCORE_FLOOR = 0.3;

/**
 * Does an observed pose satisfy the requested action?
 * Returns true/false when a verdict is possible, or null when this frame
 * carries no signal for the action (e.g. no pose data, or smile without an
 * expression flag).
 *
 * Direction is NOT enforced by default — pose sign conventions differ across
 * models and mirrored captures, and a sign-flipped check silently rejects
 * every legitimate user. Magnitude (|yaw|/|pitch| past threshold) proves a
 * real head movement; enable `strictDirection` only after calibrating the
 * deployed container's conventions.
 */
function poseSatisfiesAction(action, pose, { strictDirection = false } = {}) {
  if (!pose) return null;
  const yaw = Number(pose.yaw) || 0;
  const pitch = Number(pose.pitch) || 0;
  switch (action) {
    case "turn_left": return strictDirection ? yaw <= -POSE.yaw : Math.abs(yaw) >= POSE.yaw;
    case "turn_right": return strictDirection ? yaw >= POSE.yaw : Math.abs(yaw) >= POSE.yaw;
    case "look_up": return strictDirection ? pitch <= -POSE.pitch : Math.abs(pitch) >= POSE.pitch;
    case "look_down": return strictDirection ? pitch >= POSE.pitch : Math.abs(pitch) >= POSE.pitch;
    case "blink": return pose.blinked === undefined ? null : pose.blinked !== false;
    case "smile": return pose.smiled === undefined ? null : pose.smiled !== false;
    default: return null;
  }
}

/** @deprecated kept for compatibility; use poseSatisfiesAction */
function poseMatchesAction(action, pose) {
  const r = poseSatisfiesAction(action, pose, { strictDirection: true });
  return r === null ? true : r;
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
    // Mid-action frames: a face must be PRESENT. faceCount>=1 (not ===1):
    // profile/tilted heads make detectors split or double-count, and the
    // selfie gate already rejects genuinely multi-person sessions.
    const faced = candidates.filter((c) => c.liveness && c.liveness.faceCount >= 1);
    if (faced.length === 0) {
      reasonCodes.push("LIVENESS_CHALLENGE_INCOMPLETE");
      perAction[action] = { present: candidates.length > 0, live: false, poseOk: false };
      continue;
    }

    // Spoof floor — only when the provider gave a numeric score at all, and
    // ONLY when the selfie did not strongly pass the strict liveness gate.
    // Rationale: mid-action frames (tilted/turned heads, backlighting) score
    // low on frontal-biased anti-spoof models even for live users, while a
    // replay attack cannot produce a high SELFIE score — so a strong selfie
    // makes low action-frame scores attributable to pose/lighting, not spoofing.
    const passAt = thresholds?.liveness?.pass ?? 0.85;
    const selfieStrong = typeof opts.selfieScore === "number" && opts.selfieScore >= passAt;
    const scores = faced.map((c) => c.liveness.score).filter((s) => typeof s === "number");
    const maxScore = scores.length ? Math.max(...scores) : null;
    if (maxScore !== null && maxScore < CHALLENGE_SCORE_FLOOR && !selfieStrong) {
      reasonCodes.push("LIVENESS_CHALLENGE_FAILED");
      perAction[action] = { present: true, live: false, poseOk: false, score: maxScore };
      continue;
    }

    // Pose: at least one frame must reach the movement magnitude, judged only
    // on frames that actually carry a pose signal for this action.
    const poseVerdicts = faced
      .map((c) => poseSatisfiesAction(action, c.pose, opts))
      .filter((v) => v !== null);
    const poseOk = poseVerdicts.length === 0 ? null : poseVerdicts.some(Boolean);

    // Record OBSERVED magnitudes for calibration — pose units/ranges differ
    // across models (degrees vs radians, sign conventions), so these numbers
    // in rawResult are how a deployment calibrates POSE thresholds before
    // turning enforcement on.
    const posed = faced.filter((c) => c.pose);
    const poseObserved = posed.length
      ? {
          maxAbsYaw: Math.max(...posed.map((c) => Math.abs(Number(c.pose.yaw) || 0))),
          maxAbsPitch: Math.max(...posed.map((c) => Math.abs(Number(c.pose.pitch) || 0)))
        }
      : null;

    // Pose enforcement is OPT-IN (settings.challenge.enforcePose) until the
    // deployed container's pose output has been calibrated against real
    // sessions. Uncalibrated hard-fail rejects every legitimate user.
    if (poseOk === false && opts.enforcePose === true) {
      reasonCodes.push("LIVENESS_CHALLENGE_FAILED");
      perAction[action] = { present: true, live: true, poseOk: false, poseChecked: true, score: maxScore, ...poseObserved };
      continue;
    }

    perAction[action] = {
      present: true, live: true,
      poseOk: poseOk !== false,
      poseChecked: poseOk !== null,
      poseEnforced: opts.enforcePose === true,
      score: maxScore,
      ...poseObserved
    };
    if (maxScore !== null) bestScores.push(maxScore);
  }

  const ok = reasonCodes.length === 0;
  const aggregateScore = bestScores.length ? Math.min(...bestScores) : null;
  // de-dupe reason codes
  return { ok, aggregateScore, reasonCodes: [...new Set(reasonCodes)], perAction };
}

module.exports = {
  CHALLENGE_ACTIONS,
  CHALLENGE_SCORE_FLOOR,
  poseSatisfiesAction,
  DEFAULT_STEPS,
  DEFAULT_TTL_MS,
  generateLivenessChallenge,
  isChallengeFresh,
  poseMatchesAction,
  verifyLivenessChallenge
};
