"use strict";

// Pure numeric helpers for the server-side ONNX face pipeline, ported
// faithfully from Faceplugin's MIT JavaScript SDK (lib/fr_*.js). No I/O here,
// so every function is unit-testable without the model binaries.

/** Numerically-stable softmax over a flat array. */
function softmax(arr) {
  const a = Array.from(arr, Number);
  const max = Math.max(...a);
  const exps = a.map((v) => Math.exp(v - max));
  const sum = exps.reduce((s, v) => s + v, 0) || 1;
  return exps.map((v) => v / sum);
}

/**
 * Head-pose angle from a 66-bin logit vector (fr_pose): softmax → expected
 * bin index → degrees. Faceplugin: sum(p_i * i) * 3 - 99.
 */
function poseAngleFromBins(logits) {
  const p = softmax(logits);
  let expected = 0;
  for (let i = 0; i < p.length; i++) expected += p[i] * i;
  return expected * 3 - 99;
}

/**
 * RetinaFace prior boxes for a WxH input. Returns Float32 rows [cx, cy, sx, sy].
 * @param {[number,number]} imageSize [width, height]
 */
function definePriorBox(imageSize, config) {
  const [W, H] = imageSize; // W = width, H = height
  const { minSizes, steps } = config;
  const anchors = [];
  steps.forEach((step, k) => {
    // Rows over HEIGHT, cols over WIDTH (RetinaFace image_size = [height, width]),
    // so anchor[n] lines up with the model's flat output[n].
    const fmRows = Math.ceil(H / step);
    const fmCols = Math.ceil(W / step);
    for (let i = 0; i < fmRows; i++) {
      for (let j = 0; j < fmCols; j++) {
        for (const mSize of minSizes[k]) {
          const sKx = mSize / W;
          const sKy = mSize / H;
          const cx = ((j + 0.5) * step) / W;
          const cy = ((i + 0.5) * step) / H;
          anchors.push([cx, cy, sKx, sKy]);
        }
      }
    }
  });
  return anchors;
}

/**
 * Decode raw box regressions against priors → normalized corner boxes
 * [x1, y1, x2, y2] in 0..1.
 * @param {Float32Array|number[]} loc flat [N*4]
 * @param {number[][]} priors rows [cx,cy,sx,sy]
 * @param {[number,number]} variance
 */
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

/**
 * Faceplugin's cpuNMS: overlap is intersection area relative to the CANDIDATE
 * box area (not classic IoU). Returns kept indices.
 */
function nms(boxes, scores, thresh) {
  const items = [];
  for (let i = 0; i < boxes.length; i++) {
    const [x1, y1, x2, y2] = boxes[i];
    const w = x2 - x1, h = y2 - y1;
    if (w > 0 && h > 0) items.push({ x1, y1, x2, y2, area: w * h, index: i, score: scores[i] });
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
      const overlap = (w * h) / box.area;
      if (overlap >= thresh) suppress.add(pool[i]);
    }
    pool = pool.filter((b) => !suppress.has(b));
  }
  return keep;
}

/**
 * Full detection post-process → best (largest) square face box in ORIGINAL
 * image pixel coords plus the number of faces kept. Mirrors detectFaceImage +
 * scaleResult + getBestFace.
 * @returns {{best: object|null, count: number}}
 */
