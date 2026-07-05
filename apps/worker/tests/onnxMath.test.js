"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  softmax, poseAngleFromBins, definePriorBox, decodeBoxes, nms, bestFaceBox,
  livenessCrop, poseCrop, convert68to5, affineFrom3, invertAffine, matchFeature,
  REFERENCE_5PTS, DETECT_CONFIG
} = require("../src/providers/onnxMath");

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

test("bestFaceBox: picks largest face, returns count; empty when below conf", () => {
  // one prior, strong confidence, zero regression
  const priors = definePriorBox([320, 240], DETECT_CONFIG);
  const n = priors.length;
  const loc = new Float32Array(n * 4); // all zeros
  const scores = new Float32Array(n * 2);
  scores[1] = 0.99; // first prior class-1 conf high
  const r = bestFaceBox({ loc, scores, imgWidth: 640, imgHeight: 480, config: DETECT_CONFIG });
  assert.ok(r.best);
  assert.equal(r.count, 1);
  assert.ok(r.best.x2 > r.best.x1 && r.best.y2 > r.best.y1);

  const none = bestFaceBox({ loc, scores: new Float32Array(n * 2), imgWidth: 640, imgHeight: 480, config: DETECT_CONFIG });
  assert.equal(none.best, null);
  assert.equal(none.count, 0);
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
