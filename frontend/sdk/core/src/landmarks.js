"use strict";

// Landmark-derived head-pose proxies for the browser SDK. Pure + testable.
//
// fr_landmark.onnx (the worker already runs it, providers/onnx.js) takes a
// 64×64 grayscale crop of the face box and returns 68 points normalised to
// the crop. From five anchor points (eyes, nose tip, mouth corners) we derive:
//
//   yaw   = (noseX − eyeMidX) / interOcular      signed: + when the nose sits
//           to the RIGHT of the eye midpoint IN THE ANALYSED FRAME.
//
// DIRECTION IS DEFINED IN PREVIEW SPACE, TOWARD THE ARROW — never as the
// user's anatomical left/right. Field evidence (2026-09-04): one tester's
// camera delivered frames that were ALREADY mirrored, so the widget's CSS
// mirror un-mirrored them; "turn LEFT" then showed the nose moving to
// screen-RIGHT, and any anatomical convention was inverted on that machine
// while correct on a phone. The arrow is drawn in preview space, the user
// follows what they see, and the preview↔frame relation is a known CSS flip
// (mirrorPreview=true on face steps) — so the expected sign of yaw in the
// analysed frame is fixed regardless of what the camera does:
//   arrow on preview-LEFT  (turn_left)  → nose moves to preview-left
//                                        → frame-RIGHT when mirrored → yaw > 0
//   arrow on preview-RIGHT (turn_right) → yaw < 0 when mirrored.
//   pitch = (noseY − eyeMidY) / (mouthMidY − eyeMidY)
//           ≈0.5–0.65 frontal; DROPS when the user looks UP (nose tip rises
//           toward the eye line as the chin lifts), rises looking down.
//
// Calibrated on replayed capture sessions (2026-09-04): turns peak at
// |Δyaw| 0.4–0.65 within 0.3–0.5 s, a real look-up at Δpitch ≈ −0.4; the
// static-face noise floor is |Δyaw| ≲ 0.08, |Δpitch| ≲ 0.09.

const LANDMARK_INPUT = 64;

/** Faceplugin convert68pts5pts: 68-point flat [x0,y0,…] → 5 anchor points. */
function fivePoints(lm) {
  const L = [(lm[74] + lm[76] + lm[80] + lm[82]) / 4, (lm[75] + lm[77] + lm[81] + lm[83]) / 4];
  const R = [(lm[86] + lm[88] + lm[92] + lm[94]) / 4, (lm[87] + lm[89] + lm[93] + lm[95]) / 4];
  const N = [lm[60], lm[61]];
  const ML = [(lm[96] + lm[120]) / 2, (lm[97] + lm[121]) / 2];
  const MR = [(lm[108] + lm[128]) / 2, (lm[109] + lm[129]) / 2];
  return { leftEye: L, rightEye: R, nose: N, mouthLeft: ML, mouthRight: MR };
}

/** Map the model's normalised (0..1 within the crop) output to box pixel coords. */
function denormalizeLandmarks(raw, box) {
  const bw = box.x2 - box.x1, bh = box.y2 - box.y1;
  const lm = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) lm[i] = i % 2 === 0 ? raw[i] * bw + box.x1 : raw[i] * bh + box.y1;
  return lm;
}

/** Head-pose proxies from five points. Returns null when degenerate. */
function poseFromFivePoints(p) {
  const eyeMid = [(p.leftEye[0] + p.rightEye[0]) / 2, (p.leftEye[1] + p.rightEye[1]) / 2];
  const mouthMid = [(p.mouthLeft[0] + p.mouthRight[0]) / 2, (p.mouthLeft[1] + p.mouthRight[1]) / 2];
  const iod = Math.hypot(p.rightEye[0] - p.leftEye[0], p.rightEye[1] - p.leftEye[1]);
  const faceH = mouthMid[1] - eyeMid[1];
  if (!(iod > 1) || !(faceH > 1)) return null;
  return {
    yaw: (p.nose[0] - eyeMid[0]) / iod,
    pitch: (p.nose[1] - eyeMid[1]) / faceH,
    interOcular: iod
  };
}

/** Convenience: raw 136-float model output + box → pose proxies (or null). */
function poseFromLandmarks(raw, box) {
  if (!raw || raw.length < 136 || !box) return null;
  return poseFromFivePoints(fivePoints(denormalizeLandmarks(raw, box)));
}