function bestFaceBox({ loc, scores, imgWidth, imgHeight, config }) {
  const [W, H] = config.inputSize; // [320,240]
  const priors = definePriorBox([W, H], config);
  const decoded = decodeBoxes(loc, priors, config.variance); // 0..1 corners
  // scale to detector input pixel space
  const boxesPx = decoded.map(([x1, y1, x2, y2]) => [x1 * W, y1 * H, x2 * W, y2 * H]);

  // screen by confidence (scores flat [N,2], take class-1 prob)
  const kept = [];
  for (let i = 0; i < boxesPx.length; i++) {
    const conf = scores[i * 2 + 1];
    if (conf >= config.confidenceThreshold) kept.push({ box: boxesPx[i], score: conf });
  }
  if (kept.length === 0) return { best: null, count: 0 };
  kept.sort((a, b) => b.score - a.score);
  const top = kept.slice(0, config.topK);
  const keepIdx = nms(top.map((k) => k.box), top.map((k) => k.score), config.nmsThreshold);

  const rx = imgWidth / W, ry = imgHeight / H;
  const faces = [];
  for (const i of keepIdx) {
    let [x1, y1, x2, y2] = top[i].box;
    x1 *= rx; y1 *= ry; x2 *= rx; y2 *= ry;
    const fSize = y2 - y1;
    const ctX = (x1 + x2) / 2, ctY = (y1 + y2) / 2;
    x1 = Math.max(0, ctX - fSize / 2);
    y1 = Math.max(0, ctY - fSize / 2);
    x2 = Math.min(imgWidth - 1, ctX + fSize / 2);
    y2 = Math.min(imgHeight - 1, ctY + fSize / 2);
    const area = (x2 - x1) * (y2 - y1);
    faces.push({ x1, y1, x2, y2, area, score: top[i].score });
  }
  if (faces.length === 0) return { best: null, count: 0 };
  faces.sort((a, b) => b.area - a.area);
  const best = faces[0];

  // Count only DISTINCT, SIGNIFICANT faces. Boxes that overlap the primary face
  // are duplicate detections of the same person (NMS can leave near-duplicates
  // at different scales) and must not read as a second face; tiny/low-confidence
  // background detections are ignored too. A genuine second person is large,
  // high-confidence, and spatially separate — and still counts.
  const countMinScore = config.countMinScore ?? 0.9;
  const countMinAreaRatio = config.countMinAreaRatio ?? 0.25;
  const maxIoU = config.countMaxIoU ?? 0.2;

  function iou(a, b) {
    const ix1 = Math.max(a.x1, b.x1), iy1 = Math.max(a.y1, b.y1);
    const ix2 = Math.min(a.x2, b.x2), iy2 = Math.min(a.y2, b.y2);
    const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
    const inter = iw * ih;
    const uni = a.area + b.area - inter;
    return uni > 0 ? inter / uni : 0;
  }

  const distinct = [best];
  for (const f of faces.slice(1)) {
    if (f.score < countMinScore) continue;
    if (f.area < best.area * countMinAreaRatio) continue;
    // Skip if it overlaps any already-counted face (same person detected twice).
    if (distinct.some((d) => iou(d, f) > maxIoU)) continue;
    distinct.push(f);
  }

  return {
    best: { x1: best.x1, y1: best.y1, x2: best.x2, y2: best.y2, area: best.area, score: best.score },
    count: distinct.length
  };
}

/**
 * Liveness crop rectangle: Faceplugin alignLivenessImage(scale 2.7) — expand
 * the box by `scale` about its centre, clamped to the image.
 * @returns {{left,top,width,height}}
 */
function livenessCrop(box, imgW, imgH, scaleValue = 2.7) {
  const x = box.x1, y = box.y1;
  const boxW = box.x2 - box.x1, boxH = box.y2 - box.y1;
  const scale = Math.min((imgH - 1) / boxH, Math.min((imgW - 1) / boxW, scaleValue));
  const newW = boxW * scale, newH = boxH * scale;
  const cx = boxW / 2 + x, cy = boxH / 2 + y;
  let ltx = cx - newW / 2, lty = cy - newH / 2;
  let rbx = cx + newW / 2, rby = cy + newH / 2;
  if (ltx < 0) { rbx -= ltx; ltx = 0; }
  if (lty < 0) { rby -= lty; lty = 0; }
  if (rbx > imgW - 1) { ltx -= rbx - imgW + 1; rbx = imgW - 1; }
  if (rby > imgH - 1) { lty -= rby - imgH + 1; rby = imgH - 1; }
  const left = Math.max(0, Math.floor(ltx));
  const top = Math.max(0, Math.floor(lty));
  return {
    left, top,
    width: Math.max(1, Math.min(Math.floor(rbx - ltx), imgW - left)),
    height: Math.max(1, Math.min(Math.floor(rby - lty), imgH - top))
  };
}

/** Pose crop: pad the box by width/4, height/4, clamped. */
function poseCrop(box, imgW, imgH) {
  const w = box.x2 - box.x1, h = box.y2 - box.y1;
  const x11 = Math.floor(box.x1 - w / 4), y11 = Math.floor(box.y1 - h / 4);
  const x22 = Math.floor(box.x2 + w / 4), y22 = Math.floor(box.y2 + h / 4);
  const left = Math.max(0, x11), top = Math.max(0, y11);
  return {
    left, top,
    width: Math.max(1, Math.min(x22 - x11, imgW - left)),
    height: Math.max(1, Math.min(y22 - y11, imgH - top))
  };
}

