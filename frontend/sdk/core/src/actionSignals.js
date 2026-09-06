"use strict";

// Action-SPECIFIC capture triggers. Pure + testable.
//
// An instruction must be satisfied by THAT movement and no other. Head
// movements (turn_*/look_*) are judged ONLY from landmark pose (signed
// yaw/pitch proxies relative to the session's FRONTAL REFERENCE). Face-box
// geometry is deliberately NOT a trigger source any more: with a detector
// that hugs the whole head, a box shifting sideways looks identical for a
// head ROTATING and a head MOVING, so geometry "completed" actions on plain
// movement (field report 2026-09-04). Without a pose channel the detector
// reports blind:true and never triggers — the widget then fails closed to
// manual capture (server verifies pose on what it receives).
//
// DIRECTION IS PREVIEW-SPACE, TOWARD THE ARROW (see landmarks.js): the
// expected sign of yaw is derived from which side the arrow is drawn on and
// the known CSS mirror of the preview — independent of whether the camera
// delivers native or pre-mirrored frames.
//
// ARMING: a detector counts nothing until the face has been FRONTAL (within
// tolerance of the reference) for 2 consecutive samples after the
// instruction appeared. Otherwise the next action's baseline is captured
// while the user is still turned, and the return to centre registers as the
// next movement.

const GEO = Object.freeze({
  turnStrongShift: 0.18, // signed |Δcx| / baseline width that alone proves a turn
  turnShift: 0.06,       // smaller signed shift, needs slight narrowing too
  turnDominance: 1.2,    // horizontal shift must dominate vertical
  turnMaxWidth: 0.97,
  turnNarrowWidth: 0.91, // narrowing signature: width ≤91% of baseline...
  turnAspectGap: 0.05,   // ...while height stays fuller (lean shrinks both)
  turnNarrowMinShift: 0.02, // ...and the centre must have moved the instructed way at all
  tiltShift: 0.09,       // |Δcy| / baseline height
  tiltDominance: 1.25,   // vertical shift must dominate horizontal
  bandFloor: 4,          // mean |Δgray| a band must reach (0..255 scale)
  bandDominance: 1.5,    // target band must beat the other band by this factor
  missMinShift: 0.04,    // pre-disappearance signed shift for the miss clause
  missMaxStreak: 4,      // how many missed detections still count as mid-turn
  armBoxShift: 0.08,     // arming (geometry): centre within this of baseline
  armBoxWidth: [0.9, 1.1] // arming (geometry): width ratio within this band
});

/** Signed centre/size of a box relative to the locked baseline. */
function boxMetrics(baseline, box) {
  if (!baseline || !box) return null;
  const bw = baseline.x2 - baseline.x1;
  const bh = baseline.y2 - baseline.y1;
  if (!(bw > 0 && bh > 0)) return null;
  const sdx = ((box.x1 + box.x2) / 2 - (baseline.x1 + baseline.x2) / 2) / bw;
  const sdy = ((box.y1 + box.y2) / 2 - (baseline.y1 + baseline.y2) / 2) / bh;
  return {
    sdx, sdy,
    dx: Math.abs(sdx),
    dy: Math.abs(sdy),
    widthRatio: (box.x2 - box.x1) / bw,
    heightRatio: (box.y2 - box.y1) / bh
  };
}

/**
 * Which way the box centre must move (sign of Δcx in the analysed frame) for
 * a turn: the face box shifts the same way the nose does, so this is the
 * arrow-relative sign from landmarks.expectedYawSign.
 */
function turnSign(action, mirrorPreview = true) {
  return require("./landmarks").expectedYawSign(action, mirrorPreview);
}

/**
 * Per-frame geometric verdict for head-movement actions (SIGNED for turns).
 * Diagnostic only — geometry no longer triggers captures (see header).
 */
function actionGeometry(action, baseline, box, geo = GEO, mirrorPreview = true) {
  const m = boxMetrics(baseline, box);
  if (!m) return false;

  switch (action) {
    case "turn_left":
    case "turn_right": {
      const s = turnSign(action, mirrorPreview);
      const towards = m.sdx * s; // positive when moving the instructed way
      const strongLateral = towards >= geo.turnStrongShift && m.dx >= geo.turnDominance * m.dy;
      const lateral = towards >= geo.turnShift && m.dx >= geo.turnDominance * m.dy && m.widthRatio <= geo.turnMaxWidth;
      const narrowing = m.widthRatio <= geo.turnNarrowWidth &&
        m.heightRatio - m.widthRatio >= geo.turnAspectGap &&
        towards >= geo.turnNarrowMinShift;
      return strongLateral || lateral || narrowing;
    }
    case "look_up":
    case "look_down":
      return m.dy >= geo.tiltShift && m.dy >= geo.tiltDominance * m.dx;
    default:
      return false;
  }
}