/**
 * Build the 64×64 grayscale (0..1) model input from an RGBA ImageData and a
 * face box (box clamped to the image, like the worker's livenessCrop(1.0)).
 */
function landmarkInputFromImageData(imageData, box) {
  const { width: W, height: H, data } = imageData;
  const x1 = Math.max(0, box.x1), y1 = Math.max(0, box.y1);
  const x2 = Math.min(W - 1, box.x2), y2 = Math.min(H - 1, box.y2);
  const bw = x2 - x1, bh = y2 - y1;
  if (!(bw > 4 && bh > 4)) return null;
  const S = LANDMARK_INPUT;
  const out = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    const sy = Math.min(H - 1, Math.floor(y1 + (y + 0.5) / S * bh));
    for (let x = 0; x < S; x++) {
      const sx = Math.min(W - 1, Math.floor(x1 + (x + 0.5) / S * bw));
      const o = (sy * W + sx) * 4;
      out[y * S + x] = (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) / 256;
    }
  }
  return { input: out, rect: { x1, y1, x2, y2 } };
}

// --- Action verdicts from pose ---------------------------------------------

// Thresholds on the SMOOTHED delta from the per-action baseline.
const POSE_THRESHOLDS = Object.freeze({
  yaw: 0.22,      // turns: |Δyaw| (noise floor ≈ 0.08, real turns 0.4–0.65)
  pitchUp: 0.2,   // look_up: baseline − pitch (real look-up ≈ 0.4)
  pitchDown: 0.3,  // look_down: pitch − baseline (return overshoot from a look-up reached +0.26 in replay)
  frontalYaw: 0.25,        // selfie gate: |yaw| below this reads as frontal
  refYaw: 0.15,            // a pose may only contribute to the session FRONTAL REFERENCE below this
  frontalPitch: [0.2, 0.95] // selfie gate / reference band; wide enough for a phone held below eye level
});

const HEAD_ACTIONS = new Set(["turn_left", "turn_right", "look_up", "look_down"]);

/**
 * Expected sign of Δyaw (frame space) for a turn, given that the preview the
 * user follows is a CSS mirror of the analysed frame (mirrorPreview=true —
 * the widget mirrors every face step) or not.
 */
function expectedYawSign(action, mirrorPreview = true) {
  if (action === "turn_left") return mirrorPreview ? 1 : -1;
  if (action === "turn_right") return mirrorPreview ? -1 : 1;
  return 0;
}

/**
 * Signed verdict for one action from a pose delta.
 * @returns {{ok:boolean, wrongWay:boolean, magnitude:number}}
 *   ok        — the movement reached threshold in the instructed direction
 *   wrongWay  — reached threshold in the OPPOSITE direction (coach the user)
 *   magnitude — |Δ| of the relevant axis (for "turn further" coaching)
 */
function poseActionVerdict(action, baseline, pose, th = POSE_THRESHOLDS, mirrorPreview = true) {
  if (!baseline || !pose || !HEAD_ACTIONS.has(action)) return { ok: false, wrongWay: false, magnitude: 0 };
  const dYaw = pose.yaw - baseline.yaw;
  const dPitch = pose.pitch - baseline.pitch;
  switch (action) {
    case "turn_left":
    case "turn_right": {
      const s = expectedYawSign(action, mirrorPreview);
      const towards = dYaw * s; // positive = toward the arrow
      return { ok: towards >= th.yaw, wrongWay: towards <= -th.yaw, magnitude: Math.abs(dYaw) };
    }
    case "look_up": return { ok: dPitch <= -th.pitchUp, wrongWay: dPitch >= th.pitchDown, magnitude: Math.abs(dPitch) };
    case "look_down": return { ok: dPitch >= th.pitchDown, wrongWay: dPitch <= -th.pitchUp, magnitude: Math.abs(dPitch) };
    default: return { ok: false, wrongWay: false, magnitude: 0 };
  }
}

/** Is this pose frontal enough for the selfie / a movement baseline? */
function isFrontalPose(pose, th = POSE_THRESHOLDS) {
  if (!pose) return false;
  return Math.abs(pose.yaw) <= th.frontalYaw && pose.pitch >= th.frontalPitch[0] && pose.pitch <= th.frontalPitch[1];
}

/** May this pose contribute to the session frontal reference? (tighter than the selfie gate) */
function isReferencePose(pose, th = POSE_THRESHOLDS) {
  return !!pose && Math.abs(pose.yaw) <= th.refYaw && pose.pitch >= th.frontalPitch[0] && pose.pitch <= th.frontalPitch[1];
}

