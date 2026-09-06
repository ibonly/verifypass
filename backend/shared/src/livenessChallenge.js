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
const CHALLENGE_ACTIONS = Object.freeze(["turn_left", "turn_right", "look_up", "look_down", "blink", "open_mouth", "smile"]);

// Actions the GENERATOR may issue. "smile" was removed from the pool
// (2026-09-02, same treatment as blink): the pose provider reports only
// {yaw, pitch, roll} — never a smile flag — so with pose enforcement a smile
// step degrades to "face present + score ≥ floor", the weakest slot in the
// challenge. It stays in CHALLENGE_ACTIONS so sessions issued before the
// change can still upload and verify their pending smile step.
// look_down ADDED (2026-09-04): with only three pose-verifiable actions every
// challenge was the same set in one of 6 orders, and on laptops (camera above
// eye level) "look up" is a physically small movement the replay showed the
// tester never completing. Four head movements, three drawn, 24 sequences.
const CHALLENGE_POOL = Object.freeze(["turn_left", "turn_right", "look_up", "look_down", "blink", "open_mouth"]);
// Third-slot candidates (both turns are always issued): a tilt or an
// EXPRESSION verified from the 68-point landmarks (EAR for blink, MAR for
// open mouth) — blink is very hard to fake with a printed photo and adds
// sequence entropy at zero cost.
const THIRD_SLOT = Object.freeze(["look_up", "look_down", "blink", "open_mouth"]);

const DEFAULT_STEPS = 3;
const DEFAULT_TTL_MS = 10 * 60 * 1000; // challenge must be completed within 10 min

// Pose thresholds (degrees) used when a pose signal is available (ONNX provider).
const POSE = Object.freeze({ yaw: 15, pitch: 12 });

/**
 * Generate a randomized challenge. Distinct actions, random order.
 * @returns {{version:number, actions:string[], nonce:string, issuedAt:string}}
 */
