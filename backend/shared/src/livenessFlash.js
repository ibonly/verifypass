"use strict";

// Screen-flash (active illumination) liveness — roadmap Tier 1.1, zero run-cost.
//
// The widget flashes the screen with a short RANDOM colour sequence right
// after the selfie and captures a small face crop under each colour plus a
// dark baseline, tiled into one mosaic JPEG (baseline first, then one tile per
// colour). Skin a few centimetres from a phone screen reflects the flash: the
// crop's mean colour shifts in the direction of the emitted colour. A screen
// replay or a print (or a video that is not rendered in real time) cannot
// answer a sequence it does not know.
//
// Scoring is a plain correlation: per colour tile, response = mean RGB minus
// the baseline mean; emitted = colour − mean of the sequence. Pearson
// correlation across the 3·n values (both zero-meaned per channel) → score in
// [−1, 1]; magnitude = mean ‖response − mean response‖ (0–255 scale) — the
// colour variation between tiles, with any global brightening removed. No model.
//
// Calibration (record-first): ship recording only; enforce via
// CHALLENGE_ENFORCE_FLASH once genuine sessions cluster (score ≳ 0.6 at
// magnitude ≳ 4 on phones in dim rooms). A face already lit to saturation by
// daylight is *inconclusive*, never a fail; a dim face with no colour response
// is a screen or print (or a phone held too far away — the copy says
// "hold the phone close").

const FLASH = Object.freeze({
  palette: [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255], [255, 0, 255], [0, 255, 255], [255, 255, 0]],
  count: 4,          // colours per sequence (distinct)
  minScore: 0.5,     // correlation at/above this = the face answered the flash
  minMagnitude: 3,   // colour variation below this = the face did not answer (no_response)
  maxBaselineLuma: 200, // baseline brighter than this (daylight) → inconclusive
  tile: 160          // px, square tiles in the mosaic (96 was too small for the per-tile identity check)
});

/** n distinct palette colours; rng() in [0,1). */
function randomFlashSequence(n = FLASH.count, rng = Math.random, palette = FLASH.palette) {
  const pool = palette.map((c) => c.slice());
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  return out;
}

/** Is a client-reported sequence well-formed (count, palette membership, distinct)? */
function validFlashSequence(seq, opts = FLASH) {
  if (!Array.isArray(seq) || seq.length !== opts.count) return false;
  const seen = new Set();
  for (const c of seq) {
    if (!Array.isArray(c) || c.length !== 3 || !c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) return false;
    const k = c.join(",");
    if (!opts.palette.some((p) => p.join(",") === k) || seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

function pearson(a, b) {
  const n = a.length;
  if (!n || n !== b.length) return 0;
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  if (!(da > 0) || !(db > 0)) return 0;
  return num / Math.sqrt(da * db);
}

/**
 * @param {number[][]} tileMeans mean [r,g,b] per tile: index 0 = baseline, then one per colour
 * @param {number[][]} sequence  emitted colours, same order as tiles 1..n
 * @returns {{ok:boolean|null, score:number, magnitude:number, tiles:number, reason:string}}
 *   ok === null → inconclusive (too little light); never treated as a failure.
 */
function scoreFlashResponse(tileMeans, sequence, opts = FLASH) {
  if (!Array.isArray(tileMeans) || !Array.isArray(sequence) || tileMeans.length !== sequence.length + 1 || sequence.length < 2) {
    return { ok: null, score: 0, magnitude: 0, tiles: Array.isArray(tileMeans) ? tileMeans.length : 0, reason: "malformed" };
  }
  const base = tileMeans[0];
  const resp = [], emit = [];
  let mag = 0;
  for (let i = 0; i < sequence.length; i++) {
    const m = tileMeans[i + 1];
    const r = [m[0] - base[0], m[1] - base[1], m[2] - base[2]];
    mag += Math.hypot(r[0], r[1], r[2]);
    resp.push(r); emit.push(sequence[i].map((v) => v / 255));
  }
  mag /= sequence.length;
  // zero-mean per channel so a global brightness change (the screen getting
  // brighter for every colour) does not masquerade as a colour response
  const a = [], b = [];
  const rm = [0, 1, 2].map((ch) => resp.reduce((s, r) => s + r[ch], 0) / resp.length);
  for (let ch = 0; ch < 3; ch++) {
    const em = emit.reduce((s, e) => s + e[ch], 0) / emit.length;
    for (let i = 0; i < resp.length; i++) { a.push(resp[i][ch] - rm[ch]); b.push(emit[i][ch] - em); }
  }
  const score = pearson(a, b);
  // magnitude of the COLOUR variation between tiles (global brightening removed)
  mag = resp.reduce((s, r) => s + Math.hypot(r[0] - rm[0], r[1] - rm[1], r[2] - rm[2]), 0) / resp.length;
  const out = (ok, reason) => ({ ok, score: Number(score.toFixed(3)), magnitude: Number(mag.toFixed(2)), tiles: tileMeans.length, reason });
  // a face already lit to near-saturation (daylight) cannot show a phone
  // screen's flash — inconclusive, never a failure
  const baseLum = 0.299 * base[0] + 0.587 * base[1] + 0.114 * base[2];
  if (baseLum > opts.maxBaselineLuma) return out(null, "too_bright");
  if (mag < opts.minMagnitude) return out(false, "no_response");
  return out(score >= opts.minScore, score >= opts.minScore ? "responded" : "wrong_response");
}

module.exports = { FLASH, randomFlashSequence, validFlashSequence, scoreFlashResponse, pearson };
