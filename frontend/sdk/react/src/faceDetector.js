// Browser face detector: runs Faceplugin's fr_detect.onnx in-page via
// onnxruntime-web to gate framing (face present, right distance, centered).
// This is UX-only guidance — the server still makes the authoritative decision.
//
// onnxruntime-web is loaded lazily (dynamic import) so it never affects Node
// tests or non-face flows, and the whole detector is optional: if the model or
// runtime fails to load, the widget falls back to motion-based auto-capture.

import { bestFaceBox, assessFraming, DETECT_CONFIG } from "@verifypass/sdk-core";
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
      return ort;
    });
  }
  return ortPromise;
}

/**
 * @param {string} modelUrl URL to fr_detect.onnx
 * @returns {Promise<{detect(imageData):Promise<object>, dispose():void}>}
 */
export async function createFaceDetector(modelUrl) {
  const ort = await loadOrt();
  const session = await ort.InferenceSession.create(modelUrl, { executionProviders: ["wasm"] });
  const [W, H] = DETECT_CONFIG.inputSize;

  function preprocess(imageData) {
    const { data } = imageData; // W*H RGBA
    const plane = W * H;
    const out = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      out[i] = (data[i * 4] - 127) / 128;
      out[plane + i] = (data[i * 4 + 1] - 127) / 128;
      out[2 * plane + i] = (data[i * 4 + 2] - 127) / 128;
    }
    return out;
  }

  return {
    /** @param {ImageData} imageData exactly WxH → framing assessment */
    async detect(imageData) {
      if (!imageData) return assessFraming(null);
      const input = preprocess(imageData);
      const tensor = new ort.Tensor("float32", input, [1, 3, H, W]);
      const out = await session.run({ [session.inputNames[0]]: tensor });
      let boxesT = null, scoresT = null;
      for (const name of session.outputNames) {
        const o = out[name];
        const last = o.dims[o.dims.length - 1];
        if (last === 4) boxesT = o;
        else if (last === 2) scoresT = o;
      }
      if (!boxesT || !scoresT) return assessFraming(null);
      const box = bestFaceBox({ loc: boxesT.data, scores: scoresT.data });
      return { ...assessFraming(box), box };
    },
    dispose() { try { session.release && session.release(); } catch (_) { /* noop */ } }
  };
}
