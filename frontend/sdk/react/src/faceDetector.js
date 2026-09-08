// Browser face detector: runs fr_detect.onnx (Ultra-Light-RFB-320 export —
// `scores` + pre-decoded `boxes`) in-page via onnxruntime-web to gate framing,
// and fr_landmark.onnx (64×64 gray crop → 68 points) for signed head-pose
// proxies that drive the active-liveness action detector.
// This is UX-only guidance — the server still makes the authoritative decision.
//
// onnxruntime-web is loaded lazily (dynamic import) so it never affects Node
// tests or non-face flows, and the whole detector is optional: if the model or
// runtime fails to load, the widget falls back to motion-based auto-capture.
// The landmark model is optional on top of that: without it, action detection
// falls back to box geometry only.

import {
  bestFaceBox, assessFraming, DETECT_CONFIG, fetchWithCache, evictModel,
  poseFromLandmarks, exprFromLandmarks, landmarkInputFromImageData, LANDMARK_INPUT
} from "@verifypass/sdk-core";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";

let ortPromise = null;
function loadOrt() {
  if (!ortPromise) {
    // Use the WASM bundle entry so Vite serves the runtime assets locally.
    // Depending on a CDN here can leave the UI stuck on "Loading face model..."
    // when the network blocks jsDelivr or runs offline.
    ortPromise = import("onnxruntime-web/wasm").then((ort) => {
      // Vite serves unknown routes as index.html in dev. Give ONNX Runtime the
      // real hashed asset URL so it never guesses a path and compiles HTML as WASM.
      ort.env.wasm.wasmPaths = { wasm: ortWasmUrl };
      // B4: two WASM threads on capable devices (needs cross-origin isolation
      // for SharedArrayBuffer; ORT falls back to 1 thread silently otherwise)
      try { ort.env.wasm.numThreads = (globalThis.crossOriginIsolated && typeof navigator !== "undefined" && navigator.hardwareConcurrency > 2) ? 2 : 1; } catch (_) { /* noop */ }
      return ort;
    }).catch(err => { ortPromise = null; throw err; });
  }
  return ortPromise;
}

/** Default landmark model URL: sibling of the detector (fr_detect → fr_landmark). */
export function defaultLandmarkUrl(modelUrl) {
  if (typeof modelUrl !== "string") return null;
  if (/fr_detect\.onnx(\?.*)?$/.test(modelUrl)) return modelUrl.replace(/fr_detect\.onnx/, "fr_landmark.onnx");
  return null;
}

/**
 * @param {string|ArrayBuffer} modelUrl URL or buffer to fr_detect.onnx
 * @param {object} [opts]
 * @param {string|ArrayBuffer|null} [opts.landmarkUrl] fr_landmark.onnx (null = geometry only)
 * @param {object} [opts.framing] assessFraming overrides ({minRatio, maxRatio, centerTol})
 * @returns {Promise<{detect(imageData):Promise<object>, hasLandmarks:boolean, dispose():void}>}
 */
