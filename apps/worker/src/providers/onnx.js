"use strict";

// Server-side ONNX face provider (real, on-prem, no license/activation, no Docker).
// Runs Faceplugin's MIT ONNX models with onnxruntime-node so liveness, pose and
// face-match are computed on the SERVER from the raw pixels — the browser JS SDK
// is used only for capture UX and its scores are never trusted here.
//
// Pipeline per Faceplugin lib/fr_*.js (see onnxMath.js for the ported math):
//   detect(320x240, RGB, (px-127)/128) → best face box
//   landmark(64x64 gray, px/256)       → 68 points
//   liveness(128x128, BGR, raw px)     → softmax()[0]
//   pose(224x224, RGB, imagenet norm)  → yaw/pitch/roll
//   feature(112x112, BGR, (px-127)/128 after 5-pt affine align) → 512-d embedding
//
// Channel order mirrors the SDK exactly: detect/pose use RGB (they cvtColor to
// RGB), liveness/feature use BGR (the SDK feeds the raw BGR mat), landmark is gray.

const path = require("path");
const fs = require("fs");
const ort = require("onnxruntime-node");
const sharp = require("sharp");
const M = require("./onnxMath");

class ProviderError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "ProviderError";
    this.cause = cause;
  }
}

const MODEL_FILES = Object.freeze({
  detect: "fr_detect.onnx",
  landmark: "fr_landmark.onnx",
  liveness: "fr_liveness.onnx",
  pose: "fr_pose.onnx",
  feature: "fr_feature.onnx"
});

