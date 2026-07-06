"use strict";

// Document-capture gate: "change-then-steady".
//
// The document step has no detector model, and a bare steadiness check
// captures an EMPTY scene the moment the camera settles. This gate requires
// an actual capture event:
//   1. arm     — average the first N frames into an "empty scene" baseline
//   2. present — the current frame must differ from that baseline by a
//                sustained margin (the ID entering the frame changes a large
//                region of pixels)
//   3. steady  — inter-frame motion back at the noise floor (ID held still)
// ready = present AND steady. Removing the document resets presence.

const { frameMotion } = require("./quality");

const DEFAULTS = Object.freeze({
  baselineFrames: 8,      // frames averaged into the empty-scene baseline
  presenceThreshold: 12,  // mean |Δgray| vs baseline that counts as "something entered"
  presenceNeed: 3,        // consecutive present frames (a hand passing by isn't a document)
  steadyDelta: 3,         // inter-frame motion above noise floor still counted steady
  historySize: 20
});

function createDocumentGate(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  let baseline = null;
  let baseCount = 0;
  let prev = null;
  const motions = [];
  let presentStreak = 0;

  return {
    /**
     * @param {Float32Array} gray downscaled grayscale frame (same size each call)
     * @param {number} [w] frame width — when given (with h), ready ALSO
     *   requires the change-region to be card-shaped (assessDocumentShape)
     * @param {number} [h] frame height
     * @returns {{armed, present, steady, ready, shape, presenceDiff, motion}}
     */
    update(gray, w, h) {
      if (!gray) return { armed: baseCount >= cfg.baselineFrames, present: false, steady: false, ready: false, presenceDiff: 0, motion: 0 };

      // Phase 1: learn the empty scene
      if (baseCount < cfg.baselineFrames) {
        if (!baseline) {
          baseline = Float32Array.from(gray);
        } else {
          for (let i = 0; i < baseline.length; i++) {
            baseline[i] = (baseline[i] * baseCount + gray[i]) / (baseCount + 1);
          }
        }
        baseCount++;
        prev = gray;
        return { armed: false, present: false, steady: false, ready: false, presenceDiff: 0, motion: 0 };
      }

      const presenceDiff = frameMotion(baseline, gray);
      const motion = prev ? frameMotion(prev, gray) : 0;
      prev = gray;
      motions.push(motion);
      if (motions.length > cfg.historySize) motions.shift();
      const noiseFloor = motions.length >= 8 ? Math.min(...motions) : 0;

      presentStreak = presenceDiff >= cfg.presenceThreshold ? presentStreak + 1 : 0;
      const present = presentStreak >= cfg.presenceNeed;
      const steady = motions.length >= 8 && motion <= noiseFloor + cfg.steadyDelta;

      // With frame dims the gate is FAIL-CLOSED on shape: something present
      // and steady that is NOT card-shaped (a person, a hand, a wall) never
      // becomes ready. Without dims it degrades to change-then-steady.
      const shapeChecked = w > 0 && h > 0;
      const shape = shapeChecked && present ? assessDocumentShape(baseline, gray, w, h, cfg.shape) : null;
      const ready = present && steady && (!shapeChecked || (shape !== null && shape.cardLike));

      return { armed: true, present, steady, ready, shape, presenceDiff, motion };
    }
  };
}

// ---------------------------------------------------------------------------
// Positive document-shape detection.
//
// Blocking on "no dominant face detected" is FAIL-OPEN: any detector miss
// (off-center face, too close, profile view) lets a person be photographed as
// an "ID". Commercial capture SDKs gate the shutter the other way round: they
// require a stable card-shaped region to be POSITIVELY present. This is the
// dependency-free version of that check. Using the same empty-scene baseline
// as the gate, the changed-pixel mask must form a solid region whose
// boundaries are STRAIGHT LINES (linear-fit residual, so tilted cards pass) —
// faces and torsos have curved silhouettes and never do.
// ---------------------------------------------------------------------------

const SHAPE_DEFAULTS = Object.freeze({
  pixelDiff: 26,        // per-pixel |Δgray| vs baseline that marks an object pixel
  occupancyFrac: 0.05,  // row/col occupancy (of frame dim) to join the bounding box
  minWidthFrac: 0.25,   // card must span 25–98% of frame width…
  maxWidthFrac: 0.98,
  minHeightFrac: 0.16,  // …and 16–95% of frame height
  maxHeightFrac: 0.95,
  minFill: 0.45,        // region area / bbox area — cards are solid rectangles
                        // (hand + forearm join the region, diluting fill)
  bandFrac: 0.6,        // middle band of the bbox used for edge straightness
  maxEdgeDev: 0.055,    // max linear-fit residual stdev / bbox dim for "straight"
  interiorMargin: 2,    // edges glued to the frame border are trivially straight — ignore
  minStraightEdges: 2   // a hand grips one edge; the frame may cut another
});

/** Residual stdev after a least-squares line fit (straight edge ⇒ ~0, curve ⇒ large). */
function lineFitDev(positions) {
  const n = positions.length;
  if (n < 6) return Infinity;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += positions[i]; sxx += i * i; sxy += i * positions[i]; }
  const denom = n * sxx - sx * sx;
  const b = denom ? (n * sxy - sx * sy) / denom : 0;
  const a = (sy - b * sx) / n;
  let ss = 0;
  for (let i = 0; i < n; i++) { const r = positions[i] - (a + b * i); ss += r * r; }
  return Math.sqrt(ss / n);
}