function generateLivenessChallenge({ steps = DEFAULT_STEPS, now = Date.now, randomInt, excludeActions = [] } = {}) {
  const rnd = randomInt || ((n) => crypto.randomInt(n));
  const excluded = new Set(excludeActions || []);
  // Composition: BOTH turns + one tilt, shuffled (12 sequences). Both turns
  // are always present so the server can check DIRECTION CONSISTENCY
  // (opposite-signed peak yaw) without knowing whether the device mirrors
  // its frames — the only direction check that is device-independent.
  // An excluded action (user "can't do this movement", D3) is replaced by
  // the other tilt, or dropped if both tilts are excluded.
  const turns = ["turn_left", "turn_right"].filter((a) => !excluded.has(a));
  const thirds = THIRD_SLOT.filter((a) => !excluded.has(a));
  const chosen = [...turns];
  if (thirds.length) chosen.push(thirds[rnd(thirds.length)]);
  // fallback when exclusions leave too few: top up from the pool
  for (const a of CHALLENGE_POOL) { if (chosen.length >= Math.max(2, Math.min(steps, 3))) break; if (!chosen.includes(a) && !excluded.has(a)) chosen.push(a); }
  const actions = [];
  while (chosen.length) actions.push(chosen.splice(rnd(chosen.length), 1)[0]);
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
    case "open_mouth": return pose.mouthOpen === undefined ? null : pose.mouthOpen !== false;
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
  let motionUnverified = false;
  let manualCapture = false;
  let multiFaceActions = 0;
  let poseProviderUnavailable = false;
  let flatObject = false;
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
    // SIGNED peaks are recorded too: strictDirection can only be switched on
    // once a deployment has confirmed its pose model's sign convention against
    // instructed directions (turn_left should show consistently negative or
    // consistently positive peakYaw — either is fine, it just has to be known).
    const signedPeak = (vals) => vals.reduce((p, v) => (Math.abs(v) > Math.abs(p) ? v : p), 0);
    const poseObserved = posed.length
      ? {
          maxAbsYaw: Math.max(...posed.map((c) => Math.abs(Number(c.pose.yaw) || 0))),
          maxAbsPitch: Math.max(...posed.map((c) => Math.abs(Number(c.pose.pitch) || 0))),
          peakYaw: +signedPeak(posed.map((c) => Number(c.pose.yaw) || 0)).toFixed(1),
          peakPitch: +signedPeak(posed.map((c) => Number(c.pose.pitch) || 0)).toFixed(1)
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
      // Distinguish a pose PROVIDER outage (no frame of any action carried a
      // pose) from a pose missing on this action only (v5 C2): the former is
      // an ops problem and routes to review; the latter stays a failure.
      const anyPose = frames.some((f) => f && f.pose && (typeof f.pose.yaw === "number" || typeof f.pose.pitch === "number"));
      if (!anyPose) { poseProviderUnavailable = true; perAction[action] = { present: true, live: true, poseOk: false, poseChecked: false, poseEnforced: true, score: maxScore, poseProviderUnavailable: true }; if (maxScore !== null) bestScores.push(maxScore); continue; }
      reasonCodes.push("LIVENESS_POSE_UNAVAILABLE");
      perAction[action] = { present: true, live: true, poseOk: false, poseChecked: false, poseEnforced: true, score: maxScore };
      continue;
    }

    if (poseOk === false && opts.enforcePose === true) {
      reasonCodes.push("LIVENESS_CHALLENGE_FAILED");
      perAction[action] = { present: true, live: true, poseOk: false, poseChecked: true, score: maxScore, ...poseObserved };
      continue;
    }

    // Multi-frame MOTION evidence (soft signal). A single still frame at the
    // right angle satisfies the magnitude check; a real head movement leaves
    // a trajectory across the burst: it STARTS near frontal (the early shot /
    // trigger frame) and REACHES the threshold later, and the pose is not
    // constant across frames (a photo held at an angle is). Judged only when
    // >=3 frames carry pose + timestamps; failure is reported as
    // motionUnverified (manual review), never a hard reject, because the
    // fallback burst can legitimately start mid-movement.
    const trajectory = assessTrajectory(action, faced);
    // Expression actions are judged across the burst from per-frame EAR/MAR
    // (frames carry expr:{ear,mar} when the provider returned landmarks).
    const expression = assessExpression(action, faced);
    if (expression && expression.ok === false && opts.enforcePose === true) {
      reasonCodes.push("LIVENESS_CHALLENGE_FAILED");
      perAction[action] = { present: true, live: true, poseOk: false, poseChecked: true, expression, score: maxScore };
      continue;
    }
    // Rigidity (3D-ness) across the burst — a flat object turned in the hand
    // has no nose parallax. Soft signal by default (review); enforce → reject.
    const rigidity = (action === "turn_left" || action === "turn_right" || action === "look_up" || action === "look_down")
      ? assessRigidity(faced.map((c) => c.points || null))
      : null;
    if (rigidity && rigidity.ok === false) flatObject = true;
    // Manual frames (user tapped Capture instead of performing a detected
    // movement) are a bypass of the client-side action check: counted per
    // action and surfaced as manualCapture → manual review, never auto-approve.
    const manualFrames = faced.filter((c) => c.captureMode === "manual").length;
    if (manualFrames > 0) manualCapture = true;
    // A second face in EVERY frame of an action (operator coaching a victim,
    // two people in frame) — counted per action; ≥2 actions → review (A6).
    if (faced.every((c) => c.liveness && c.liveness.faceCount > 1)) multiFaceActions++;

    perAction[action] = {
      present: true, live: true,
      poseOk: poseOk !== false,
      poseChecked: poseOk !== null,
      poseEnforced: opts.enforcePose === true,
      score: maxScore,
      ...poseObserved,
      ...(trajectory ? { trajectoryChecked: true, trajectoryOk: trajectory.ok, trajectory: trajectory.detail } : { trajectoryChecked: false }),
      ...(expression ? { expression } : {}),
      ...(rigidity ? { rigidity } : {}),
      manualFrames,
      fallbackFrames: faced.filter((c) => c.captureMode === "fallback").length
    };
    if (trajectory && !trajectory.ok) motionUnverified = true;
    if (maxScore !== null) bestScores.push(maxScore);
  }

  // --- Direction CONSISTENCY (device-independent). Whatever the camera's
  // mirroring, turn_left and turn_right in one session must produce
  // opposite-signed peak yaw; look_up/look_down opposite-signed peak pitch.
  // Catches "same turned photo relabelled for both turns" and "turned the
  // same way twice". Recorded always; enforced when opts.enforceConsistency.
  const consistency = assessConsistency(perAction);
  if (consistency && consistency.ok === false && opts.enforceConsistency === true) {
    reasonCodes.push("LIVENESS_DIRECTION_INCONSISTENT");
  }

  // --- SEQUENCE / TIMING. Actions must occur in the issued order, each within
  // a short window, the whole challenge within a short span of issue. A frame
  // library uploaded at leisure fails this even with perfect poses.
  const sequence = assessSequence(challenge, frames, opts);
  if (sequence && sequence.ok === false && opts.enforceSequence === true) {
    reasonCodes.push("LIVENESS_CHALLENGE_SEQUENCE_INVALID");
  }

  const aggregateScore = bestScores.length ? Math.min(...bestScores) : null;
  // de-dupe reason codes
  if (flatObject && opts.enforceRigidity === true) reasonCodes.push("LIVENESS_FLAT_OBJECT");
  const ok = reasonCodes.length === 0;
  return { ok, aggregateScore, reasonCodes: [...new Set(reasonCodes)], perAction, motionUnverified, manualCapture, multiFaceActions, poseProviderUnavailable, flatObject, consistency, sequence };
}