function createOnnxProvider({ modelsDir, matchThreshold = 0.6, livenessThreshold = 0.5 } = {}) {
  const dir = modelsDir || path.resolve(__dirname, "../../models");
  const sessions = {};

  async function session(name) {
    if (sessions[name]) return sessions[name];
    const file = MODEL_FILES[name];
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) {
      throw new ProviderError(`ONNX model missing: ${p}. Fetch models first: node scripts/fetch-onnx-models.js`);
    }
    sessions[name] = await ort.InferenceSession.create(p);
    return sessions[name];
  }

  async function run(sess, float32, dims) {
    const input = new ort.Tensor("float32", float32, dims);
    return sess.run({ [sess.inputNames[0]]: input });
  }

  // ---- image helpers (sharp) ----
  async function meta(buf) {
    const m = await sharp(buf).metadata();
    return { width: m.width, height: m.height };
  }
  async function rawRGB(buf) {
    const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  }
  async function regionRGB(buf, rect, W, H) {
    let s = sharp(buf);
    if (rect) s = s.extract(rect);
    const { data } = await s.resize(W, H, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return data; // RGB interleaved
  }
  async function regionGray(buf, rect, W, H) {
    let s = sharp(buf);
    if (rect) s = s.extract(rect);
    const { data } = await s.resize(W, H, { fit: "fill" }).removeAlpha().grayscale().raw().toBuffer({ resolveWithObject: true });
    return data; // 1 channel (grayscale still emits 3 equal channels unless toColourspace); handle below
  }

  // ---- CHW packers ----
  function packCHW(rgb, W, H, { sub = 0, div = 1, bgr = false } = {}) {
    const plane = W * H;
    const out = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
      const c0 = bgr ? b : r, c1 = g, c2 = bgr ? r : b;
      out[i] = (c0 - sub) / div;
      out[plane + i] = (c1 - sub) / div;
      out[2 * plane + i] = (c2 - sub) / div;
    }
    return out;
  }
  function packPoseCHW(rgb, W, H) {
    const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    const plane = W * H;
    const out = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      out[i] = (rgb[i * 3] / 255 - mean[0]) / std[0];
      out[plane + i] = (rgb[i * 3 + 1] / 255 - mean[1]) / std[1];
      out[2 * plane + i] = (rgb[i * 3 + 2] / 255 - mean[2]) / std[2];
    }
    return out;
  }

  function firstData(outputs, predicate) {
    for (const name of Object.keys(outputs)) {
      const t = outputs[name];
      if (predicate(t, name)) return t;
    }
    return null;
  }

  // ---- stages ----
  async function detect(buf) {
    const { width, height } = await meta(buf);
    const rgb = await regionRGB(buf, null, 320, 240);
    const input = packCHW(rgb, 320, 240, { sub: 127, div: 128, bgr: false });
    const out = await run(await session("detect"), input, [1, 3, 240, 320]);
    // Resolve boxes ([N,4]) and scores ([N,2]) by trailing dim.
    const boxesT = firstData(out, (t) => t.dims[t.dims.length - 1] === 4);
    const scoresT = firstData(out, (t) => t.dims[t.dims.length - 1] === 2);
    if (!boxesT || !scoresT) throw new ProviderError("detect: could not resolve boxes/scores outputs");
    const { best, count } = M.bestFaceBox({
      loc: boxesT.data, scores: scoresT.data, imgWidth: width, imgHeight: height, config: M.DETECT_CONFIG
    });
    return { best, count, width, height };
  }

  async function liveness(buf, box, imgW, imgH) {
    const rect = M.livenessCrop(box, imgW, imgH, 2.7);
    const rgb = await regionRGB(buf, rect, 128, 128);
    const input = packCHW(rgb, 128, 128, { sub: 0, div: 1, bgr: true }); // raw px, BGR
    const out = await run(await session("liveness"), input, [1, 3, 128, 128]);
    const t = firstData(out, () => true);
    const probs = M.softmax(t.data);
    return probs[0]; // "real" probability
  }

  async function pose(buf, box, imgW, imgH) {
    const rect = M.poseCrop(box, imgW, imgH);
    const rgb = await regionRGB(buf, rect, 224, 224);
    const input = packPoseCHW(rgb, 224, 224);
    const sess = await session("pose");
    const out = await run(sess, input, [1, 3, 224, 224]);
    // outputs in graph order: [yaw, pitch, roll]
    const names = sess.outputNames;
    const yaw = M.poseAngleFromBins(out[names[0]].data);
    const pitch = M.poseAngleFromBins(out[names[1]].data);
    const roll = names[2] ? M.poseAngleFromBins(out[names[2]].data) : 0;
    return { yaw, pitch, roll };
  }

  async function landmark68(buf, box, imgW, imgH) {
    const rect = M.livenessCrop(box, imgW, imgH, 1.0);
    const gray = await regionGray(buf, rect, 64, 64);
    // grayscale() keeps 3 identical channels in raw output → take channel 0
    const plane = 64 * 64;
    const input = new Float32Array(plane);
    for (let i = 0; i < plane; i++) input[i] = gray[i * 3] / 256;
    const out = await run(await session("landmark"), input, [1, 1, 64, 64]);
    const t = firstData(out, () => true);
    const bw = box.x2 - box.x1, bh = box.y2 - box.y1;
    const lm = new Array(t.data.length);
    for (let i = 0; i < t.data.length; i++) {
      lm[i] = i % 2 === 0 ? t.data[i] * bw + box.x1 : t.data[i] * bh + box.y1;
    }
    return lm;
  }

  async function feature(buf, box, imgW, imgH) {
    const lm = await landmark68(buf, box, imgW, imgH);
    const five = M.convert68to5(lm);
    const { data, width, height } = await rawRGB(buf);
    const aligned = warpTo112(data, width, height, five);
    const input = packCHW(aligned, 112, 112, { sub: 127, div: 128, bgr: true });
    const out = await run(await session("feature"), input, [1, 3, 112, 112]);
    const t = firstData(out, () => true);
    return Float32Array.from(t.data);
  }

  function warpTo112(rgb, W, H, five) {
    const fwd = M.affineFrom3([five[0], five[1], five[2]], [M.REFERENCE_5PTS[0], M.REFERENCE_5PTS[1], M.REFERENCE_5PTS[2]]);
    const inv = M.invertAffine(fwd);
    const out = new Uint8ClampedArray(112 * 112 * 3);
    for (let dy = 0; dy < 112; dy++) {
      for (let dx = 0; dx < 112; dx++) {
        const sx = inv[0] * dx + inv[1] * dy + inv[2];
        const sy = inv[3] * dx + inv[4] * dy + inv[5];
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        const oi = (dy * 112 + dx) * 3;
        if (x0 < 0 || y0 < 0 || x0 >= W - 1 || y0 >= H - 1) { out[oi] = out[oi + 1] = out[oi + 2] = 0; continue; }
        const fx = sx - x0, fy = sy - y0;
        for (let c = 0; c < 3; c++) {
          const p00 = rgb[(y0 * W + x0) * 3 + c];
          const p10 = rgb[(y0 * W + x0 + 1) * 3 + c];
          const p01 = rgb[((y0 + 1) * W + x0) * 3 + c];
          const p11 = rgb[((y0 + 1) * W + x0 + 1) * 3 + c];
          out[oi + c] = p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy;
        }
      }
    }
    return out;
  }

  return {
    name: "onnx",

    async checkLiveness(selfieBuffer) {
      const det = await detect(selfieBuffer);
      if (!det.best) return { score: null, verdict: "No face", faceCount: 0, occluded: false, quality: null, pose: null, raw: { faces: 0 } };
      const [score, ps] = await Promise.all([
        liveness(selfieBuffer, det.best, det.width, det.height),
        pose(selfieBuffer, det.best, det.width, det.height)
      ]);
      return {
        score,
        // Same vocabulary as Faceplugin's face_state.result — the pipeline's
        // document validation (liveFaceAsDocument) keys off "Real".
        verdict: score >= 0.5 ? "Real" : "Spoof",
        faceCount: det.count,
        occluded: false,
        quality: null,
        pose: { yaw: ps.yaw, pitch: ps.pitch, roll: ps.roll },
        raw: { faces: det.count, box: det.best, liveness: score, pose: ps }
      };
    },

    async compareFaces(selfieBuffer, idImageBuffer) {
      const [selfieDet, idDet] = await Promise.all([detect(selfieBuffer), detect(idImageBuffer)]);
      if (!idDet.best) return { score: null, idFaceFound: false, raw: { reason: "no face on ID" } };
      if (!selfieDet.best) return { score: null, idFaceFound: true, raw: { reason: "no face on selfie" } };
      const [f1, f2] = await Promise.all([
        feature(selfieBuffer, selfieDet.best, selfieDet.width, selfieDet.height),
        feature(idImageBuffer, idDet.best, idDet.width, idDet.height)
      ]);
      const score = M.matchFeature(f1, f2);
      return { score, idFaceFound: true, raw: { score, threshold: matchThreshold } };
    },

    // No OCR model in this stack — degrade to manual_review (fail-closed).
    async extractDocument() {
      return { available: false, ocrConfidence: null, extractedData: null, expired: null, raw: null };
    }
  };
}

module.exports = { createOnnxProvider, ProviderError };
