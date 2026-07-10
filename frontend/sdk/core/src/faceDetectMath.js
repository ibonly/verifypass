"use strict";

// Browser-safe face-detection math (RetinaFace priorbox + decode + NMS),
// ported from Faceplugin's fr_detect post-processing. Pure functions only —
// no Node or DOM deps — so the same logic runs in the browser detector and is
// unit-testable. Mirrors backend/src/worker/providers/onnxMath.js.

const DETECT_CONFIG = Object.freeze({
  inputSize: [320, 240], // [W, H]
  minSizes: [[10, 16, 24], [32, 48], [64, 96], [128, 192, 256]],
  steps: [8, 16, 32, 64],
  variance: [0.1, 0.2],
  confidenceThreshold: 0.65,
  topK: 750,
  nmsThreshold: 0.4
});

function definePriorBox(imageSize, config) {
  const [W, H] = imageSize; // W = width (320), H = height (240)
  const { minSizes, steps } = config;
  const anchors = [];
  steps.forEach((step, k) => {
    // Feature-map grid is rows over HEIGHT and cols over WIDTH (RetinaFace
    // image_size = [height, width]). Iterating in this order makes anchor[n]
    // line up with the model's flat output[n]; the previous swap compressed
    // detections to the left/top of the frame.
    const fmRows = Math.ceil(H / step);
    const fmCols = Math.ceil(W / step);
    for (let i = 0; i < fmRows; i++) {
      for (let j = 0; j < fmCols; j++) {
        for (const mSize of minSizes[k]) {
          anchors.push([((j + 0.5) * step) / W, ((i + 0.5) * step) / H, mSize / W, mSize / H]);
        }
      }
    }
  });
  return anchors;
}

function decodeBoxes(loc, priors, variance) {
  const out = [];
  for (let n = 0; n < priors.length; n++) {
    const [pcx, pcy, psx, psy] = priors[n];
    const lx = loc[n * 4], ly = loc[n * 4 + 1], lw = loc[n * 4 + 2], lh = loc[n * 4 + 3];
    const cx = pcx + lx * psx * variance[0];
    const cy = pcy + ly * psy * variance[0];
    const w = Math.exp(lw * variance[1]) * psx;
    const h = Math.exp(lh * variance[1]) * psy;
    const x1 = cx - w / 2;
    const y1 = cy - h / 2;
    out.push([x1, y1, x1 + w, y1 + h]);
  }
  return out;
}

function nms(boxes, scores, thresh) {
  const items = [];
  for (let i = 0; i < boxes.length; i++) {
    const [x1, y1, x2, y2] = boxes[i];
    const w = x2 - x1, h = y2 - y1;
    if (w > 0 && h > 0) items.push({ x1, y1, x2, y2, area: w * h, index: i });
  }
  items.sort((a, b) => a.y2 - b.y2);
  const keep = [];
  let pool = items;
  while (pool.length > 0) {
    const last = pool[0];
    keep.push(last.index);
    const suppress = new Set([last]);
    for (let i = 1; i < pool.length; i++) {
      const box = pool[i];
      const xx1 = Math.max(box.x1, last.x1);
      const yy1 = Math.max(box.y1, last.y1);
      const xx2 = Math.min(box.x2, last.x2);
      const yy2 = Math.min(box.y2, last.y2);
      const w = Math.max(0, xx2 - xx1 + 1);
      const h = Math.max(0, yy2 - yy1 + 1);
      if ((w * h) / box.area >= thresh) suppress.add(pool[i]);
    }
    pool = pool.filter((b) => !suppress.has(b));
  }
  return keep;
}

/**
 * Best (largest) face box in the DETECTOR input space (0..W, 0..H), or null.
 * @returns {{x1,y1,x2,y2,score}|null}
 */
function bestFaceBox({ loc, scores, config = DETECT_CONFIG }) {
  const [W, H] = config.inputSize;
  const priors = definePriorBox([W, H], config);
  const decoded = decodeBoxes(loc, priors, config.variance);
  const kept = [];
  for (let i = 0; i < decoded.length; i++) {
    const conf = scores[i * 2 + 1];
    if (conf >= config.confidenceThreshold) {
      kept.push({ box: [decoded[i][0] * W, decoded[i][1] * H, decoded[i][2] * W, decoded[i][3] * H], score: conf });
    }
  }
  if (kept.length === 0) return null;
  kept.sort((a, b) => b.score - a.score);
  const top = kept.slice(0, config.topK);
  const keepIdx = nms(top.map((k) => k.box), top.map((k) => k.score), config.nmsThreshold);
  let best = null;
  for (const i of keepIdx) {
    const [x1, y1, x2, y2] = top[i].box;
    const area = (x2 - x1) * (y2 - y1);
    if (!best || area > best.area) best = { x1, y1, x2, y2, area, score: top[i].score };
  }
  return best;
}

/**
 * Turn a detected box into framing guidance for a circular face target.
 * @param {object|null} box bestFaceBox output (detector space)
 * @param {object} [opts] target ratios (face width / frame width)
 * @returns {{present, inFrame, guide, ratio, offset}}
 *   guide: "no_face" | "move_closer" | "move_back" | "center" | "ok"
 */
function assessFraming(box, opts = {}) {
  const [W, H] = DETECT_CONFIG.inputSize;
  const minRatio = opts.minRatio ?? 0.34; // face too small → move closer
  const maxRatio = opts.maxRatio ?? 0.8; // face too big → move back
  const centerTol = opts.centerTol ?? 0.11; // fraction of frame allowed off-center
  // Detection already filters by DETECT_CONFIG.confidenceThreshold, so any box
  // reaching here is a real detection. Only reject clearly weak scores; a
  // higher floor here was rejecting genuine, well-framed faces.
  const minScore = opts.minScore ?? DETECT_CONFIG.confidenceThreshold;

  if (!box) return { present: false, inFrame: false, guide: "no_face", ratio: 0, offset: 1 };
  if (typeof box.score === "number" && box.score < minScore) {
    return { present: false, inFrame: false, guide: "no_face", ratio: 0, offset: 1, score: box.score };
  }
  const ratio = (box.x2 - box.x1) / W;
  const cx = (box.x1 + box.x2) / 2 / W;
  const cy = (box.y1 + box.y2) / 2 / H;
  const offset = Math.hypot(cx - 0.5, cy - 0.5);

  if (ratio < minRatio) return { present: true, inFrame: false, guide: "move_closer", ratio, offset, score: box.score };
  if (ratio > maxRatio) return { present: true, inFrame: false, guide: "move_back", ratio, offset, score: box.score };
  if (offset > centerTol) return { present: true, inFrame: false, guide: "center", ratio, offset, score: box.score };
  return { present: true, inFrame: true, guide: "ok", ratio, offset, score: box.score };
}

module.exports = {
  DETECT_CONFIG,
  definePriorBox,
  decodeBoxes,
  nms,
  bestFaceBox,
  assessFraming
};
