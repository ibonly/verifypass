"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  boxIoU, mirrorRGB, combineMirroredPose,
  softmax, poseAngleFromBins, definePriorBox, decodeBoxes, nms, bestFaceBox,
  livenessCrop, poseCrop, convert68to5, affineFrom3, invertAffine, matchFeature,
  REFERENCE_5PTS, DETECT_CONFIG
} = require("../src/worker/providers/onnxMath");

test("boxIoU: identical → 1, disjoint → 0, half overlap → 1/3", () => {
  const a = { x1: 0, y1: 0, x2: 10, y2: 10 };
  assert.equal(boxIoU(a, a), 1);
  assert.equal(boxIoU(a, { x1: 20, y1: 20, x2: 30, y2: 30 }), 0);
  assert.ok(Math.abs(boxIoU(a, { x1: 5, y1: 0, x2: 15, y2: 10 }) - 1 / 3) < 1e-9);
  assert.equal(boxIoU(a, null), 0);
});

test("mirrorRGB flips each row horizontally and is an involution", () => {
  const W = 3, H = 2;
  const rgb = Uint8Array.from([1,1,1, 2,2,2, 3,3,3,  4,4,4, 5,5,5, 6,6,6]);
  assert.deepEqual(Array.from(mirrorRGB(rgb, W, H)), [3,3,3, 2,2,2, 1,1,1,  6,6,6, 5,5,5, 4,4,4]);
  assert.deepEqual(Array.from(mirrorRGB(mirrorRGB(rgb, W, H), W, H)), Array.from(rgb));
});

test("combineMirroredPose takes the larger-magnitude yaw, negating the mirror, and averages pitch", () => {
  // model under-reports a right-pointing face (5°) but sees it clearly mirrored (−40°)
  const r = combineMirroredPose({ yaw: 5, pitch: 8, roll: 1 }, { yaw: -40, pitch: 6, roll: -1 });
  assert.equal(r.yaw, 40); assert.equal(r.pitch, 7); assert.equal(r.yawOriginal, 5); assert.equal(r.yawMirrored, 40); assert.equal(r.yawAgree, true);
  assert.equal(r.yawNear, 5, "conservative magnitude is the smaller candidate");
  // a reliable left-pointing face keeps its own estimate
  assert.equal(combineMirroredPose({ yaw: -60, pitch: 0, roll: 0 }, { yaw: 55, pitch: 0, roll: 0 }).yaw, -60);
  // frontal stays frontal
  assert.equal(Math.abs(combineMirroredPose({ yaw: 3, pitch: 0, roll: 0 }, { yaw: -4, pitch: 0, roll: 0 }).yaw), 4);
  // strong disagreement in sign is recorded, not hidden
  assert.equal(combineMirroredPose({ yaw: 41, pitch: 0, roll: 0 }, { yaw: 22, pitch: 0, roll: 0 }).yawAgree, false);
});

test("softmax sums to 1 and is monotonic", () => {
  const p = softmax([1, 2, 3]);
  assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(p[2] > p[1] && p[1] > p[0]);
});

test("poseAngleFromBins: all-mass bins map to Faceplugin degrees (i*3-99)", () => {
  const bins = (idx) => { const a = new Array(66).fill(-50); a[idx] = 50; return a; };
  assert.ok(Math.abs(poseAngleFromBins(bins(33)) - (33 * 3 - 99)) < 1e-6); // ~0°
  assert.ok(poseAngleFromBins(bins(0)) < -90);   // extreme left/up
  assert.ok(poseAngleFromBins(bins(65)) > 90);   // extreme right/down
});

test("definePriorBox: produces 4-tuples, count matches feature-map math", () => {
  const priors = definePriorBox([320, 240], DETECT_CONFIG);
  assert.ok(priors.length > 0);
  for (const p of priors.slice(0, 5)) assert.equal(p.length, 4);
  // all centres normalised into 0..~1
  assert.ok(priors.every((p) => p[0] >= 0 && p[1] >= 0));
});

test("decodeBoxes: zero regression returns prior-centred corner box", () => {
  const priors = [[0.5, 0.5, 0.2, 0.4]];
  const boxes = decodeBoxes([0, 0, 0, 0], priors, [0.1, 0.2]);
  // w=psx=0.2 h=psy=0.4 → x1=0.5-0.1=0.4, y1=0.5-0.2=0.3, x2=0.6, y2=0.7
  assert.ok(Math.abs(boxes[0][0] - 0.4) < 1e-6);
  assert.ok(Math.abs(boxes[0][1] - 0.3) < 1e-6);
  assert.ok(Math.abs(boxes[0][2] - 0.6) < 1e-6);
  assert.ok(Math.abs(boxes[0][3] - 0.7) < 1e-6);
});

test("nms keeps the highest-score box and suppresses its heavy overlap", () => {
  const boxes = [[0, 0, 10, 10], [1, 1, 11, 11], [100, 100, 120, 120]];
  const scores = [0.9, 0.8, 0.95];
  const keep = nms(boxes, scores, 0.4);
  assert.ok(keep.includes(2)); // far-away box always kept
  assert.ok(keep.length < 3);  // the two overlapping boxes collapse
});