/**
 * Mean |Δgray| inside the eye band and mouth band of a face box, between two
 * consecutive grayscale frames (Float32Array, same dimensions).
 * Bands: eyes ≈ upper 18–45% of the box, mouth ≈ lower 55–95%.
 */
function bandMotion(prevGray, gray, frameWidth, box) {
  const out = { eyes: 0, mouth: 0 };
  if (!prevGray || !gray || prevGray.length !== gray.length || !box) return out;
  const frameHeight = Math.floor(gray.length / frameWidth);
  const h = box.y2 - box.y1;

  const bands = {
    eyes: [box.y1 + 0.18 * h, box.y1 + 0.45 * h],
    mouth: [box.y1 + 0.55 * h, box.y1 + 0.95 * h]
  };
  const x1 = Math.max(0, Math.floor(box.x1));
  const x2 = Math.min(frameWidth, Math.ceil(box.x2));
  if (x2 - x1 < 4) return out;

  for (const [name, [top, bottom]] of Object.entries(bands)) {
    const y1 = Math.max(0, Math.floor(top));
    const y2 = Math.min(frameHeight, Math.ceil(bottom));
    let sum = 0;
    let n = 0;
    for (let y = y1; y < y2; y++) {
      const row = y * frameWidth;
      for (let x = x1; x < x2; x++) {
        sum += Math.abs(gray[row + x] - prevGray[row + x]);
        n++;
      }
    }
    out[name] = n ? sum / n : 0;
  }
  return out;
}

/**
 * Stateful per-action detector. Feed it one update per detection tick:
 *   update({box, eyes, mouth, pose}) → {ok, triggered, holding, armed, poseOk, wrongWay, magnitude, hasPose}
 *
 * @param {object} [opts.frontalRef] session-level frontal pose {yaw, pitch}
 *   captured at the first align. With pose available this is the reference
 *   every verdict is measured against — NOT the pose at instruction time.
 * @param {boolean} [opts.requireArm] wait for a frontal face before counting
 *   (default: true when a frontalRef is given, else false — legacy geometry).
 */
