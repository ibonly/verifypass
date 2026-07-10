"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { laplacianVariance, meanBrightness, frameMotion, assessFrame, toGrayscale } = require("../src/quality");

/** Build ImageData-like object from a pixel fn (x,y) → gray 0-255. */
function synth(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = fn(x, y);
      const p = (y * width + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = v;
      data[p + 3] = 255;
    }
  }
  return { data, width, height };
}

const flat = (v) => synth(64, 64, () => v);
const checkerboard = synth(64, 64, (x, y) => ((x + y) % 2 ? 255 : 0));
const noise = synth(64, 64, () => Math.floor(Math.random() * 256));

test("flat image has ~zero sharpness; checkerboard is very sharp", () => {
  assert.ok(laplacianVariance(flat(128)) < 1);
  assert.ok(laplacianVariance(checkerboard) > 1000);
});

test("meanBrightness reflects pixel values", () => {
  assert.ok(Math.abs(meanBrightness(flat(0)) - 0) < 1);
  assert.ok(Math.abs(meanBrightness(flat(255)) - 255) < 1);
  assert.ok(Math.abs(meanBrightness(flat(100)) - 100) < 1);
});

test("assessFrame flags blur on flat mid-gray image", () => {
  const r = assessFrame(flat(128));
  assert.equal(r.ok, false);
  assert.ok(r.issues.includes("DOCUMENT_BLURRY"));
  assert.equal(r.issues.includes("TOO_DARK"), false);
});

test("assessFrame flags darkness and brightness", () => {
  assert.ok(assessFrame(flat(10)).issues.includes("TOO_DARK"));
  assert.ok(assessFrame(flat(250)).issues.includes("TOO_BRIGHT"));
});

test("assessFrame passes sharp, well-lit image", () => {
  const r = assessFrame(noise); // random noise: sharp, mean ~127
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.metrics.sharpness > 40);
});

test("custom rules are respected", () => {
  const r = assessFrame(checkerboard, { minBrightness: 200 });
  assert.ok(r.issues.includes("TOO_DARK")); // mean ~127 < 200
});

test("frameMotion: identical frames → 0, different frames → large", () => {
  const a = toGrayscale(flat(100));
  const b = toGrayscale(flat(100));
  const c = toGrayscale(flat(200));
  assert.equal(frameMotion(a, b), 0);
  assert.ok(Math.abs(frameMotion(a, c) - 100) < 1); // ~|200-100|
});