/** 68-point landmark (flat 136) → 5 anchor points, per Faceplugin convert68pts5pts. */
function convert68to5(lm) {
  const leftEyeX = (lm[74] + lm[76] + lm[80] + lm[82]) / 4;
  const leftEyeY = (lm[75] + lm[77] + lm[81] + lm[83]) / 4;
  const rightEyeX = (lm[86] + lm[88] + lm[92] + lm[94]) / 4;
  const rightEyeY = (lm[87] + lm[89] + lm[93] + lm[95]) / 4;
  const noseX = lm[60], noseY = lm[61];
  const leftMouthX = (lm[96] + lm[120]) / 2, leftMouthY = (lm[97] + lm[121]) / 2;
  const rightMouthX = (lm[108] + lm[128]) / 2, rightMouthY = (lm[109] + lm[129]) / 2;
  return [
    [leftEyeX, leftEyeY], [rightEyeX, rightEyeY], [noseX, noseY],
    [leftMouthX, leftMouthY], [rightMouthX, rightMouthY]
  ];
}

// ArcFace reference 5-point template (112x112).
const REFERENCE_5PTS = [
  [38.29459953, 51.69630051],
  [73.53179932, 51.50139999],
  [56.02519989, 71.73660278],
  [41.54930115, 92.3655014],
  [70.72990036, 92.20410156]
];

/**
 * Solve the 2x3 affine transform mapping 3 source points → 3 dest points
 * (equivalent to cv.getAffineTransform). Returns [a,b,c,d,e,f] where
 * x' = a*x + b*y + c ; y' = d*x + e*y + f.
 */
function affineFrom3(src, dst) {
  const [[x0, y0], [x1, y1], [x2, y2]] = src;
  const det = x0 * (y1 - y2) - y0 * (x1 - x2) + (x1 * y2 - x2 * y1);
  if (Math.abs(det) < 1e-12) throw new Error("degenerate affine source points");
  function solve(f0, f1, f2) {
    // solve for (a,b,c): a*xi + b*yi + c = fi via Cramer's rule
    const a = (f0 * (y1 - y2) - y0 * (f1 - f2) + (f1 * y2 - f2 * y1)) / det;
    const b = (x0 * (f1 - f2) - f0 * (x1 - x2) + (x1 * f2 - x2 * f1)) / det;
    const c = (x0 * (y1 * f2 - y2 * f1) - y0 * (x1 * f2 - x2 * f1) + f0 * (x1 * y2 - x2 * y1)) / det;
    return [a, b, c];
  }
  const [a, b, c] = solve(dst[0][0], dst[1][0], dst[2][0]);
  const [d, e, f] = solve(dst[0][1], dst[1][1], dst[2][1]);
  return [a, b, c, d, e, f];
}

/** Invert a 2x3 affine ([a,b,c,d,e,f]) for backward (dest→src) sampling. */
function invertAffine([a, b, c, d, e, f]) {
  const det = a * e - b * d;
  if (Math.abs(det) < 1e-12) throw new Error("non-invertible affine");
  const ia = e / det, ib = -b / det, id = -d / det, ie = a / det;
  const ic = -(ia * c + ib * f);
  const iff = -(id * c + ie * f);
  return [ia, ib, ic, id, ie, iff];
}

/**
 * Cosine similarity between two embeddings, in [-1, 1].
 *
 * NOTE: Faceplugin's open-source JS `matchFeature` uses joint mean-subtraction,
 * which is mathematically degenerate (it makes any two distinct vectors
 * antipodal → always ≈ -1) and in their SDK is wired on raw ORT output objects,
 * so it effectively no-ops. It is demo-grade, not a real matcher. For the
 * ArcFace-style 512-d embeddings fr_feature produces, cosine similarity is the
 * correct comparison. Scores are on the cosine scale (same-person typically
 * > ~0.4–0.6), so tune tenant faceMatch thresholds accordingly.
 */
function matchFeature(f1, f2) {
  const n = Math.min(f1.length, f2.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += f1[i] * f2[i];
    na += f1[i] * f1[i];
    nb += f2[i] * f2[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

const DETECT_CONFIG = Object.freeze({
  inputSize: [320, 240],
  minSizes: [[10, 16, 24], [32, 48], [64, 96], [128, 192, 256]],
  steps: [8, 16, 32, 64],
  variance: [0.1, 0.2],
  confidenceThreshold: 0.65,
  topK: 750,
  nmsThreshold: 0.4
});

module.exports = {
  softmax,
  poseAngleFromBins,
  definePriorBox,
  decodeBoxes,
  nms,
  bestFaceBox,
  livenessCrop,
  poseCrop,
  convert68to5,
  affineFrom3,
  invertAffine,
  matchFeature,
  REFERENCE_5PTS,
  DETECT_CONFIG
};
