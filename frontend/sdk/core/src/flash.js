"use strict";

// Screen-flash (active illumination) capture helpers. Pure + testable; the
// widget does the DOM part (a full-screen colour overlay) and the canvas
// tiling. Mirrors backend/shared/src/livenessFlash.js.
//
// Sequence: a dark baseline, then `count` DISTINCT palette colours. Each
// colour is shown for holdMs; the face tile is sampled sampleDelayMs after
// the switch (display latency + camera exposure/auto-exposure lag).

const FLASH = Object.freeze({
  palette: [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255], [255, 0, 255], [0, 255, 255], [255, 255, 0]],
  count: 4,
  holdMs: 280,
  sampleDelayMs: 190,
  baseline: [24, 24, 24],
  tile: 160
});

/** n distinct palette colours; rng() in [0,1). */
function randomFlashSequence(n = FLASH.count, rng = Math.random, palette = FLASH.palette) {
  const pool = palette.map((c) => c.slice());
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  return out;
}

/** Square crop rect (in frame pixels) around a face box, padded and clamped. */
function flashCropRect(box, frameW, frameH, pad = 0.1) {
  if (!box) return null;
  const bw = box.x2 - box.x1, bh = box.y2 - box.y1;
  const side = Math.max(bw, bh) * (1 + 2 * pad);
  const cx = (box.x1 + box.x2) / 2, cy = (box.y1 + box.y2) / 2;
  const s = Math.min(side, frameW, frameH);
  const x = Math.max(0, Math.min(frameW - s, cx - s / 2));
  const y = Math.max(0, Math.min(frameH - s, cy - s / 2));
  return { x, y, size: s };
}

/** Mean [r,g,b] of an RGBA ImageData (whole image). */
function meanRgb(imageData) {
  const d = imageData.data;
  let r = 0, g = 0, b = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  return [r / n, g / n, b / n];
}

module.exports = { FLASH, randomFlashSequence, flashCropRect, meanRgb };
