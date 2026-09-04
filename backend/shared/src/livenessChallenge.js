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

// Actions the GENERATOR may issue. "smile" was removed from the pool
// (2026-09-02, same treatment as blink): the pose provider reports only
// {yaw, pitch, roll} — never a smile flag — so with pose enforcement a smile
// step degrades to "face present + score ≥ floor", the weakest slot in the
// challenge. It stays in CHALLENGE_ACTIONS so sessions issued before the
// change can still upload and verify their pending smile step.
const CHALLENGE_POOL = Object.freeze(["turn_left", "turn_right", "look_up"]);

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
  const pool = [...CHALLENGE_POOL];
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
// Both floors are env-tunable for calibration (P0: soft floor RAISED from
// 0.1 → 0.2 — at 0.1 a printed photo waved through the challenge scored
// close enough to pass whenever the selfie was strong; 0.2 keeps genuine
// backlit/turned heads passing while cutting flat-artifact frames).
const CHALLENGE_SCORE_FLOOR = Number(process.env.CHALLENGE_SCORE_FLOOR || 0.3);

// FV-2 soft floor: applied instead of CHALLENGE_SCORE_FLOOR only when the
// selfie strongly passed passive liveness. It relaxes the anti-spoof floor
// enough to accommodate the low scores frontal-biased models give genuine
// turned/tilted heads, WITHOUT disarming it — a near-zero or non-face junk
// frame still fails, so a strong selfie can no longer vouch for unrelated,
// independently-uploaded action frames.
const CHALLENGE_SOFT_FLOOR = Number(process.env.CHALLENGE_SOFT_FLOOR || 0.2);

/**
 * P0: cryptographic frame↔challenge binding. At upload time the API stamps
 * each liveness frame with the challenge nonce and an HMAC over
 * (nonce:action:checksum) keyed with a server secret. The worker only counts
 * frames whose binding verifies for the CURRENT challenge — a frame recorded
 * against an earlier challenge, relabeled for a different action, or with a
 * swapped image body (checksum mismatch) fails the HMAC and is ignored.
 */
function computeFrameBinding(secret, nonce, action, checksum) {
  return crypto
    .createHmac("sha256", String(secret))
    .update(`${nonce}:${action}:${checksum}`)
    .digest("hex");
}

/** Timing-safe verification of a stored frame binding. */
function verifyFrameBinding(secret, { challengeNonce, action, checksum, bindingHmac } = {}) {
  if (!challengeNonce || !action || !checksum || !bindingHmac) return false;
  const expected = computeFrameBinding(secret, challengeNonce, action, checksum);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(bindingHmac), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

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

  const usedChecksums = new Set();
  const bestScores = [];
  for (const action of challenge.actions) {
    const candidates = byAction.get(action) || [];
    // Distinctness (FV-1): a frame that already satisfied ANOTHER action can't
    // be reused here. Frames carry a plaintext checksum (from the evidence
    // store); relabeling ONE frame across every action — the trivial way to
    // defeat an action challenge — now fails, because the second action finds
    // its only frame already consumed. Frames without a checksum (unit tests,
    // legacy rows) are treated as always-distinct.
    const distinctCandidates = candidates.filter((c) => !(c.checksum && usedChecksums.has(c.checksum)));
    // Mid-action frames: a face must be PRESENT. faceCount>=1 (not ===1):
    // profile/tilted heads make detectors split or double-count, and the
    // selfie gate already rejects genuinely multi-person sessions.
    const faced = distinctCandidates.filter((c) => c.liveness && c.liveness.faceCount >= 1);
    if (faced.length === 0) {
      // A present-but-consumed frame is a relabeled duplicate; a truly absent
      // one is just incomplete. Both fail the challenge, with distinct codes.
      const consumedAway = candidates.length > 0 && distinctCandidates.length === 0;
      if (consumedAway) {
        reasonCodes.push("LIVENESS_CHALLENGE_DUPLICATE_FRAME");
        perAction[action] = { present: true, live: false, poseOk: false, duplicate: true };
      } else {
        reasonCodes.push("LIVENESS_CHALLENGE_INCOMPLETE");
        perAction[action] = { present: candidates.length > 0, live: false, poseOk: false };
      }
      continue;
    }
    // Consume these frames so a later action can't also claim them.
    for (const c of faced) if (c.checksum) usedChecksums.add(c.checksum);

    // Spoof floor — only when the provider gave a numeric score at all. A
    // strong selfie SOFTENS the floor (frontal-biased models score genuine
    // turned/tilted heads low) but never removes it (FV-2): the selfie and the
    // action frames are independent uploads, so a strong selfie must not let a
    // near-zero / non-face junk frame pass as a completed action.
    const passAt = thresholds?.liveness?.pass ?? 0.85;
    const selfieStrong = typeof opts.selfieScore === "number" && opts.selfieScore >= passAt;
    const floor = selfieStrong ? CHALLENGE_SOFT_FLOOR : CHALLENGE_SCORE_FLOOR;
    const scores = faced.map((c) => c.liveness.score).filter((s) => typeof s === "number");
    const maxScore = scores.length ? Math.max(...scores) : null;
    if (maxScore !== null && maxScore < floor) {
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
    // across models, so these numbers in rawResult are how a deployment
    // calibrates POSE thresholds before turning enforcement on.
    const posed = faced.filter((c) => c.pose);
    const poseObserved = posed.length
      ? {
          maxAbsYaw: Math.max(...posed.map((c) => Math.abs(Number(c.pose.yaw) || 0))),
          maxAbsPitch: Math.max(...posed.map((c) => Math.abs(Number(c.pose.pitch) || 0)))
        }
      : null;

    // P0 follow-up: with pose enforcement ON, a head-movement action with NO
    // pose signal at all must not silently pass — a provider outage (or a
    // provider that never reports pose) would otherwise disable the movement
    // check while appearing enforced. Expression actions (smile/blink, legacy)
    // are exempt: they never carry pose. Deployments still calibrating opt
    // out via enforcePose.
    const isHeadMovement = action === "turn_left" || action === "turn_right"
      || action === "look_up" || action === "look_down";
    if (opts.enforcePose === true && isHeadMovement && poseOk === null) {
      reasonCodes.push("LIVENESS_POSE_UNAVAILABLE");
      perAction[action] = { present: true, live: true, poseOk: false, poseChecked: false, poseEnforced: true, score: maxScore };
      continue;
    }

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
  CHALLENGE_POOL,
  CHALLENGE_SCORE_FLOOR,
  CHALLENGE_SOFT_FLOOR,
  poseSatisfiesAction,
  computeFrameBinding,
  verifyFrameBinding,
  DEFAULT_STEPS,
  DEFAULT_TTL_MS,
  generateLivenessChallenge,
  isChallengeFresh,
  verifyLivenessChallenge
};
