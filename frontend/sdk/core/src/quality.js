"use strict";

// Client-side capture quality checks (PRD §9.4/§9.5 SDK guidance).
// These give the user real-time feedback; the server re-validates everything.
// Input: ImageData-like {data: Uint8ClampedArray RGBA, width, height}.

/** Luma grayscale (Rec. 601). Returns Float32Array of width*height. */
function toGrayscale({ data, width, height }) {
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return gray;
}

/**
 * Blur score: variance of 3x3 Laplacian. Higher = sharper.
 * Typical webcam captures: <40 very blurry, 40–100 soft, >100 sharp.
 */
function laplacianVariance(imageData) {
  const { width, height } = imageData;
  const gray = toGrayscale(imageData);
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = -4 * gray[i] + gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** Mean brightness 0–255. */
function meanBrightness(imageData) {
  const gray = toGrayscale(imageData);
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  return gray.length ? sum / gray.length : 0;
}

/**
 * Mean absolute per-pixel difference between two grayscale frames (0–255).
 * Used to detect movement (user performing a liveness action) and stillness
 * (settled → safe to auto-capture). Pure + testable.
 */
function frameMotion(prevGray, gray) {
  const n = Math.min(prevGray.length, gray.length);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(gray[i] - prevGray[i]);
  return sum / n;
}

const DEFAULT_RULES = {
  minSharpness: 40,
  minBrightness: 50,
  maxBrightness: 215
};

/**
 * Evaluate a frame. Returns {ok, issues[], metrics} where issues use the
 * platform's reason-code vocabulary so the SDK and API speak the same language.
 */
function assessFrame(imageData, rules = {}) {
  const r = { ...DEFAULT_RULES, ...rules };
  const sharpness = laplacianVariance(imageData);
  const brightness = meanBrightness(imageData);

  const issues = [];
  if (sharpness < r.minSharpness) issues.push("DOCUMENT_BLURRY");
  if (brightness < r.minBrightness) issues.push("TOO_DARK");
  if (brightness > r.maxBrightness) issues.push("TOO_BRIGHT");

  return {
    ok: issues.length === 0,
    issues,
    metrics: { sharpness: Math.round(sharpness * 100) / 100, brightness: Math.round(brightness * 100) / 100 }
  };
}

module.exports = { toGrayscale, laplacianVariance, meanBrightness, frameMotion, assessFrame, DEFAULT_RULES };