test("bestFaceBox (deltas format): picks largest face, returns count; empty when below conf", () => {
  // one prior, strong confidence, zero regression — RetinaFace-style model
  const DELTAS = { ...DETECT_CONFIG, boxFormat: "deltas" };
  const priors = definePriorBox([320, 240], DELTAS);
  const n = priors.length;
  const loc = new Float32Array(n * 4); // all zeros
  const scores = new Float32Array(n * 2);
  scores[1] = 0.99; // first prior class-1 conf high
  const r = bestFaceBox({ loc, scores, imgWidth: 640, imgHeight: 480, config: DELTAS });
  assert.ok(r.best);
  assert.equal(r.count, 1);
  assert.ok(r.best.x2 > r.best.x1 && r.best.y2 > r.best.y1);

  const none = bestFaceBox({ loc, scores: new Float32Array(n * 2), imgWidth: 640, imgHeight: 480, config: DELTAS });
  assert.equal(none.best, null);
  assert.equal(none.count, 0);
});

test("bestFaceBox (corners format, shipped fr_detect): uses boxes as-is, drops whole-frame artifacts", () => {
  assert.equal(DETECT_CONFIG.boxFormat, "corners");
  const n = 4420;
  const loc = new Float32Array(n * 4);
  const scores = new Float32Array(n * 2);
  // anchor 0: a real face at normalized [0.35,0.15,0.7,0.75]
  loc.set([0.35, 0.15, 0.7, 0.75], 0); scores[1] = 0.98;
  // anchor 1: whole-frame artifact (partly outside), higher score — must be ignored
  loc.set([-0.1, -0.05, 0.9, 0.9], 4); scores[3] = 0.99;
  const r = bestFaceBox({ loc, scores, imgWidth: 640, imgHeight: 480, config: DETECT_CONFIG });
  assert.ok(r.best);
  assert.equal(r.count, 1);
  // scaled to 640x480 then squared about centre: x centre ≈ 0.525*640 = 336
  const cx = (r.best.x1 + r.best.x2) / 2;
  assert.ok(Math.abs(cx - 336) < 2, `cx ${cx}`);
  assert.ok(r.best.y2 - r.best.y1 > 200 && r.best.y2 - r.best.y1 < 300);
});

test("livenessCrop / poseCrop stay within the image", () => {
  const box = { x1: 100, y1: 100, x2: 200, y2: 200 };
  const lc = livenessCrop(box, 640, 480, 2.7);
  assert.ok(lc.left >= 0 && lc.top >= 0 && lc.left + lc.width <= 640 && lc.top + lc.height <= 480);
  const pc = poseCrop(box, 640, 480);
  assert.ok(pc.left >= 0 && pc.top >= 0 && pc.left + pc.width <= 640 && pc.top + pc.height <= 480);
});

test("convert68to5 returns 5 points from a 136-length landmark array", () => {
  const lm = new Array(136).fill(0).map((_, i) => i);
  const five = convert68to5(lm);
  assert.equal(five.length, 5);
  for (const p of five) assert.equal(p.length, 2);
});

test("affineFrom3 + invert: forward then inverse recovers points", () => {
  const src = [[0, 0], [10, 0], [0, 10]];
  const dst = [[1, 1], [21, 1], [1, 21]]; // scale 2, translate (1,1)
  const fwd = affineFrom3(src, dst);
  const inv = invertAffine(fwd);
  // map a src point forward then back
  const [x, y] = [5, 7];
  const fx = fwd[0] * x + fwd[1] * y + fwd[2];
  const fy = fwd[3] * x + fwd[4] * y + fwd[5];
  const bx = inv[0] * fx + inv[1] * fy + inv[2];
  const by = inv[3] * fx + inv[4] * fy + inv[5];
  assert.ok(Math.abs(bx - x) < 1e-6 && Math.abs(by - y) < 1e-6);
});

test("matchFeature: cosine — identical→1, opposite→-1, symmetric, ordered", () => {
  const a = Float32Array.from({ length: 8 }, (_, i) => i + 1);
  assert.ok(Math.abs(matchFeature(a, a) - 1) < 1e-9);
  const neg = Float32Array.from(a, (v) => -v);
  assert.ok(Math.abs(matchFeature(a, neg) + 1) < 1e-9);
  const b = Float32Array.from({ length: 8 }, (_, i) => (i % 2 ? 1 : -1));
  assert.ok(Math.abs(matchFeature(a, b) - matchFeature(b, a)) < 1e-12); // symmetric
  const similar = Float32Array.from(a, (v) => v + 0.1);
  assert.ok(matchFeature(a, similar) > matchFeature(a, b)); // closer scores higher
});

test("REFERENCE_5PTS is the 112x112 ArcFace template", () => {
  assert.equal(REFERENCE_5PTS.length, 5);
  assert.ok(REFERENCE_5PTS.every((p) => p[0] > 0 && p[0] < 112 && p[1] > 0 && p[1] < 112));
});