export async function createFaceDetector(modelUrl, opts = {}) {
  const landmarkUrl = opts.landmarkUrl === undefined ? defaultLandmarkUrl(modelUrl) : opts.landmarkUrl;
  const framing = opts.framing || {};
  const [ort, modelBuffer, lmBuffer] = await Promise.all([
    loadOrt(),
    typeof modelUrl === "string" ? fetchWithCache(modelUrl, { signal: opts.signal }) : modelUrl,
    landmarkUrl ? (typeof landmarkUrl === "string" ? fetchWithCache(landmarkUrl, { signal: opts.signal }).catch(() => null) : landmarkUrl) : null
  ]);
  if (opts.signal?.aborted) throw new Error("Model load cancelled");
  let session;
  try { session = await ort.InferenceSession.create(modelBuffer, { executionProviders: ["wasm"] }); }
  catch (error) { if (typeof modelUrl === "string") await evictModel(modelUrl); throw error; }
  // Landmark session is best-effort: a missing/corrupt model must not take
  // the detector down with it.
  let lmSession = null;
  if (lmBuffer) {
    try { lmSession = await ort.InferenceSession.create(lmBuffer, { executionProviders: ["wasm"] }); } catch (_) { if (typeof landmarkUrl === "string") await evictModel(landmarkUrl); lmSession = null; }
  }
  const [W, H] = DETECT_CONFIG.inputSize;
  const inputBuffer = new Float32Array(3 * W * H);
  let disposed = false;
  let running = false;
  let released = false;

  function releaseSessions() {
    if (released || running) return;
    released = true;
    for (const current of [session, lmSession]) {
      try { Promise.resolve(current?.release?.()).catch(() => {}); } catch (_) {}
    }
  }

  function disposeTensors(tensors) {
    for (const tensor of new Set(tensors)) tensor?.dispose?.();
  }

  function preprocess(imageData) {
    const { data } = imageData; // W*H RGBA
    const plane = W * H;
    const out = inputBuffer;
    for (let i = 0; i < plane; i++) {
      out[i] = (data[i * 4] - 127) / 128;
      out[plane + i] = (data[i * 4 + 1] - 127) / 128;
      out[2 * plane + i] = (data[i * 4 + 2] - 127) / 128;
    }
    return out;
  }

  async function landmarks(imageData, box) {
    if (!lmSession) return null;
    const prep = landmarkInputFromImageData(imageData, box);
    if (!prep) return null;
    const S = LANDMARK_INPUT;
    const tensor = new ort.Tensor("float32", prep.input, [1, 1, S, S]);
    let out;
    try {
      out = await lmSession.run({ [lmSession.inputNames[0]]: tensor });
      const result = out[lmSession.outputNames[0]];
      return { raw: result.data.slice(), rect: prep.rect };
    } finally {
      disposeTensors([tensor, ...Object.values(out || {})]);
    }
  }

  return {
    hasLandmarks: !!lmSession,
    /** @param {ImageData} imageData exactly WxH → framing assessment (+ pose) */
    async detect(imageData) {
      if (disposed) throw new Error("Face detector disposed");
      if (running) throw new Error("Face detector is already running");
      if (!imageData) return assessFraming(null, framing);
      if (imageData.width !== W || imageData.height !== H || imageData.data.length !== W * H * 4) {
        throw new Error("Unexpected face detector input dimensions");
      }
      const input = preprocess(imageData);
      const tensor = new ort.Tensor("float32", input, [1, 3, H, W]);
      let out;
      running = true;
      try {
      out = await session.run({ [session.inputNames[0]]: tensor });
      let boxesT = null, scoresT = null;
      for (const name of session.outputNames) {
        const o = out[name];
        const last = o.dims[o.dims.length - 1];
        if (last === 4) boxesT = o;
        else if (last === 2) scoresT = o;
      }
      if (!boxesT || !scoresT) return assessFraming(null, framing);
      const box = bestFaceBox({ loc: boxesT.data, scores: scoresT.data });
      let pose = null, expr = null;
      if (box) {
        try {
          const lm = await landmarks(imageData, box);
          // landmarks are normalised to the CLAMPED crop rect, not the raw box
          if (lm) {
            const rect = { x1: lm.rect.x1, y1: lm.rect.y1, x2: lm.rect.x2, y2: lm.rect.y2 };
            pose = poseFromLandmarks(lm.raw, rect);
            expr = exprFromLandmarks(lm.raw, rect); // {ear, mar} for blink / open_mouth
          }
        } catch (_) { pose = null; expr = null; }
      }
      return { ...assessFraming(box, framing), box, pose, expr };
      } finally {
        disposeTensors([tensor, ...Object.values(out || {})]);
        running = false;
        if (disposed) releaseSessions();
      }
    },
    dispose() {
      disposed = true;
      releaseSessions();
    }
  };
}