/** Robust frontal reference: per-axis median over accumulated frontal samples. */
function frontalRefFromSamples(samples) {
  const ok = (samples || []).filter(Boolean);
  if (!ok.length) return null;
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  return { yaw: med(ok.map((p) => p.yaw)), pitch: med(ok.map((p) => p.pitch)), samples: ok.length };
}

/**
 * Median-of-N smoother for pose proxies (kills single-tick landmark jitter).
 */
function createPoseSmoother(window = 3) {
  const yaws = [], pitches = [];
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  return {
    push(pose) {
      if (!pose) return null;
      yaws.push(pose.yaw); pitches.push(pose.pitch);
      if (yaws.length > window) { yaws.shift(); pitches.shift(); }
      return { yaw: med(yaws), pitch: med(pitches), interOcular: pose.interOcular, samples: yaws.length };
    },
    reset() { yaws.length = 0; pitches.length = 0; }
  };
}

// --- Expression ratios (blink / open-mouth challenges) ---------------------
//
// Eye aspect ratio (Soukupová & Čech 2016) over the 68-point contour:
//   EAR = (‖p2−p6‖ + ‖p3−p5‖) / (2‖p1−p4‖)   points 36–41 (left) / 42–47 (right)
// ≈0.25–0.35 with open eyes, drops below ~60 % of that when the lids close.
// Mouth aspect ratio over the INNER lip contour (60–67):
//   MAR = (‖61−67‖ + ‖62−66‖ + ‖63−65‖) / (3‖60−64‖)
// ≈0.02–0.15 closed/relaxed, ≥0.35 clearly open. Both are ratios of
// distances measured in the same (denormalised) space, so they are invariant
// to face size and box aspect. Same formulas as the worker's verifier.
const EXPRESSION = Object.freeze({
  blinkCloseRatio: 0.6,  // EAR must fall to ≤ 60 % of the open baseline
  blinkReopenRatio: 0.85, // …and recover above this to count as a blink (not a squint)
  mouthOpenMar: 0.35,    // MAR at/above this is an open mouth regardless of rest
  mouthOpenRatio: 1.8,   // …or ≥ 1.8× the resting MAR
  baselineSamples: 4     // samples needed before a baseline is trusted
});

function d68(lm, a, b) { return Math.hypot(lm[2 * a] - lm[2 * b], lm[2 * a + 1] - lm[2 * b + 1]); }

/** Mean eye aspect ratio of both eyes from a flat 68-point array (or null). */
function eyeAspectRatio(lm) {
  if (!lm || lm.length < 136) return null;
  const one = (o) => {
    const w = d68(lm, o, o + 3);
    if (!(w > 0.5)) return null;
    return (d68(lm, o + 1, o + 5) + d68(lm, o + 2, o + 4)) / (2 * w);
  };
  const l = one(36), r = one(42);
  if (l == null || r == null) return null;
  return (l + r) / 2;
}

/** Inner-lip mouth aspect ratio from a flat 68-point array (or null). */
function mouthAspectRatio(lm) {
  if (!lm || lm.length < 136) return null;
  const w = d68(lm, 60, 64);
  if (!(w > 0.5)) return null;
  return (d68(lm, 61, 67) + d68(lm, 62, 66) + d68(lm, 63, 65)) / (3 * w);
}

/** Raw 136-float model output + box → {ear, mar} in pixel space (or null). */
function exprFromLandmarks(raw, box) {
  if (!raw || raw.length < 136 || !box) return null;
  const lm = denormalizeLandmarks(raw, box);
  const ear = eyeAspectRatio(lm), mar = mouthAspectRatio(lm);
  if (ear == null && mar == null) return null;
  return { ear, mar };
}

module.exports = {
  LANDMARK_INPUT,
  POSE_THRESHOLDS,
  HEAD_ACTIONS,
  fivePoints,
  denormalizeLandmarks,
  poseFromFivePoints,
  poseFromLandmarks,
  landmarkInputFromImageData,
  poseActionVerdict,
  expectedYawSign,
  isFrontalPose,
  isReferencePose,
  frontalRefFromSamples,
  createPoseSmoother,
  EXPRESSION,
  eyeAspectRatio,
  mouthAspectRatio,
  exprFromLandmarks
};