/**
 * Does the change-region (current frame vs empty-scene baseline) look like a
 * CARD — a solid region with straight, card-sized boundaries?
 * @param {Float32Array} baseline empty-scene grayscale
 * @param {Float32Array} gray current grayscale (same dims)
 * @returns {{found, cardLike, widthFrac, heightFrac, fill, straightEdges}}
 */
function assessDocumentShape(baseline, gray, w, h, opts = {}) {
  const cfg = { ...SHAPE_DEFAULTS, ...opts };
  const res = { found: false, cardLike: false, widthFrac: 0, heightFrac: 0, fill: 0, straightEdges: 0 };
  if (!baseline || !gray || baseline.length !== gray.length || w * h !== gray.length) return res;

  const rowFirst = new Int16Array(h).fill(-1);
  const rowLast = new Int16Array(h).fill(-1);
  const colFirst = new Int16Array(w).fill(-1);
  const colLast = new Int16Array(w).fill(-1);
  const rowCount = new Int32Array(h);
  const colCount = new Int32Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (Math.abs(gray[i] - baseline[i]) >= cfg.pixelDiff) {
        rowCount[y]++; colCount[x]++;
        if (rowFirst[y] < 0) rowFirst[y] = x;
        rowLast[y] = x;
        if (colFirst[x] < 0) colFirst[x] = y;
        colLast[x] = y;
      }
    }
  }

  const rowNeed = Math.max(2, Math.round(w * cfg.occupancyFrac));
  const colNeed = Math.max(2, Math.round(h * cfg.occupancyFrac));
  let y1 = -1, y2 = -1, x1 = -1, x2 = -1, area = 0;
  for (let y = 0; y < h; y++) if (rowCount[y] >= rowNeed) { if (y1 < 0) y1 = y; y2 = y; area += rowCount[y]; }
  for (let x = 0; x < w; x++) if (colCount[x] >= colNeed) { if (x1 < 0) x1 = x; x2 = x; }
  if (y1 < 0 || x1 < 0) return res;

  const bw = x2 - x1 + 1;
  const bh = y2 - y1 + 1;
  res.found = true;
  res.widthFrac = bw / w;
  res.heightFrac = bh / h;
  res.fill = area / (bw * bh);

  // Boundary straightness over the middle band (corners + grip excluded).
  const pad = (1 - cfg.bandFrac) / 2;
  const lefts = [], rights = [], tops = [], bottoms = [];
  for (let y = Math.round(y1 + bh * pad); y <= Math.round(y2 - bh * pad); y++) {
    if (rowFirst[y] >= 0) { lefts.push(rowFirst[y]); rights.push(rowLast[y]); }
  }
  for (let x = Math.round(x1 + bw * pad); x <= Math.round(x2 - bw * pad); x++) {
    if (colFirst[x] >= 0) { tops.push(colFirst[x]); bottoms.push(colLast[x]); }
  }
  const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
  const devs = [];
  // Only INTERIOR edges count — a silhouette cut off by the frame border is
  // trivially straight there (a torso filling the bottom must not score).
  if (lefts.length && mean(lefts) > cfg.interiorMargin) devs.push(lineFitDev(lefts) / bw);
  if (rights.length && mean(rights) < w - 1 - cfg.interiorMargin) devs.push(lineFitDev(rights) / bw);
  if (tops.length && mean(tops) > cfg.interiorMargin) devs.push(lineFitDev(tops) / bh);
  if (bottoms.length && mean(bottoms) < h - 1 - cfg.interiorMargin) devs.push(lineFitDev(bottoms) / bh);
  res.straightEdges = devs.filter((d) => d <= cfg.maxEdgeDev).length;

  const sizeOk = res.widthFrac >= cfg.minWidthFrac && res.widthFrac <= cfg.maxWidthFrac
    && res.heightFrac >= cfg.minHeightFrac && res.heightFrac <= cfg.maxHeightFrac;
  res.cardLike = sizeOk && res.fill >= cfg.minFill && res.straightEdges >= cfg.minStraightEdges;
  return res;
}

/**
 * Is a detected face DOMINANT — a live person (or a photo of one) rather than
 * the small printed portrait on an ID card?
 * When the document region's width is known, the RELATIVE rule applies: a
 * real ID's portrait is ≲30% of the card's width, while a photo/selfie
 * presented as a "document" is mostly face. Without a document region, an
 * absolute fraction of the full frame applies.
 */
function isDominantFace(box, frameWidth, { minRatio = 0.18, docWidthPx = 0, docFrac = 0.45 } = {}) {
  if (!box || !(frameWidth > 0)) return false;
  const faceW = box.x2 - box.x1;
  if (docWidthPx > 0) return faceW >= docWidthPx * docFrac;
  return faceW / frameWidth >= minRatio;
}

module.exports = {
  createDocumentGate,
  assessDocumentShape,
  lineFitDev,
  isDominantFace,
  DOCUMENT_GATE_DEFAULTS: DEFAULTS,
  DOCUMENT_SHAPE_DEFAULTS: SHAPE_DEFAULTS
};