function createActionDetector(action, baseline, {
  need = 2, geo = GEO, frontalRef = null, poseThresholds, requireArm, mirrorPreview = true
} = {}) {
  const { poseActionVerdict, createPoseSmoother, isFrontalPose, isReferencePose, frontalRefFromSamples, POSE_THRESHOLDS, EXPRESSION } = require("./landmarks");
  const pth = poseThresholds || POSE_THRESHOLDS;
  const smoother = createPoseSmoother(3);
  const isTurn = action === "turn_left" || action === "turn_right";
  const isTilt = action === "look_up" || action === "look_down";
  const isHead = isTurn || isTilt;
  const isExpr = action === "blink" || action === "open_mouth" || action === "smile";
  const ex = EXPRESSION;
  const exprBase = [];          // open-eye / resting-mouth baseline samples
  let exprClosed = false;       // blink: closure confirmed, waiting for re-open
  let everExpr = false;
  let noExprFrames = 0;
  const mustArm = requireArm === undefined ? !!frontalRef : !!requireArm;

  let ref = frontalRef;          // pose reference
  let healed = false;            // reference re-centred by the self-heal rule
  let armed = !mustArm;
  let armStreak = 0;
  let streak = 0;
  let triggered = false;
  let everPose = false;
  let noPoseFrames = 0;
  let wrongWay = false;
  let magnitude = 0;
  const ARM_YAW = 0.12, ARM_PITCH = 0.12;
  // Self-heal: a reference captured while the user was slightly turned would
  // block arming forever. If the pose has looked REFERENCE-frontal for the
  // last HEAL_N samples and we still are not armed, re-centre on them.
  const HEAL_N = 8;
  const recentFrontal = [];

  function frontalNow(sm) {
    if (!sm) return false;
    if (ref) return Math.abs(sm.yaw - ref.yaw) <= ARM_YAW && Math.abs(sm.pitch - ref.pitch) <= ARM_PITCH;
    return isFrontalPose(sm, pth);
  }

  const idle = (extra) => ({ ok: false, triggered, holding: false, armed, poseOk: false, wrongWay: false, magnitude: 0, hasPose: everPose, blind: isHead && !everPose && noPoseFrames >= 10, ...extra });

  return {
    action,
    baseline,
    get poseBaseline() { return ref; },
    get armed() { return armed; },
    get healed() { return healed; },
    update({ box, eyes = 0, mouth = 0, pose = null, expr = null } = {}) {
      // --- expression actions from landmark ratios (EAR / MAR) ---
      // blink: eyes must CLOSE (EAR ≤ 60 % of the open baseline) for `need`
      // ticks and then re-open — a closed frame is captured at the first ok
      // tick so the server sees the closed eyes. open_mouth: inner-lip MAR
      // ≥ 0.35 or ≥ 1.8× the resting MAR for `need` ticks (held, like a turn).
      if (isExpr && expr && (action === "blink" ? expr.ear != null : expr.mar != null)) {
        everExpr = true; noExprFrames = 0;
        const v = action === "blink" ? expr.ear : expr.mar;
        if (exprBase.length < ex.baselineSamples) {
          // baseline = the OPEN eyes / RESTING mouth: for the eyes take the
          // max of the first samples (a closed-eye start would otherwise make
          // every open frame look like a "reopen"), for the mouth the min
          exprBase.push(v);
          const base = action === "blink" ? Math.max(...exprBase) : Math.min(...exprBase);
          return { ok: false, triggered, holding: false, armed: exprBase.length >= ex.baselineSamples, poseOk: false, wrongWay: false, magnitude: 0, hasPose: true, blind: false, baseline: base };
        }
        armed = true;
        const base = action === "blink" ? Math.max(...exprBase) : Math.min(...exprBase);
        let ok;
        if (action === "blink") {
          ok = base > 0 && v <= ex.blinkCloseRatio * base;
          magnitude = base > 0 ? Math.max(0, 1 - v / base) : 0; // 0 open … ≥0.4 closed
          if (ok) { streak++; if (streak >= need) exprClosed = true; }
          else {
            streak = 0;
            // re-open after a confirmed closure completes the blink
            if (exprClosed && v >= ex.blinkReopenRatio * base) triggered = true;
            // eyes drifting more open than the baseline: keep the baseline honest
            if (v > base) { exprBase.push(v); exprBase.shift(); }
          }
          return { ok, triggered, holding: ok, armed: true, poseOk: false, wrongWay: false, magnitude, hasPose: true, blind: false, baseline: base };
        }
        // open_mouth
        ok = v >= ex.mouthOpenMar || (base > 0.02 && v >= ex.mouthOpenRatio * base);
        magnitude = Math.max(0, v - base);
        streak = ok ? streak + 1 : 0;
        if (streak >= need) triggered = true;
        if (!ok && v < base) { exprBase.push(v); exprBase.shift(); }
        return { ok, triggered, holding: ok, armed: true, poseOk: false, wrongWay: false, magnitude, hasPose: true, blind: false, baseline: base };
      }
      // --- expression actions without landmark ratios: legacy band motion for
      // blink/smile (older detectors); open_mouth has no band fallback and
      // reports blind so the widget fails closed to manual capture.
      if (isExpr) {
        if (action === "open_mouth" || everExpr) { noExprFrames++; return idle({ blind: !everExpr && noExprFrames >= 10, hasPose: everExpr }); }
        const ok = action === "blink"
          ? eyes >= geo.bandFloor && eyes >= geo.bandDominance * mouth
          : mouth >= geo.bandFloor && mouth >= geo.bandDominance * eyes;
        streak = ok ? streak + 1 : 0;
        if (streak >= need) triggered = true;
        return { ok, triggered, holding: ok, armed: true, poseOk: false, wrongWay: false, magnitude: 0, hasPose: false, blind: false };
      }
      if (!isHead) return idle();

      const sm = pose ? smoother.push(pose) : null;
      if (sm) { everPose = true; noPoseFrames = 0; } else noPoseFrames++;
      if (!sm) return idle();

      // learn a reference if none was supplied: first reference-frontal sample
      if (!ref && isReferencePose(sm, pth) && sm.samples >= 2) ref = { yaw: sm.yaw, pitch: sm.pitch };
      if (!armed) {
        if (isReferencePose(sm, pth)) { recentFrontal.push({ yaw: sm.yaw, pitch: sm.pitch }); if (recentFrontal.length > HEAL_N) recentFrontal.shift(); }
        else recentFrontal.length = 0;
        if (ref && recentFrontal.length >= HEAL_N && !frontalNow(sm)) { ref = frontalRefFromSamples(recentFrontal); healed = true; }
        if (frontalNow(sm)) { armStreak++; if (armStreak >= 2) armed = true; } else armStreak = 0;
        return idle();
      }
      if (!ref) return idle();

      const v = poseActionVerdict(action, ref, sm, pth, mirrorPreview);
      const ok = v.ok;
      wrongWay = v.wrongWay;
      magnitude = v.magnitude;
      streak = ok ? streak + 1 : 0;
      if (streak >= need) triggered = true;
      return { ok, triggered, holding: ok, armed: true, poseOk: ok, wrongWay, magnitude, hasPose: true, blind: false };
    }
  };
}

module.exports = { actionGeometry, boxMetrics, bandMotion, createActionDetector, turnSign, ACTION_GEO: GEO };