// --- Free geometry signals from the 68/5-point landmarks ---------------------

/**
 * Least-squares 2-D affine (x' = a x + b y + c, y' = d x + e y + f) mapping
 * src points → dst points (≥3 points). Returns [a,b,c,d,e,f] or null.
 */
function affineLSQ(src, dst) {
  if (!src || !dst || src.length < 3 || src.length !== dst.length) return null;
  // Normal equations for A (3x3) with rows [x, y, 1]
  let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, n = src.length;
  let bx1 = 0, bx2 = 0, bx3 = 0, by1 = 0, by2 = 0, by3 = 0;
  for (let i = 0; i < n; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    sxx += x * x; sxy += x * y; sx += x; syy += y * y; sy += y;
    bx1 += x * u; bx2 += y * u; bx3 += u;
    by1 += x * v; by2 += y * v; by3 += v;
  }
  const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const solve = (b) => {
    // Cramer's rule (3x3)
    const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det(M);
    if (Math.abs(D) < 1e-9) return null;
    const col = (k) => M.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)));
    return [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
  };
  const p = solve([bx1, bx2, bx3]), q = solve([by1, by2, by3]);
  return p && q ? [p[0], p[1], p[2], q[0], q[1], q[2]] : null;
}

/**
 * RIGIDITY / "3D-ness" of a head movement from five anchor points per frame
 * ({leftEye, rightEye, nose, mouthLeft, mouthRight} in image pixels).
 *
 * A printed photo or a phone screen turned in the hand moves as a PLANE:
 * one 2-D affine transform maps every point of frame 1 onto frame N. A real
 * head is a 3-D object: the nose tip sits ~2–3 cm in front of the eye/mouth
 * plane, so under a 20–30° yaw it moves ~0.1–0.2 inter-ocular distances
 * relative to where the affine fit of the eyes+mouth predicts. We fit the
 * affine on the four coplanar-ish points (eyes, mouth corners) and measure
 * the nose residual, normalised by the reference inter-ocular distance.
 *
 * Judged only when ≥3 frames carry points AND the movement was large enough
 * for parallax to show (motion ≥ 0.2: IOD foreshortening or point travel in
 * IOD units); otherwise null (no evidence).
 *
 * Calibrated on the replayed tester recordings (2026-09-05, 4-frame bursts):
 * real turns → nose residual 0.23–0.33 at motion 0.5–1.1; a weak look-up →
 * 0.078 at motion 0.18 (below minMotion → not judged); a near-static frontal
 * stretch → 0.053 at motion 0.12 — which is why minMotion is 0.2, not 0.1: a
 * flat verdict needs a movement big enough that a real nose MUST show
 * parallax. Synthetic planar motion (rotation/scale/shear) → residual < 0.01.
 * @returns {null|{ok:boolean, maxResidual:number, frames:number, motion:number}}
 */
