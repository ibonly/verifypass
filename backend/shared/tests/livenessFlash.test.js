"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomFlashSequence, validFlashSequence, scoreFlashResponse, FLASH } = require("../src/livenessFlash");

const seq = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]];
const base = [120, 95, 80];
// skin under a flash: baseline + k·colour (+ a little global brightening + noise)
const skin = (k, noise = 0) => [base, ...seq.map((c, i) => c.map((v, ch) => base[ch] + k * v / 255 + 1.5 + noise * Math.sin(i * 3 + ch)))];

test("sequence generator: distinct palette colours; validator rejects malformed/duplicate", () => {
  const s = randomFlashSequence();
  assert.equal(s.length, FLASH.count);
  assert.ok(validFlashSequence(s));
  assert.equal(validFlashSequence([[255, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]]), false);
  assert.equal(validFlashSequence([[1, 2, 3], [0, 255, 0], [0, 0, 255], [255, 255, 255]]), false);
  assert.equal(validFlashSequence(seq.slice(0, 3)), false);
});

test("a real face answers the flash; a static screen/print does not; darkness is inconclusive", () => {
  const live = scoreFlashResponse(skin(12, 1), seq);
  assert.equal(live.ok, true);
  assert.ok(live.score > 0.8, `score ${live.score}`);
  // replay: tiles differ only by noise / a uniform brightening
  const flat = scoreFlashResponse([base, ...seq.map((_, i) => base.map((v) => v + 4 + (i % 2)))], seq);
  assert.equal(flat.ok, false);
  assert.equal(flat.reason, "no_response");
  // a face already saturated by daylight cannot show the flash → inconclusive
  const bright = [230, 226, 222];
  const day = scoreFlashResponse([bright, ...seq.map(() => bright.map((v) => v + 0.5))], seq);
  assert.equal(day.ok, null);
  assert.equal(day.reason, "too_bright");
  // wrong sequence answered (a pre-rendered video showing a different flash order)
  const shuffled = [seq[2], seq[3], seq[0], seq[1]];
  const wrong = scoreFlashResponse(skin(12), shuffled);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, "wrong_response");
});

test("malformed tile sets are inconclusive", () => {
  assert.equal(scoreFlashResponse([base], seq).ok, null);
  assert.equal(scoreFlashResponse(null, seq).reason, "malformed");
});
