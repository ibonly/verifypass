"use strict";
// Landmark pose proxies + pose-aware action detection. Thresholds were
// calibrated on replayed capture sessions (2026-09-04); the numbers below
// mirror those observations (turn |Δyaw| 0.4–0.65, look-up Δpitch ≈ −0.4,
// static noise ≲ 0.08).
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  poseFromFivePoints, poseActionVerdict, isFrontalPose, createPoseSmoother, POSE_THRESHOLDS, fivePoints, denormalizeLandmarks
} = require("../src/landmarks");
const { createActionDetector } = require("../src/actionSignals");
const { bestFaceBox, DETECT_CONFIG } = require("../src/faceDetectMath");

const frontal = () => ({ leftEye: [100, 100], rightEye: [140, 100], nose: [120, 125], mouthLeft: [105, 145], mouthRight: [135, 145] });

test("poseFromFivePoints: frontal face → yaw≈0, pitch in the frontal band", () => {
  const p = poseFromFivePoints(frontal());
  assert.ok(Math.abs(p.yaw) < 0.01);
  assert.ok(p.pitch > 0.5 && p.pitch < 0.6, String(p.pitch));
  assert.ok(isFrontalPose(p));
});

test("poseFromFivePoints: nose displaced toward image-right → positive yaw; degenerate → null", () => {
  const f = frontal(); f.nose = [136, 125];
  assert.ok(poseFromFivePoints(f).yaw > 0.35);
  const bad = frontal(); bad.rightEye = [100, 100];
  assert.equal(poseFromFivePoints(bad), null);
});

test("poseActionVerdict: arrow-relative — turn_left (arrow preview-left, mirrored) expects +Δyaw; the opposite is wrongWay", () => {
  const base = { yaw: 0.1, pitch: 0.55 };
  const towardLeftArrow = { yaw: 0.1 + 0.45, pitch: 0.55 };  // nose to frame-right = preview-left
  const towardRightArrow = { yaw: 0.1 - 0.45, pitch: 0.55 };
  assert.equal(poseActionVerdict("turn_left", base, towardLeftArrow).ok, true);
  assert.equal(poseActionVerdict("turn_left", base, towardRightArrow).ok, false);
  assert.equal(poseActionVerdict("turn_left", base, towardRightArrow).wrongWay, true);
  assert.equal(poseActionVerdict("turn_right", base, towardRightArrow).ok, true);
  assert.equal(poseActionVerdict("turn_right", base, towardLeftArrow).wrongWay, true);
  // non-mirrored preview flips both
  assert.equal(poseActionVerdict("turn_left", base, towardRightArrow, undefined, false).ok, true);
});

test("poseActionVerdict: look_up = pitch DROP; noise-floor movement does not trigger", () => {
  const base = { yaw: 0.0, pitch: 0.55 };
  assert.equal(poseActionVerdict("look_up", base, { yaw: 0, pitch: 0.15 }).ok, true);
  assert.equal(poseActionVerdict("look_up", base, { yaw: 0, pitch: 0.9 }).wrongWay, true);
  const jitter = poseActionVerdict("turn_left", base, { yaw: -0.08, pitch: 0.55 });
  assert.equal(jitter.ok, false);
  assert.equal(jitter.wrongWay, false);
  assert.ok(jitter.magnitude < POSE_THRESHOLDS.yaw);
});

test("createPoseSmoother: a single-tick spike does not pass the median", () => {
  const s = createPoseSmoother(3);
  s.push({ yaw: 0.1, pitch: 0.5 }); s.push({ yaw: 0.1, pitch: 0.5 });
  const spiked = s.push({ yaw: 0.9, pitch: 0.5 });
  assert.ok(Math.abs(spiked.yaw - 0.1) < 1e-9);
});

test("createActionDetector: pose channel triggers a turn after 2 consecutive smoothed ticks, with the box unchanged", () => {
  const box = { x1: 100, y1: 50, x2: 200, y2: 170 };
  const det = createActionDetector("turn_left", box);
  const f = (yaw) => ({ box, pose: { yaw, pitch: 0.55, interOcular: 40 } });
  // baseline learned from the first 2 samples
  det.update(f(0.1)); det.update(f(0.1));
  assert.equal(det.update(f(0.12)).triggered, false); // noise
  det.update(f(0.6)); det.update(f(0.6)); // need 3 in the window for median to move
  const st = det.update(f(0.62));
  assert.equal(st.poseOk, true);
  assert.equal(st.triggered, true);
});

test("createActionDetector: wrong-direction turn never triggers and reports wrongWay for coaching", () => {
  const box = { x1: 100, y1: 50, x2: 200, y2: 170 };
  const det = createActionDetector("turn_right", box);
  const f = (yaw) => ({ box, pose: { yaw, pitch: 0.55, interOcular: 40 } });
  det.update(f(0.0)); det.update(f(0.0));
  let st;
  for (let i = 0; i < 5; i++) st = det.update(f(0.5));
  assert.equal(st.triggered, false);
  assert.equal(st.wrongWay, true);
});

test("bestFaceBox (corners): pre-decoded boxes used as-is; whole-frame artifact ignored; largest plausible wins", () => {
  assert.equal(DETECT_CONFIG.boxFormat, "corners");
  const n = 4420;
  const loc = new Float32Array(n * 4), scores = new Float32Array(n * 2);
  loc.set([0.35, 0.15, 0.7, 0.75], 0); scores[1] = 0.95;     // real face
  loc.set([-0.1, -0.05, 0.95, 0.9], 4); scores[3] = 0.99;    // whole-frame artifact (partly outside)
  loc.set([0.05, 0.05, 0.2, 0.25], 8); scores[5] = 0.9;      // small background face
  const b = bestFaceBox({ loc, scores });
  assert.ok(b);
  assert.ok(Math.abs(b.x1 - 0.35 * 320) < 1 && Math.abs(b.y2 - 0.75 * 240) < 1, JSON.stringify(b));
});

test("denormalizeLandmarks + fivePoints round-trip a synthetic 68-point layout", () => {
  const raw = new Float32Array(136).fill(0.5);
  const lm = denormalizeLandmarks(raw, { x1: 10, y1: 20, x2: 110, y2: 120 });
  assert.equal(lm[0], 60); assert.equal(lm[1], 70);
  const p = fivePoints(lm);
  assert.deepEqual(p.nose, [60, 70]);
});