function assessRigidity(framePoints, { flatBelow = 0.06, minMotion = 0.2 } = {}) {
  const pts = (framePoints || []).filter((p) => p && p.leftEye && p.rightEye && p.nose && p.mouthLeft && p.mouthRight);
  if (pts.length < 3) return null;
  const ref = pts[0];
  const iod = Math.hypot(ref.rightEye[0] - ref.leftEye[0], ref.rightEye[1] - ref.leftEye[1]);
  if (!(iod > 1)) return null;
  const srcPlane = [ref.leftEye, ref.rightEye, ref.mouthLeft, ref.mouthRight];
  let maxResidual = 0, motion = 0;
  for (let i = 1; i < pts.length; i++) {
    const cur = pts[i];
    const A = affineLSQ(srcPlane, [cur.leftEye, cur.rightEye, cur.mouthLeft, cur.mouthRight]);
    if (!A) continue;
    const px = A[0] * ref.nose[0] + A[1] * ref.nose[1] + A[2];
    const py = A[3] * ref.nose[0] + A[4] * ref.nose[1] + A[5];
    const residual = Math.hypot(cur.nose[0] - px, cur.nose[1] - py) / iod;
    maxResidual = Math.max(maxResidual, residual);
    // movement magnitude: inter-ocular foreshortening (a turn shrinks it) or
    // the largest normalised displacement of any anchor point
    const iodCur = Math.hypot(cur.rightEye[0] - cur.leftEye[0], cur.rightEye[1] - cur.leftEye[1]);
    const shrink = Math.abs(1 - iodCur / iod);
    const disp = Math.max(...["leftEye", "rightEye", "nose", "mouthLeft", "mouthRight"].map((k) => Math.hypot(cur[k][0] - ref[k][0], cur[k][1] - ref[k][1]) / iod));
    motion = Math.max(motion, shrink, disp * 0.5);
  }
  if (motion < minMotion) return null; // not enough movement for parallax to be visible
  return { ok: maxResidual >= flatBelow, maxResidual: +maxResidual.toFixed(3), motion: +motion.toFixed(3), frames: pts.length };
}

/** Eye-aspect-ratio from the 68-point layout (indices 36–41 / 42–47). */
function eyeAspectRatio(lm) {
  const P = (i) => [lm[i * 2], lm[i * 2 + 1]];
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const ear = (s) => { const w = d(P(s), P(s + 3)); return w > 0 ? (d(P(s + 1), P(s + 5)) + d(P(s + 2), P(s + 4))) / (2 * w) : 0; };
  return (ear(36) + ear(42)) / 2;
}

/** Mouth-aspect-ratio from the inner lip points (60–67). */
function mouthAspectRatio(lm) {
  const P = (i) => [lm[i * 2], lm[i * 2 + 1]];
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const w = d(P(60), P(64));
  return w > 0 ? (d(P(61), P(67)) + d(P(62), P(66)) + d(P(63), P(65))) / (3 * w) : 0;
}

const EXPRESSION = Object.freeze({
  blinkCloseRatio: 0.6,   // EAR must drop to ≤ 60 % of the open EAR
  mouthOpenMar: 0.35,     // MAR reaching this reads as an open mouth
  mouthOpenRatio: 1.8     // or ≥ 1.8× the closed-mouth MAR
});

/**
 * Opposite-sign check between paired actions. null when no pair is present
 * or a peak is missing/zero (nothing to judge).
 */
function assessConsistency(perAction) {
  const pairs = [["turn_left", "turn_right", "peakYaw"], ["look_up", "look_down", "peakPitch"]];
  const checks = [];
  for (const [a, b, key] of pairs) {
    const pa = perAction[a], pb = perAction[b];
    if (!pa || !pb || typeof pa[key] !== "number" || typeof pb[key] !== "number") continue;
    if (pa[key] === 0 || pb[key] === 0) continue;
    checks.push({ pair: `${a}/${b}`, a: pa[key], b: pb[key], ok: Math.sign(pa[key]) !== Math.sign(pb[key]) });
  }
  if (!checks.length) return null;
  return { ok: checks.every((c) => c.ok), checks };
}

const SEQUENCE_LIMITS = Object.freeze({
  maxActionSpanMs: 6000,   // all frames of one action within this window
  maxChallengeSpanMs: 90000, // first to last frame of the whole challenge
  maxIssueToFirstMs: 180000  // issue → first frame (camera permission + align)
});

/**
 * Order + timing of the uploaded frames against the issued action order.
 * null when frames lack timestamps or fewer than two actions have frames.
 */
