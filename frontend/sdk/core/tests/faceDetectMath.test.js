"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { assessFraming, DETECT_CONFIG } = require("../src/faceDetectMath");

const [W, H] = DETECT_CONFIG.inputSize; // 320 x 240

function boxFromRatio(ratio, cx = 0.5, cy = 0.5) {
  const w = ratio * W;
  const h = w; // square-ish face
  return { x1: cx * W - w / 2, y1: cy * H - h / 2, x2: cx * W + w / 2, y2: cy * H + h / 2, score: 0.95 };
}

test("assessFraming: no box → no_face, not in frame", () => {
  const r = assessFraming(null);
  assert.equal(r.present, false);
  assert.equal(r.inFrame, false);
  assert.equal(r.guide, "no_face");
});

test("assessFraming: small face → move_closer", () => {
  const r = assessFraming(boxFromRatio(0.2));
  assert.equal(r.guide, "move_closer");
  assert.equal(r.inFrame, false);
});

test("assessFraming: huge face → move_back", () => {
  const r = assessFraming(boxFromRatio(0.9));
  assert.equal(r.guide, "move_back");
  assert.equal(r.inFrame, false);
});

test("assessFraming: off-centre face → center", () => {
  const r = assessFraming(boxFromRatio(0.5, 0.85, 0.5));
  assert.equal(r.guide, "center");
  assert.equal(r.inFrame, false);
});

test("assessFraming: well-sized, centred face → ok / inFrame", () => {
  const r = assessFraming(boxFromRatio(0.5, 0.5, 0.5));
  assert.equal(r.guide, "ok");
  assert.equal(r.inFrame, true);
  assert.equal(r.present, true);
});

test("assessFraming: low-confidence box is treated as no face", () => {
  const r = assessFraming({ ...boxFromRatio(0.5, 0.5, 0.5), score: 0.5 });
  assert.equal(r.guide, "no_face");
  assert.equal(r.inFrame, false);
  assert.equal(r.present, false);
});

test("assessFraming: a detection-threshold face is accepted (not over-gated)", () => {
  const r = assessFraming({ ...boxFromRatio(0.5, 0.5, 0.5), score: 0.7 });
  assert.equal(r.guide, "ok");
  assert.equal(r.inFrame, true);
});