function assessSequence(challenge, frames, opts = {}) {
  const limits = { ...SEQUENCE_LIMITS, ...(opts.sequenceLimits || {}) };
  const byAction = new Map();
  for (const f of frames) {
    if (!f || !f.action || !f.createdAt) continue;
    const t = new Date(f.createdAt).getTime();
    if (Number.isNaN(t)) continue;
    if (!byAction.has(f.action)) byAction.set(f.action, []);
    byAction.get(f.action).push(t);
  }
  const ordered = challenge.actions.filter((a) => byAction.has(a));
  if (ordered.length < 2) return null;
  const spans = ordered.map((a) => { const ts = byAction.get(a).sort((x, y) => x - y); return { action: a, first: ts[0], last: ts[ts.length - 1], spanMs: ts[ts.length - 1] - ts[0] }; });
  let orderOk = true;
  const gapsMs = [];
  for (let i = 1; i < spans.length; i++) {
    gapsMs.push(spans[i].first - spans[i - 1].last);
    if (spans[i].first < spans[i - 1].last) orderOk = false; // next action began before the previous ended
  }
  const actionSpanOk = spans.every((s) => s.spanMs <= limits.maxActionSpanMs);
  const challengeSpanMs = spans[spans.length - 1].last - spans[0].first;
  const challengeSpanOk = challengeSpanMs <= limits.maxChallengeSpanMs;
  const issued = challenge.issuedAt ? new Date(challenge.issuedAt).getTime() : NaN;
  const issueToFirstMs = Number.isNaN(issued) ? null : spans[0].first - issued;
  const issueOk = issueToFirstMs === null || (issueToFirstMs >= -5000 && issueToFirstMs <= limits.maxIssueToFirstMs);
  return {
    ok: orderOk && actionSpanOk && challengeSpanOk && issueOk,
    orderOk, actionSpanOk, challengeSpanOk, issueOk,
    challengeSpanMs, issueToFirstMs, gapsMs,
    actions: spans.map((s) => ({ action: s.action, spanMs: s.spanMs }))
  };
}

/**
 * Trajectory assessment for one action over its faced frames.
 * @returns {null|{ok:boolean, detail:object}} null = not enough evidence to judge
 */
/**
 * Blink / open-mouth verdict across an action's frames from per-frame EAR/MAR.
 * null when no frame carries expression data.
 */
function assessExpression(action, faced) {
  if (action !== "blink" && action !== "open_mouth") return null;
  const ex = faced.map((c) => c.expr).filter((e) => e && typeof e.ear === "number" && typeof e.mar === "number");
  if (ex.length < 2) return ex.length ? { ok: null, frames: ex.length } : null;
  if (action === "blink") {
    const ears = ex.map((e) => e.ear);
    const open = Math.max(...ears), closed = Math.min(...ears);
    return { ok: open > 0 && closed <= EXPRESSION.blinkCloseRatio * open, open: +open.toFixed(3), closed: +closed.toFixed(3), frames: ex.length };
  }
  const mars = ex.map((e) => e.mar);
  const peak = Math.max(...mars), rest = Math.min(...mars);
  return { ok: peak >= EXPRESSION.mouthOpenMar || (rest > 0 && peak >= EXPRESSION.mouthOpenRatio * rest), peak: +peak.toFixed(3), rest: +rest.toFixed(3), frames: ex.length };
}

function assessTrajectory(action, faced) {
  const isTurn = action === "turn_left" || action === "turn_right";
  const isTilt = action === "look_up" || action === "look_down";
  if (!isTurn && !isTilt) return null;
  const posed = faced
    .filter((c) => c.pose && c.createdAt)
    .map((c) => ({ t: new Date(c.createdAt).getTime(), v: Math.abs(Number(isTurn ? c.pose.yaw : c.pose.pitch) || 0) }))
    .filter((x) => !Number.isNaN(x.t))
    .sort((a, b) => a.t - b.t);
  if (posed.length < 3) return null;
  const th = isTurn ? POSE.yaw : POSE.pitch;
  const values = posed.map((x) => x.v);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const first = values[0];
  const startedNearFrontal = first <= th * 0.6 || min <= th * 0.6;
  const varied = max - min >= th * 0.4;
  const reached = max >= th;
  const ok = reached && startedNearFrontal && varied;
  return { ok, detail: { frames: posed.length, first: +first.toFixed(1), min: +min.toFixed(1), max: +max.toFixed(1), threshold: th } };
}

module.exports = {
  CHALLENGE_ACTIONS,
  CHALLENGE_POOL,
  CHALLENGE_SCORE_FLOOR,
  CHALLENGE_SOFT_FLOOR,
  poseSatisfiesAction,
  computeFrameBinding,
  verifyFrameBinding,
  assessTrajectory,
  assessConsistency,
  assessSequence,
  assessRigidity,
  assessExpression,
  affineLSQ,
  eyeAspectRatio,
  mouthAspectRatio,
  EXPRESSION,
  SEQUENCE_LIMITS,
  DEFAULT_STEPS,
  DEFAULT_TTL_MS,
  generateLivenessChallenge,
  isChallengeFresh,
  verifyLivenessChallenge
};
