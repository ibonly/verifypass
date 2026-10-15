// src/VerifyPassProvider.jsx
import { createContext, useContext, useMemo } from "react";
import { readPublicConfig } from "@verifypass/sdk-core";
import { jsx } from "react/jsx-runtime";
var VerifyPassContext = createContext(null);
var LIVE_TEST_API_BASE = "https://uybb6wv27prwyijtkcteovvvke0hfkqw.lambda-url.us-east-2.on.aws";
var LIVE_TEST_PUBLIC_KEY = "vp_pub_test_g0CAzW80fTNG5GJYV2wA1XUFFXov7VU9";
var DEFAULT_FACE_MODEL_URL = "/models/fr_detect.onnx";
function VerifyPassProvider({
  publicKey,
  baseUrl,
  faceModelUrl,
  landmarkModelUrl,
  ortWasmUrl,
  env = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {},
  children
}) {
  const value = useMemo(() => {
    const configured = readPublicConfig(env);
    return {
      publicKey: publicKey === void 0 ? configured.publicKey : publicKey,
      baseUrl: baseUrl === void 0 ? configured.baseUrl : baseUrl,
      faceModelUrl: faceModelUrl === void 0 ? configured.faceModelUrl || void 0 : faceModelUrl,
      landmarkModelUrl: landmarkModelUrl === void 0 ? configured.landmarkModelUrl : landmarkModelUrl,
      ortWasmUrl: ortWasmUrl === void 0 ? configured.ortWasmUrl : ortWasmUrl
    };
  }, [publicKey, baseUrl, faceModelUrl, landmarkModelUrl, ortWasmUrl, env]);
  return /* @__PURE__ */ jsx(VerifyPassContext.Provider, { value, children });
}
var NO_PROVIDER = Object.freeze({ publicKey: null, baseUrl: null, faceModelUrl: void 0, landmarkModelUrl: void 0, ortWasmUrl: void 0 });
function useVerifyPassConfig() {
  return useContext(VerifyPassContext) || NO_PROVIDER;
}
function useVerifyPass() {
  const ctx = useContext(VerifyPassContext);
  if (!ctx) throw new Error("useVerifyPass must be used inside <VerifyPassProvider>");
  return ctx;
}

// src/useVerification.js
import { useCallback, useEffect, useMemo as useMemo2, useRef, useState } from "react";
import {
  createVerificationController,
  assessFrame,
  collectCaptureSignals,
  startCamera,
  stopCamera,
  captureFrame,
  captureGuideFrame,
  nextVideoFrame as nextVideoFrame2
} from "@verifypass/sdk-core";

// src/faceDetector.js
import {
  bestFaceBox,
  assessFraming,
  DETECT_CONFIG,
  fetchWithCache,
  evictModel,
  poseFromLandmarks,
  exprFromLandmarks,
  landmarkInputFromImageData,
  LANDMARK_INPUT
} from "@verifypass/sdk-core";

// vite-url:onnxruntime-web/ort-wasm-simd-threaded.wasm?url
var ort_wasm_simd_threaded_default = void 0;

// src/assets.js
var ORT_VERSION = "1.29.0";
var ORT_WASM_SHA256 = "ec8580a9d7b9476ceee52e10a7f94124e4dc71a019d666ed6d4726697c109a4d";
function hostedAssetBase(hostedBaseUrl) {
  if (typeof hostedBaseUrl !== "string" || !hostedBaseUrl) return null;
  try {
    const url = new URL(hostedBaseUrl);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback) || url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch (_) {
    return null;
  }
}
var hostedModelUrl = (base, file) => base ? `${base}/models/${file}` : null;
var hostedOrtWasmUrl = (base) => base ? `${base}/sdk-assets/ort/${ORT_VERSION}/ort-wasm-simd-threaded.wasm` : null;

// src/faceDetector.js
var ortPromise = null;
var hasBundledOrtWasm = !!ort_wasm_simd_threaded_default;
function loadOrt(wasmUrl, assetBaseUrl) {
  if (!ortPromise) {
    ortPromise = import("onnxruntime-web/wasm").then(async (ort) => {
      const url = wasmUrl || ort_wasm_simd_threaded_default;
      const hosted = !url && hostedOrtWasmUrl(assetBaseUrl);
      if (url) ort.env.wasm.wasmPaths = { wasm: url };
      else if (hosted) ort.env.wasm.wasmBinary = await fetchWithCache(hosted, { sha256: ORT_WASM_SHA256, timeoutMs: 3e4 });
      try {
        ort.env.wasm.numThreads = !hosted && globalThis.crossOriginIsolated && typeof navigator !== "undefined" && navigator.hardwareConcurrency > 2 ? 2 : 1;
      } catch (_) {
      }
      return ort;
    }).catch((err) => {
      ortPromise = null;
      throw err;
    });
  }
  return ortPromise;
}
function defaultLandmarkUrl(modelUrl) {
  if (typeof modelUrl !== "string") return null;
  if (/fr_detect\.onnx(\?.*)?$/.test(modelUrl)) return modelUrl.replace(/fr_detect\.onnx/, "fr_landmark.onnx");
  return null;
}
async function createFaceDetector(modelUrl, opts = {}) {
  const landmarkUrl = opts.landmarkUrl === void 0 ? defaultLandmarkUrl(modelUrl) : opts.landmarkUrl;
  const framing = opts.framing || {};
  const [ort, modelBuffer, lmBuffer] = await Promise.all([
    loadOrt(opts.ortWasmUrl, opts.assetBaseUrl),
    typeof modelUrl === "string" ? fetchWithCache(modelUrl, { signal: opts.signal }) : modelUrl,
    landmarkUrl ? typeof landmarkUrl === "string" ? fetchWithCache(landmarkUrl, { signal: opts.signal }).catch(() => null) : landmarkUrl : null
  ]);
  if (opts.signal?.aborted) throw new Error("Model load cancelled");
  let session;
  try {
    session = await ort.InferenceSession.create(modelBuffer, { executionProviders: ["wasm"] });
  } catch (error) {
    if (typeof modelUrl === "string") await evictModel(modelUrl);
    throw error;
  }
  let lmSession = null;
  if (lmBuffer) {
    try {
      lmSession = await ort.InferenceSession.create(lmBuffer, { executionProviders: ["wasm"] });
    } catch (_) {
      if (typeof landmarkUrl === "string") await evictModel(landmarkUrl);
      lmSession = null;
    }
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
      try {
        Promise.resolve(current?.release?.()).catch(() => {
        });
      } catch (_) {
      }
    }
  }
  function disposeTensors(tensors) {
    for (const tensor of new Set(tensors)) tensor?.dispose?.();
  }
  function preprocess(imageData) {
    const { data } = imageData;
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
            if (lm) {
              const rect = { x1: lm.rect.x1, y1: lm.rect.y1, x2: lm.rect.x2, y2: lm.rect.y2 };
              pose = poseFromLandmarks(lm.raw, rect);
              expr = exprFromLandmarks(lm.raw, rect);
            }
          } catch (_) {
            pose = null;
            expr = null;
          }
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

// src/captureLoop.js
import {
  grabAnalysisFrame,
  grabSquareFrame,
  grabFixedFrame,
  frameMotion,
  toGrayscale,
  meanBrightness,
  laplacianVariance,
  createFramingStabilizer,
  createActionDetector,
  bandMotion,
  createDocumentGate,
  isDominantFace,
  isFrontalPose,
  isReferencePose,
  frontalRefFromSamples,
  LIVENESS_FRAME_BUDGET
} from "@verifypass/sdk-core";
var isDocumentStep = (s) => s === "document" || s === "document_back";
var FACE_FOCUS_MIN = 12;
function cropImageData(imageData, box, padRatio = 0.12) {
  if (!imageData || !box) return null;
  const { width, height, data } = imageData;
  const padX = (box.x2 - box.x1) * padRatio;
  const padY = (box.y2 - box.y1) * padRatio;
  const x1 = Math.max(0, Math.floor(box.x1 - padX));
  const y1 = Math.max(0, Math.floor(box.y1 - padY));
  const x2 = Math.min(width, Math.ceil(box.x2 + padX));
  const y2 = Math.min(height, Math.ceil(box.y2 + padY));
  const cropW = x2 - x1;
  const cropH = y2 - y1;
  if (cropW < 16 || cropH < 16) return null;
  const out = new Uint8ClampedArray(cropW * cropH * 4);
  for (let y = 0; y < cropH; y++) {
    const srcStart = ((y1 + y) * width + x1) * 4;
    const srcEnd = srcStart + cropW * 4;
    out.set(data.subarray(srcStart, srcEnd), y * cropW * 4);
  }
  return { data: out, width: cropW, height: cropH };
}
function runCaptureLoop(ctx) {
  const {
    step,
    faceModelEnabled,
    detectorStatus,
    video: getVideo,
    overlay,
    detector,
    isCapturing,
    framesUsed,
    telemetry,
    capture,
    framingRef,
    livenessStabRef,
    livenessFrontalRef,
    livenessRefSamplesRef,
    set
  } = ctx;
  if (!(isDocumentStep(step) || step === "face" || step === "liveness")) return () => {
  };
  set.green(false);
  framingRef.current = null;
  set.livePhase({ phase: "align", startedAt: 0, total: 0 });
  set.framingGuide(step === "face" || step === "liveness" ? detectorStatus === "failed" ? "model_error" : "model_loading" : "no_face");
  const DEBUG = /[?&]vpdebug\b/.test(typeof window !== "undefined" ? window.location.search : "");
  let raf = 0;
  let cancelled = false;
  let lastDebugAt = 0;
  let prevGray = null;
  let greenSince = 0;
  let lastDetect = 0;
  let detecting = false;
  let publishedGuide = null;
  const history = [];
  const reuseStab = step === "liveness" && !!livenessStabRef.current;
  const stab = reuseStab ? livenessStabRef.current : createFramingStabilizer();
  if (step === "liveness") livenessStabRef.current = stab;
  else {
    livenessStabRef.current = null;
    livenessFrontalRef.current = null;
    livenessRefSamplesRef.current = [];
  }
  let stable = null;
  const docGate = isDocumentStep(step) ? createDocumentGate() : null;
  let docState = { armed: false, present: false, steady: false, ready: false, shape: null };
  let lastDocSeen = false;
  let lastDocShapeOk = false;
  set.docSeen(false);
  set.docShapeOk(false);
  let docBlockStreak = 0;
  let docClearStreak = 0;
  let docFaceNow = false;
  let docRelaxSince = 0;
  set.docFaceBlocked(false);
  const HOLD_MS = 550;
  const SETTLE_DELTA = 3;
  const DETECT_MS = 110;
  const ALIGN_LOCK_MS = reuseStab ? 120 : 350;
  const BURST_AT = [0, 350, 700];
  const BURST_TOTAL = 800;
  const AWAIT_HINT_MS = 3500;
  const AWAIT_FALLBACK_MS = 9e3;
  const AWAIT_FACE_LOST_MS = 4e3;
  const DOC_SHAPE_RELAX_MS = 5e3;
  const currentAction = ctx.currentAction || null;
  let phase = "align";
  let baselineBox = null;
  let awaitStart = 0;
  let triggerAt = 0;
  let shots = 0;
  let hintShown = false;
  let lastHint = null;
  let lastHintAt = 0;
  let wrongWayStreak = 0;
  const WRONG_WAY_TICKS = 4;
  const isExprAction = () => currentAction === "blink" || currentAction === "open_mouth" || currentAction === "smile";
  const coachDiag = (now) => actionState.armed === false && now - lastPresentAt <= 700 ? isExprAction() ? "none" : "recenter" : wrongWayStreak >= WRONG_WAY_TICKS ? "wrong_way" : now - lastPresentAt > 700 ? "face_lost" : actionState.magnitude > 0.08 ? "further" : "none";
  const headNearMiss = () => !isExprAction() && actionState.armed !== false && actionState.hasPose && !actionState.wrongWay && actionState.magnitude >= 0.6 * (currentAction === "look_up" || currentAction === "look_down" ? 0.2 : 0.22);
  let lastPresentAt = performance.now();
  let actionDet = null;
  let actionState = { ok: false, triggered: false, holding: false, armed: true, hasPose: false };
  let prevModelGray = null;
  let earlyShotTaken = false;
  let expressionShotTaken = false;
  let fallbackBurst = false;
  let budgetHintShown = false;
  let detectEma = null;
  let awaitSamples = 0;
  const AWAIT_MIN_SAMPLES = 12;
  const REISSUE_OFFER_MS = 15e3;
  let reissueOffered = false;
  const telEntry = () => {
    const t = telemetry();
    let e = t.actions.find((a) => a.action === currentAction && !a.done);
    if (!e) {
      e = { action: currentAction, msToTrigger: null, wrongWay: 0, hints: [], frames: 0, mode: null, reissued: false, done: false };
      t.actions.push(e);
    }
    return e;
  };
  const tick = () => {
    if (cancelled) return;
    if (document.hidden) {
      raf = requestAnimationFrame(tick);
      return;
    }
    const video = getVideo();
    if (video) {
      const now = performance.now();
      const faceStep = step === "face" || step === "liveness";
      const requiresFaceModel = !!faceModelEnabled && faceStep;
      const faceGate = requiresFaceModel && detectorStatus === "ready" && !!detector();
      let settled = false;
      let lightOk = true;
      const small = grabAnalysisFrame(video, 160);
      if (small) {
        const gray = toGrayscale(small);
        const motion = prevGray ? frameMotion(prevGray, gray) : 0;
        prevGray = gray;
        history.push(motion);
        if (history.length > 40) history.shift();
        const baseline = history.length >= 8 ? Math.min(...history) : 0;
        const bright = meanBrightness(small);
        lightOk = bright > 35 && bright < 240;
        settled = history.length >= 8 && motion <= baseline + SETTLE_DELTA;
        if (docGate) {
          docState = docGate.update(gray, small.width, small.height);
          if (docState.present !== lastDocSeen) {
            lastDocSeen = docState.present;
            set.docSeen(docState.present);
          }
          const shapeOk = !!(docState.shape && docState.shape.cardLike);
          if (shapeOk !== lastDocShapeOk) {
            lastDocShapeOk = shapeOk;
            set.docShapeOk(shapeOk);
          }
        }
      }
      if (faceModelEnabled && detectorStatus === "failed" && publishedGuide !== "model_error") {
        publishedGuide = "model_error";
        set.framingGuide("model_error");
      } else if (requiresFaceModel && !faceGate && publishedGuide !== "model_loading") {
        publishedGuide = "model_loading";
        set.framingGuide("model_loading");
      }
      const docDetect = isDocumentStep(step) && !!faceModelEnabled && detectorStatus === "ready" && !!detector();
      if ((faceGate || docDetect) && !detecting && now - lastDetect > DETECT_MS && !isCapturing()) {
        lastDetect = now;
        detecting = true;
        const modelFrame = docDetect ? grabFixedFrame(video, 320, 240) : grabSquareFrame(video, 320, 240);
        const detectStart = performance.now();
        detector().detect(modelFrame).then((f) => {
          if (cancelled) return;
          const passMs = performance.now() - detectStart;
          detectEma = detectEma == null ? passMs : detectEma * 0.8 + passMs * 0.2;
          telemetry().detectMs = Math.round(detectEma);
          if (phase === "await") awaitSamples++;
          if (docDetect) {
            const shape = docState.shape;
            const docWidthPx = shape && shape.found ? shape.widthFrac * 320 : 0;
            const blocked = isDominantFace(f && f.box, 320, { docWidthPx });
            docBlockStreak = blocked ? docBlockStreak + 1 : 0;
            docClearStreak = blocked ? 0 : docClearStreak + 1;
            if (!docFaceNow && docBlockStreak >= 2) {
              docFaceNow = true;
              set.docFaceBlocked(true);
            } else if (docFaceNow && docClearStreak >= 3) {
              docFaceNow = false;
              set.docFaceBlocked(false);
            }
            return;
          }
          let next = f || { present: false, inFrame: false, guide: "no_face" };
          if (next.inFrame) {
            const faceCrop = cropImageData(modelFrame, next.box);
            const focus = faceCrop ? laplacianVariance(faceCrop) : 0;
            next = { ...next, observedAt: performance.now(), focus, inFrame: focus >= FACE_FOCUS_MIN, guide: focus >= FACE_FOCUS_MIN ? "ok" : "focus" };
          }
          framingRef.current = next;
          stable = stab.update(next, performance.now());
          if (stable.guide && stable.guide !== publishedGuide) {
            publishedGuide = stable.guide;
            set.framingGuide(stable.guide);
          }
          if (actionDet) {
            const gray = toGrayscale(modelFrame);
            const bandBox = next.box || actionDet.baseline;
            const bands = prevModelGray && bandBox ? bandMotion(prevModelGray, gray, 320, bandBox) : { eyes: 0, mouth: 0 };
            prevModelGray = gray;
            actionState = actionDet.update({ box: next.box, eyes: bands.eyes, mouth: bands.mouth, pose: next.pose || null, expr: next.expr || null });
            wrongWayStreak = actionState.wrongWay ? wrongWayStreak + 1 : 0;
          } else {
            prevModelGray = toGrayscale(modelFrame);
          }
        }).catch(() => {
          if (cancelled) return;
          framingRef.current = { present: false, inFrame: false, guide: "no_face" };
          stable = stab.update(framingRef.current, performance.now());
        }).finally(() => {
          detecting = false;
        });
      }
      const lockedOk = faceGate && !!(stable && stable.locked) && lightOk;
      const poseGate = faceGate && !!(detector() && detector().hasLandmarks);
      if (step === "liveness" && poseGate) {
        const rawBox = framingRef.current && framingRef.current.box;
        const facePresent = !!(stable && stable.present);
        if (facePresent) lastPresentAt = now;
        if (phase === "align") {
          set.green(lockedOk);
          const alignPose = framingRef.current && framingRef.current.pose;
          const alignFrontal = !alignPose || isFrontalPose(alignPose);
          if (alignPose && lockedOk && isReferencePose(alignPose)) {
            const arr = livenessRefSamplesRef.current;
            if (!arr.length || arr[arr.length - 1].observedAt !== framingRef.current.observedAt) {
              arr.push({ yaw: alignPose.yaw, pitch: alignPose.pitch, observedAt: framingRef.current.observedAt });
              if (arr.length > 15) arr.shift();
            }
          }
          if (lockedOk && alignFrontal && stable.lockedSince && now - stable.lockedSince >= ALIGN_LOCK_MS) {
            phase = "await";
            baselineBox = stable && stable.box || rawBox || null;
            const refFromSamples = frontalRefFromSamples(livenessRefSamplesRef.current);
            if (refFromSamples && (!livenessFrontalRef.current || refFromSamples.samples >= 3)) {
              livenessFrontalRef.current = { yaw: refFromSamples.yaw, pitch: refFromSamples.pitch };
            }
            actionDet = createActionDetector(currentAction, baselineBox, {
              frontalRef: livenessFrontalRef.current,
              requireArm: true,
              // count nothing until the face is frontal again
              mirrorPreview: true
              // face steps render the video with scaleX(-1); direction is toward the arrow
            });
            actionState = { ok: false, triggered: false, holding: false, armed: true, hasPose: false };
            earlyShotTaken = false;
            expressionShotTaken = false;
            awaitStart = now;
            awaitSamples = 0;
            hintShown = false;
            reissueOffered = false;
            set.canReissue(false);
            set.livePhase({ phase: "await", startedAt: now, total: 0, hint: false });
          }
        } else if (phase === "await") {
          set.green(true);
          if (framesUsed(currentAction) >= LIVENESS_FRAME_BUDGET) {
            if (!budgetHintShown) {
              budgetHintShown = true;
              set.livePhase({ phase: "await", startedAt: awaitStart, total: 0, hint: "budget" });
            }
            raf = requestAnimationFrame(tick);
            return;
          }
          if (actionDet && actionDet.healed && actionDet.poseBaseline) livenessFrontalRef.current = actionDet.poseBaseline;
          if (rawBox && !earlyShotTaken && !isCapturing()) {
            capture({ livenessAdvance: false, mode: "auto" }).then((ok) => {
              if (!cancelled && ok) earlyShotTaken = true;
            });
          }
          if (earlyShotTaken && !expressionShotTaken && ["blink", "open_mouth"].includes(currentAction) && actionState.ok && !isCapturing()) {
            capture({ livenessAdvance: false, mode: "auto" }).then((ok) => {
              if (!cancelled && ok) expressionShotTaken = true;
            });
          }
          if (facePresent && actionState.triggered) {
            phase = "capturing";
            fallbackBurst = false;
            triggerAt = now;
            shots = 0;
            telEntry().msToTrigger = Math.round(now - awaitStart);
            telEntry().mode = "auto";
            set.canReissue(false);
            set.livePhase({ phase: "capturing", startedAt: now, total: BURST_TOTAL });
          } else if ((awaitSamples >= AWAIT_MIN_SAMPLES || now - awaitStart > AWAIT_HINT_MS) && now - awaitStart >= 2500 && now - lastHintAt > 900 && coachDiag(now) !== lastHint) {
            lastHint = coachDiag(now);
            lastHintAt = now;
            hintShown = true;
            telEntry().hints.push(lastHint);
            if (lastHint === "wrong_way") telEntry().wrongWay++;
            set.livePhase({ phase: "await", startedAt: awaitStart, total: 0, hint: lastHint });
            if (now - awaitStart > REISSUE_OFFER_MS && !reissueOffered) {
              reissueOffered = true;
              set.canReissue(true);
            }
          } else if (hintShown && now - awaitStart > AWAIT_FALLBACK_MS && (!actionState.hasPose || headNearMiss()) && now - lastPresentAt < 2e3 && !isCapturing()) {
            phase = "capturing";
            fallbackBurst = true;
            triggerAt = now;
            shots = 0;
            telEntry().mode = "fallback";
            set.canReissue(false);
            set.livePhase({ phase: "capturing", startedAt: now, total: BURST_TOTAL });
          } else if (now - lastPresentAt > AWAIT_FACE_LOST_MS) {
            phase = "align";
            actionDet = null;
            set.livePhase({ phase: "align", startedAt: 0, total: 0 });
          }
        } else {
          set.green(true);
          const holdRequired = currentAction !== "blink" && currentAction !== "smile" && currentAction !== "open_mouth";
          const tiltAction = currentAction === "look_up" || currentAction === "look_down";
          const stillTurned = actionState.holding || actionState.magnitude >= 0.6 * (tiltAction ? 0.2 : 0.22);
          const canShoot = fallbackBurst ? shots > 0 || facePresent : shots === 0 ? !holdRequired || actionState.holding : !holdRequired || stillTurned;
          const presenceOk = facePresent || fallbackBurst && shots > 0;
          if (shots < BURST_AT.length && now - triggerAt >= BURST_AT[shots] && !isCapturing() && presenceOk && canShoot) {
            const isLast = shots === BURST_AT.length - 1;
            capture({ livenessAdvance: isLast, mode: fallbackBurst ? "fallback" : "auto" }).then((ok) => {
              if (!cancelled && ok) shots++;
            });
          } else if (!fallbackBurst && shots >= 2 && shots < BURST_AT.length && !isCapturing() && now - triggerAt > BURST_AT[shots] + 1200) {
            shots = BURST_AT.length;
            capture({ advanceOnly: true });
          } else if (!isCapturing() && now - triggerAt > BURST_TOTAL + 1500) {
            phase = "await";
            fallbackBurst = false;
            actionDet = createActionDetector(currentAction, baselineBox, { frontalRef: livenessFrontalRef.current, requireArm: true, mirrorPreview: true });
            actionState = { ok: false, triggered: false, holding: false, armed: true, hasPose: false };
            earlyShotTaken = true;
            awaitStart = now;
            hintShown = true;
            lastHint = "none";
            lastHintAt = now;
            set.livePhase({ phase: "await", startedAt: now, total: 0, hint: "none" });
          }
        }
      } else if (!isCapturing()) {
        const docFaceClear = !faceModelEnabled || detectorStatus === "failed" ? true : docDetect && !docFaceNow && docClearStreak >= 2;
        if (docGate && docState.present && lightOk && docFaceClear) {
          if (!docRelaxSince) docRelaxSince = now;
        } else {
          docRelaxSince = 0;
        }
        const docRelaxed = docRelaxSince > 0 && now - docRelaxSince > DOC_SHAPE_RELAX_MS;
        const latestPose = framingRef.current && framingRef.current.pose;
        const frontalOk = step !== "face" || !latestPose || isFrontalPose(latestPose);
        const livenessBlind = step === "liveness" && !(faceGate && detector() && detector().hasLandmarks);
        const inPosition = livenessBlind ? false : requiresFaceModel ? lockedOk && frontalOk : docGate ? (docState.ready || docRelaxed) && lightOk && docFaceClear : settled && lightOk;
        set.green(inPosition);
        if (inPosition) {
          if (!greenSince) greenSince = now;
          else if (now - greenSince > HOLD_MS) {
            greenSince = 0;
            capture();
          }
        } else {
          greenSince = 0;
        }
      }
      if (DEBUG && faceStep && now - lastDebugAt > 250) {
        lastDebugAt = now;
        const p = framingRef.current && framingRef.current.pose;
        const pb = actionDet && actionDet.poseBaseline;
        set.debugInfo({
          phase,
          action: currentAction,
          guide: publishedGuide,
          yaw: p ? p.yaw : null,
          pitch: p ? p.pitch : null,
          dYaw: p && pb ? p.yaw - pb.yaw : null,
          dPitch: p && pb ? p.pitch - pb.pitch : null,
          ratio: framingRef.current && framingRef.current.ratio,
          ok: actionState.ok,
          holding: actionState.holding,
          wrongWay: actionState.wrongWay,
          frames: framesUsed(currentAction)
        });
      }
      const canvas = overlay();
      if (canvas && faceStep) {
        const cw = canvas.width;
        const ch = canvas.height;
        const ctx2 = canvas.getContext("2d");
        ctx2.clearRect(0, 0, cw, ch);
        if (DEBUG) {
          ctx2.strokeStyle = "rgba(255,255,255,0.6)";
          ctx2.lineWidth = 1;
          ctx2.beginPath();
          ctx2.arc(cw / 2, ch / 2, cw * 0.11, 0, 2 * Math.PI);
          ctx2.stroke();
          ctx2.fillStyle = "rgba(255,255,255,0.6)";
          ctx2.beginPath();
          ctx2.arc(cw / 2, ch / 2, 2, 0, 2 * Math.PI);
          ctx2.fill();
        }
        const moving = step === "liveness" && phase !== "align";
        const b = moving ? framingRef.current && framingRef.current.box || stable && stable.box : stable && stable.box || framingRef.current && framingRef.current.box;
        if (b) {
          const x = b.x1 / 320 * cw;
          const y = b.y1 / 240 * ch;
          const w = (b.x2 - b.x1) / 320 * cw;
          const h = (b.y2 - b.y1) / 240 * ch;
          ctx2.strokeStyle = stable && stable.locked ? "#10B981" : "#F59E0B";
          ctx2.lineWidth = 2;
          ctx2.strokeRect(x, y, w, h);
          if (DEBUG) {
            ctx2.fillStyle = "red";
            ctx2.beginPath();
            ctx2.arc(x + w / 2, y + h / 2, 3, 0, 2 * Math.PI);
            ctx2.fill();
          }
        }
      }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    cancelled = true;
    cancelAnimationFrame(raf);
    set.green(false);
    framingRef.current = null;
  };
}

// src/screenFlash.js
import { FLASH, nextVideoFrame, grabSquareFrame as grabSquareFrame2, flashCropRect } from "@verifypass/sdk-core";
async function runScreenFlash(video, box, setColor, sequence, signal) {
  if (!video || !video.videoWidth) return null;
  if (!Array.isArray(sequence) || sequence.length !== FLASH.count) return null;
  const tile = FLASH.tile;
  const steps = [FLASH.baseline, ...sequence];
  const mosaic = document.createElement("canvas");
  mosaic.width = tile * steps.length;
  mosaic.height = tile;
  const mctx = mosaic.getContext("2d");
  const src = document.createElement("canvas");
  src.width = 320;
  src.height = 320;
  const sctx = src.getContext("2d");
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < steps.length; i++) {
    if (signal?.aborted || document.hidden) throw new Error("Capture interrupted");
    setColor(steps[i]);
    await wait(FLASH.sampleDelayMs);
    await nextVideoFrame(video, { signal });
    const frame = grabSquareFrame2(video, 320, 320);
    if (!frame) return null;
    sctx.putImageData(frame, 0, 0);
    const rect = flashCropRect(box, 320, 320);
    if (!rect) return null;
    mctx.drawImage(src, rect.x, rect.y, rect.size, rect.size, i * tile, 0, tile, tile);
    await wait(Math.max(0, FLASH.holdMs - FLASH.sampleDelayMs));
  }
  setColor(null);
  const dataUrl = mosaic.toDataURL("image/jpeg", 0.92);
  return { base64: dataUrl, sequence, tile };
}

// src/copy.js
var DEFAULT_CONSENT_COPY = "I consent to VerifyPass capturing and processing my ID images, my selfie, short video frames of my head movements, and my device and camera details (such as camera type and browser) to verify my identity and prevent fraud. This includes biometric processing. The check may briefly change my screen colour a few times; this is skipped automatically if my device asks for reduced motion. Images are stored securely for the period set by the organisation that requested this verification, then deleted.";
var CONSENT_COPY_VERSION = "2026-10-09.1";
var DEFAULT_COPY = {
  steps: {
    document: { title: "Scan your ID", hint: "Place your ID inside the frame. Avoid glare and shadows." },
    document_back: { title: "Scan the BACK of your ID", hint: "Flip your ID over and place the back inside the frame." },
    liveness: { title: "Liveness check", hint: "Follow the prompt so we know you're really here." },
    face: { title: "Take a selfie", hint: "Look straight at the camera in good lighting." },
    processing: { title: "Verifying\u2026", hint: "This usually takes a few seconds." },
    complete: { title: "Done", hint: "" },
    mobile: { title: "Verify on your phone", hint: "Scan the QR code with your phone camera to continue." }
  },
  // Prompts for each server-issued challenge action.
  actions: {
    // a real blink is ~150 ms — too quick for the capture pipeline, so ask for
    // a slow one: the closed-eye frame is captured while the eyes are shut
    blink: "Close your eyes for a second, then open them",
    open_mouth: "Open your mouth wide and hold it for a moment",
    turn_left: "Slowly turn your head toward the arrow on the LEFT side of the screen",
    turn_right: "Slowly turn your head toward the arrow on the RIGHT side of the screen",
    look_up: "Tilt your head UP \u2014 lift your chin toward the ceiling",
    look_down: "Tilt your head DOWN",
    smile: "Smile"
  },
  // Short on-screen pill text (the arrow carries the side).
  pills: {
    turn_left: "Turn toward the \u2190 arrow",
    turn_right: "Turn toward the \u2192 arrow",
    look_up: "Lift your chin \u2014 look UP",
    look_down: "Lower your chin \u2014 look DOWN",
    blink: "Close your eyes, then open them",
    open_mouth: "Open your mouth wide"
  },
  // Arrow aria-labels: SCREEN-relative on purpose ("your left" is ambiguous on
  // cameras that pre-mirror their frames).
  arrows: {
    turn_left: "Turn your head toward the arrow on the left side of the screen",
    turn_right: "Turn your head toward the arrow on the right side of the screen",
    look_up: "Tilt your head up, lifting your chin toward the ceiling",
    look_down: "Tilt your head down, lowering your chin toward your chest"
  },
  // Diagnosis-driven coaching; each entry receives the current action.
  coach: {
    wrong_way: (a) => a === "look_up" ? "That's down \u2014 lift your chin and look UP" : a === "look_down" ? "That's up \u2014 lower your chin and look DOWN" : "Other way \u2014 turn your head toward the arrow",
    face_lost: () => "We lost your face \u2014 come back a little so we can still see you",
    recenter: () => "Face the camera straight first \u2014 then do the movement",
    budget: () => "We've recorded everything we can for this movement. Continue \u2014 if it isn't accepted you'll be asked to try again.",
    further: (a) => a === "look_up" ? "Almost \u2014 lift your chin further, toward the ceiling" : a === "look_down" ? "Almost \u2014 lower your chin a bit more" : a === "blink" ? "Almost \u2014 close your eyes fully for a second, then open them" : a === "open_mouth" ? "Almost \u2014 open your mouth wider and hold it" : "Almost \u2014 keep turning toward the arrow and hold it",
    none: (a) => a === "look_up" || a === "look_down" ? "We haven't seen it yet \u2014 tilt your head slowly and hold" : a === "blink" ? "We haven't seen it yet \u2014 close your eyes for a full second, then open them" : a === "open_mouth" ? "We haven't seen it yet \u2014 open your mouth wide and hold it" : "We haven't seen it yet \u2014 turn slowly toward the arrow and hold"
  },
  // Framing guidance from the client face model.
  guide: {
    model_loading: "Loading face model...",
    model_error: "Face model unavailable - capture manually",
    no_face: "Position your face in the circle",
    move_closer: "Move closer",
    move_back: "Move back",
    center: "Center your face",
    focus: "Hold steady - image is soft"
  },
  issues: {
    DOCUMENT_BLURRY: "Image looks blurry \u2014 hold steady and try again.",
    TOO_DARK: "Too dark \u2014 move somewhere brighter.",
    TOO_BRIGHT: "Too bright \u2014 reduce direct light or glare."
  },
  // Labels for user-actionable rejection reason codes on the result screen.
  reasons: {
    LIVENESS_FAILED: "Liveness check failed",
    LIVENESS_BORDERLINE: "Liveness score was borderline",
    LIVENESS_CHALLENGE_FAILED: "Liveness challenge actions not detected",
    LIVENESS_CHALLENGE_INCOMPLETE: "Liveness challenge was not completed",
    LIVENESS_CHALLENGE_EXPIRED: "The liveness challenge timed out \u2014 try again",
    LIVENESS_CHALLENGE_SEQUENCE_INVALID: "The movements took too long or were out of order \u2014 try again without pausing",
    LIVENESS_POSE_UNAVAILABLE: "We couldn't measure your head movements \u2014 try again with your face well lit and fully in the circle",
    DOCUMENT_IMAGE_LOW_QUALITY: "Your ID photo was blurry or poorly lit",
    DOCUMENT_IS_LIVE_FACE: "We saw a face instead of your ID card",
    SESSION_TIMEOUT: "The verification took too long \u2014 please try again",
    FACE_MATCH_FAILED: "Face doesn't match the ID document",
    FACE_MATCH_BORDERLINE: "Face similarity score was borderline",
    NO_FACE_ON_SELFIE: "No face detected in your selfie",
    NO_FACE_ON_DOCUMENT: "No face detected on your ID document",
    MULTIPLE_FACES_DETECTED: "Multiple faces detected in the image",
    DOCUMENT_OCR_FAILED: "Could not read the text on your ID",
    DOCUMENT_EXPIRED: "Your ID document appears to be expired",
    DEVICE_SHARED_ACROSS_IDENTITIES: "This device has been flagged for suspicious activity",
    TOO_MANY_FAILED_ATTEMPTS: "Too many failed attempts \u2014 please try again later",
    IP_RATE_LIMIT: "Too many requests from your network"
  },
  consent: {
    title: "Consent required",
    statement: DEFAULT_CONSENT_COPY,
    continue: "Continue",
    or: "or",
    showQr: "Show QR code",
    qrHint: "Scan it with your phone and finish there. You'll give consent on your phone."
  },
  capture: {
    livenessTitle: (index, total) => `Liveness check (${index}/${total})`,
    pillDocument: "Fit your ID inside the frame",
    pillFace: "Center your face in the circle",
    positionFace: "Position your face",
    startingCamera: "Starting camera\u2026",
    gotIt: "Got it \u2014 hold on\u2026",
    doItNow: "Do it now \u2014 we'll capture automatically",
    uploading: "Uploading\u2026",
    loadingDetection: "Loading face detection\u2026",
    noAutoDetection: "Automatic detection isn't available here \u2014 do the movement, then tap Capture manually",
    getReady: "Get ready\u2026",
    centerToBegin: "Center your face to begin",
    holdStill: "Hold still\u2026",
    alignFace: "Align your face in the circle",
    documentIsFace: "That's a face \u2014 hold up your ID card instead",
    documentFit: "Fit your ID inside the box",
    documentHold: "Hold steady\u2026",
    retry: "Retry",
    flashHold: "Hold still \u2014 checking lighting",
    cameraPaused: "Camera paused \u2014 tap to resume",
    cameraDenied: "Camera permission was denied. Please allow camera access in your device/browser settings, then click Retry.",
    cameraFailed: "Failed to access camera.",
    reissue: "I can't do this movement \u2014 try a different one",
    continueNext: "Continue to the next movement",
    captureManually: "Capture manually",
    uploadDocument: "Upload a photo of your ID instead"
  },
  processing: { message: "Checking liveness and matching your ID\u2026" },
  mobile: {
    intro: "Open your phone's camera app and point it at this QR code. It opens the verification page in your phone's browser.",
    qrAlt: "QR code \u2014 scan with your phone camera",
    generating: "Generating QR\u2026",
    retryQr: "Retry QR code",
    copyLink: "Copy secure link",
    openHere: "Open on this device",
    linkCopied: "Secure link copied. Treat it like a password.",
    copyFailed: "Could not copy the link. Open it in a new tab instead.",
    qrEncodeFailed: "Unable to generate the QR code. Retry or copy the secure link.",
    qrLoadFailed: "Unable to load the QR generator. Retry or copy the secure link.",
    privacy: "This code and link are private, expire shortly, and can be claimed once. Do not share or screenshot them.",
    codeExpires: (time2) => ` Code expires ${time2}.`,
    sessionExpires: (time2) => ` Session expires ${time2}.`,
    verifying: "Verifying on your phone \u2014 this usually takes a few seconds",
    finalising: "Finalising your verification on your phone\u2026",
    waiting: "Scan the code above to begin",
    useThisDevice: "Use this device instead"
  },
  outcome: {
    approved: "Verification approved.",
    manual_review: "Your verification is under review. You can wait to be notified \u2014 or try again now.",
    unsuccessful: "Verification was not successful.",
    improve: "What to improve if you try again:",
    reasons: "Reasons:",
    tryAgain: "Try again",
    restarting: "Restarting\u2026",
    attempt: (attempts, max) => `Attempt ${attempts} of ${max}`,
    manualUploadNext: " \u2014 you can also upload a photo of your ID on the next try",
    exhausted: "All attempts have been used. Please contact support to continue."
  },
  loading: "Loading verification\u2026",
  retryLoading: "Retry loading verification"
};
function mergeCopy(overrides, consentCopy) {
  const out = { ...DEFAULT_COPY };
  if (overrides && typeof overrides === "object") {
    for (const [key, value] of Object.entries(overrides)) {
      const base = DEFAULT_COPY[key];
      if (base && typeof base === "object" && value && typeof value === "object") {
        out[key] = { ...base };
        for (const [k, v] of Object.entries(value)) {
          out[key][k] = base[k] && typeof base[k] === "object" && v && typeof v === "object" ? { ...base[k], ...v } : v;
        }
      } else if (value !== void 0) {
        out[key] = value;
      }
    }
  }
  if (typeof consentCopy === "string" && consentCopy) out.consent = { ...out.consent, statement: consentCopy };
  return out;
}
function fmt(entry, ...args) {
  return typeof entry === "function" ? entry(...args) : entry;
}

// src/useVerification.js
var DOC_GUIDE = { displayAspect: 340 / 212, widthFrac: 0.88, regionAspect: 1.586 };
var FACING = { document: "environment", document_back: "environment", liveness: "user", face: "user" };
var MODEL_TIMEOUT_MS = 12e3;
var HOSTED_MODEL_TIMEOUT_MS = 3e4;
var warnedModelFailure = false;
function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return void 0;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e) => setReduced(e.matches);
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);
  return reduced;
}
function useVerification(opts) {
  const config = useVerifyPassConfig();
  const pick = (k) => opts[k] === void 0 ? config[k] : opts[k];
  const publicKey = pick("publicKey");
  const baseUrl = pick("baseUrl");
  const faceModelSetting = pick("faceModelUrl");
  const landmarkModelUrl = pick("landmarkModelUrl");
  const ortWasmUrl = pick("ortWasmUrl");
  const { sessionId, sdkToken, mobileHandoff, screenFlash = true, onComplete, onError, onStepChange, onTelemetry } = opts;
  const copy = useMemo2(() => mergeCopy(opts.copy, opts.consentCopy), [opts.copy, opts.consentCopy]);
  const copyRef = useRef(copy);
  copyRef.current = copy;
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const detectorRef = useRef(null);
  const framingRef = useRef(null);
  const livenessStabRef = useRef(null);
  const livenessFrontalRef = useRef(null);
  const livenessRefSamplesRef = useRef([]);
  const ctrlRef = useRef(null);
  const callbacks = { onComplete, onError, onStepChange, onTelemetry };
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const [vp, setVp] = useState(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraPaused, setCameraPaused] = useState(false);
  const [cameraEpoch, setCameraEpoch] = useState(0);
  const [detectorStatus, setDetectorStatus] = useState(faceModelSetting === null ? "disabled" : "loading");
  const [green, setGreen] = useState(false);
  const [framingGuide, setFramingGuide] = useState("no_face");
  const [livePhase, setLivePhase] = useState({ phase: "align", startedAt: 0, total: 0 });
  const [docSeen, setDocSeen] = useState(false);
  const [docShapeOk, setDocShapeOk] = useState(false);
  const [docFaceBlocked, setDocFaceBlocked] = useState(false);
  const [canReissue, setCanReissue] = useState(false);
  const [debugInfo, setDebugInfo] = useState(null);
  const [flashColor, setFlashColor] = useState(null);
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [qrError, setQrError] = useState(null);
  const [qrRetryEpoch, setQrRetryEpoch] = useState(0);
  const reducedMotion = usePrefersReducedMotion();
  const screenFlashRef = useRef(false);
  screenFlashRef.current = screenFlash && !reducedMotion;
  useEffect(() => {
    const c = createVerificationController({
      sessionId,
      sdkToken,
      publicKey,
      baseUrl,
      mobileHandoff,
      onComplete: (r) => callbacksRef.current.onComplete?.(r),
      onError: (e) => callbacksRef.current.onError?.(e),
      onStepChange: (s) => callbacksRef.current.onStepChange?.(s),
      onTelemetry: (t) => callbacksRef.current.onTelemetry?.(t)
    });
    ctrlRef.current = c;
    const off = c.subscribe(setVp);
    setVp(c.getState());
    c.start();
    return () => {
      off();
      c.dispose();
      if (ctrlRef.current === c) ctrlRef.current = null;
      setVp(null);
    };
  }, [sessionId, sdkToken, publicKey, baseUrl, mobileHandoff]);
  const step = vp?.flow?.step || null;
  const consented = !!vp?.consented;
  const challengeEpoch = vp?.challengeEpoch || 0;
  const attemptEpoch = vp?.attemptEpoch || 0;
  const currentAction = vp ? vp.actions[vp.actionIndex] || null : null;
  useEffect(() => {
    livenessFrontalRef.current = null;
    livenessRefSamplesRef.current = [];
    setCanReissue(false);
  }, [challengeEpoch]);
  useEffect(() => {
    livenessStabRef.current = null;
  }, [attemptEpoch]);
  const captureFacing = FACING[step] || null;
  useEffect(() => {
    const c = ctrlRef.current;
    if (!c || !consented || !captureFacing) return void 0;
    const video = videoRef.current;
    if (!video) return void 0;
    let cancelled = false;
    const cameraController = new AbortController();
    setCameraReady(false);
    startCamera(video, { facingMode: captureFacing, signal: cameraController.signal }).then((stream) => {
      if (cancelled) {
        stream.getTracks().forEach((t2) => t2.stop());
        return;
      }
      collectCaptureSignals(stream).then((sig) => {
        if (!cancelled && sig && c.client) c.client.setCaptureSignals(sig);
      }).catch(() => {
      });
      const track = stream.getVideoTracks && stream.getVideoTracks()[0];
      if (track) track.onended = () => {
        if (!cancelled) {
          setCameraReady(false);
          setCameraPaused(true);
        }
      };
      const t = c.getTelemetry();
      if (!t.startedAt) t.startedAt = performance.now();
      setCameraReady(true);
    }).catch((err) => {
      if (cancelled || cameraController.signal.aborted) return;
      const k = copyRef.current.capture;
      const isPermission = err.name === "NotAllowedError" || err.name === "PermissionDeniedError" || /permission/i.test(err.message || "");
      const userMessage = err.message && !/permission denied/i.test(err.message) ? err.message : isPermission ? k.cameraDenied : err.message || k.cameraFailed;
      c.reportCameraError(err, userMessage);
    });
    const pauseCamera = () => {
      if (cancelled) return;
      cameraController.abort();
      stopCamera(video);
      setCameraReady(false);
      setCameraPaused(true);
      livenessFrontalRef.current = null;
      livenessRefSamplesRef.current = [];
    };
    const onVis = () => {
      if (document.hidden) pauseCamera();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("orientationchange", pauseCamera);
    return () => {
      cancelled = true;
      cameraController.abort();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("orientationchange", pauseCamera);
      stopCamera(video);
      setCameraReady(false);
    };
  }, [captureFacing, consented, cameraEpoch]);
  const assetBaseUrl = hostedAssetBase(vp?.hostedBaseUrl);
  const challengeLoaded = vp?.status === "ready";
  const faceModelUrl = faceModelSetting === null ? null : typeof faceModelSetting === "string" ? faceModelSetting : !challengeLoaded ? void 0 : hostedModelUrl(assetBaseUrl, "fr_detect.onnx") || DEFAULT_FACE_MODEL_URL;
  const faceModelEnabled = faceModelSetting !== null;
  useEffect(() => {
    if (faceModelUrl === null) {
      detectorRef.current = null;
      setDetectorStatus("disabled");
      return void 0;
    }
    detectorRef.current = null;
    setDetectorStatus("loading");
    if (faceModelUrl === void 0) return void 0;
    let disposed = false;
    let det = null;
    const modelController = new AbortController();
    let timedOut = false;
    let timeoutId;
    const usesHostedWasm = !ortWasmUrl && !hasBundledOrtWasm && !!assetBaseUrl;
    const timeout = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => {
        timedOut = true;
        modelController.abort();
        reject(new Error("Face model load timed out"));
      }, usesHostedWasm ? HOSTED_MODEL_TIMEOUT_MS : MODEL_TIMEOUT_MS);
    });
    const detectorOpts = { landmarkUrl: landmarkModelUrl, ortWasmUrl, assetBaseUrl, framing: { minRatio: 0.24, centerTol: 0.13 }, signal: modelController.signal };
    const loadStart = performance.now();
    Promise.race([createFaceDetector(faceModelUrl, detectorOpts).then((d) => {
      if (disposed || timedOut) {
        d.dispose?.();
        throw new Error("Model load cancelled");
      }
      return d;
    }), timeout]).then((d) => {
      if (disposed) {
        d.dispose && d.dispose();
        return;
      }
      clearTimeout(timeoutId);
      det = d;
      detectorRef.current = d;
      const c = ctrlRef.current;
      if (c) c.getTelemetry().modelLoadMs = Math.round(performance.now() - loadStart);
      setDetectorStatus("ready");
    }).catch((err) => {
      clearTimeout(timeoutId);
      if (disposed) return;
      detectorRef.current = null;
      setDetectorStatus("failed");
      callbacksRef.current.onTelemetry?.({ type: "face_model_load_failed", errorName: err && err.name || "Error", timedOut, hostedAssets: usesHostedWasm });
      if (!warnedModelFailure && typeof console !== "undefined") {
        warnedModelFailure = true;
        console.warn("[VerifyPass] Face model failed to load; falling back to motion-based capture.", err && err.message);
      }
    });
    return () => {
      disposed = true;
      modelController.abort();
      clearTimeout(timeoutId);
      detectorRef.current = null;
      if (det && det.dispose) det.dispose();
    };
  }, [faceModelUrl, landmarkModelUrl, ortWasmUrl, assetBaseUrl]);
  const capture = useCallback((o = {}) => {
    const c = ctrlRef.current;
    if (!c) return void 0;
    const livenessAdvance = o.livenessAdvance !== false;
    const captureMode = typeof o.mode === "string" ? o.mode : "manual";
    return c.runCapture(async (cap) => {
      const s = c.getState().flow.step;
      if (s === "liveness" && o.advanceOnly) {
        c.advanceLiveness();
        return true;
      }
      if (s === "liveness" && c.livenessBudgetSpent()) {
        if (livenessAdvance) c.advanceLiveness();
        return void 0;
      }
      await nextVideoFrame2(videoRef.current, { signal: c.client.controller.signal });
      const { imageData, base64 } = isDocumentStep(s) ? captureGuideFrame(videoRef.current, DOC_GUIDE) : s === "liveness" ? captureFrame(videoRef.current, null, { maxSide: 640, quality: 0.85 }) : captureFrame(videoRef.current);
      const skipSharpness = s === "liveness" || s === "face" && !!detectorRef.current;
      const quality = assessFrame(imageData, skipSharpness ? { minSharpness: 0 } : void 0);
      if (!quality.ok) {
        c.setFeedback(quality.issues.map((i) => fmt(copyRef.current.issues[i]) || i).join(" "));
        return void 0;
      }
      if (isDocumentStep(s)) return cap.document(base64);
      if (s === "liveness") return cap.livenessFrame(base64, captureMode, livenessAdvance);
      if (s === "face") {
        return cap.face(base64, {
          // Screen-flash liveness while the face is framed; record-first.
          flash: async (sequence, signal) => {
            if (!(screenFlashRef.current && detectorRef.current && framingRef.current && framingRef.current.box)) return null;
            try {
              return await runScreenFlash(videoRef.current, framingRef.current.box, setFlashColor, sequence, signal);
            } finally {
              setFlashColor(null);
            }
          }
        });
      }
      return void 0;
    });
  }, []);
  const captureRef = useRef(capture);
  captureRef.current = capture;
  useEffect(() => {
    const c = ctrlRef.current;
    if (!c || !cameraReady || !step) return void 0;
    return runCaptureLoop({
      step,
      currentAction,
      faceModelEnabled,
      detectorStatus,
      video: () => videoRef.current,
      overlay: () => overlayRef.current,
      detector: () => detectorRef.current,
      isCapturing: () => c.isCapturing(),
      framesUsed: (a) => c.framesUsed(a),
      telemetry: () => c.getTelemetry(),
      capture: (o) => captureRef.current(o),
      framingRef,
      livenessStabRef,
      livenessFrontalRef,
      livenessRefSamplesRef,
      set: {
        green: setGreen,
        framingGuide: setFramingGuide,
        livePhase: setLivePhase,
        docSeen: setDocSeen,
        docShapeOk: setDocShapeOk,
        docFaceBlocked: setDocFaceBlocked,
        canReissue: setCanReissue,
        debugInfo: setDebugInfo
      }
    });
  }, [cameraReady, step, vp?.actionIndex, challengeEpoch, faceModelEnabled, detectorStatus]);
  const handoffUrl = vp?.handoff?.url || null;
  useEffect(() => {
    setQrDataUrl(null);
    setQrError(null);
    if (!handoffUrl) return void 0;
    let cancelled = false;
    import("qrcode").then(async (QR) => {
      try {
        const dataUrl = await QR.toDataURL(handoffUrl, { errorCorrectionLevel: "M", margin: 2, width: 256 });
        if (!cancelled) {
          setQrDataUrl(dataUrl);
          setQrError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setQrError("encode");
          callbacksRef.current.onTelemetry?.({ type: "mobile_handoff_qr_failed", stage: "encode", errorName: err?.name || "Error" });
        }
      }
    }).catch((err) => {
      if (!cancelled) {
        setQrError("load");
        callbacksRef.current.onTelemetry?.({ type: "mobile_handoff_qr_failed", stage: "load", errorName: err?.name || "Error" });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [handoffUrl, qrRetryEpoch]);
  const ctrl = () => ctrlRef.current;
  return {
    /** Controller state (null until mounted): status, initError, flow, actions, attempts, handoff, ... */
    state: vp,
    step,
    copy,
    currentAction,
    videoRef,
    overlayRef,
    cameraReady,
    cameraPaused,
    detectorStatus,
    hasLandmarks: !!(detectorRef.current && detectorRef.current.hasLandmarks),
    green,
    framingGuide,
    livePhase,
    docSeen,
    docShapeOk,
    docFaceBlocked,
    canReissue,
    debugInfo,
    flashColor,
    qrDataUrl,
    qrError,
    capture,
    retryInit: () => ctrl()?.start(),
    recordConsent: (version) => ctrl()?.recordConsent(version),
    selectHandoff: (enabled) => ctrl()?.selectHandoff(enabled),
    retryHandoff: () => ctrl()?.retryHandoff(),
    copyHandoffLink: () => ctrl()?.copyHandoffLink(),
    retryQr: () => setQrRetryEpoch((e) => e + 1),
    uploadDocumentFile: (file) => ctrl()?.uploadDocumentFile(file),
    retry: () => ctrl()?.retry(),
    reissue: () => ctrl()?.reissue(),
    retryStep: () => ctrl()?.retryStep(),
    resumeCamera: () => {
      setCameraPaused(false);
      setCameraEpoch((e) => e + 1);
    },
    controller: ctrlRef.current
  };
}

// src/theme.js
var T = {
  primary: "var(--vp-primary, #6D28D9)",
  onPrimary: "var(--vp-on-primary, #fff)",
  surface: "var(--vp-surface, #fff)",
  text: "var(--vp-text, #374151)",
  muted: "var(--vp-muted, #6B7280)",
  subtle: "var(--vp-subtle, #9CA3AF)",
  border: "var(--vp-border, #E5E7EB)",
  success: "var(--vp-success, #059669)",
  successBright: "var(--vp-success-bright, #10B981)",
  warning: "var(--vp-warning, #B45309)",
  danger: "var(--vp-danger, #DC2626)",
  pill: "var(--vp-pill-bg, #111827)",
  font: "var(--vp-font, system-ui, sans-serif)",
  radius: "var(--vp-radius, 8px)"
};
var THEME_VARS = {
  primaryColor: "--vp-primary",
  onPrimaryColor: "--vp-on-primary",
  surfaceColor: "--vp-surface",
  textColor: "--vp-text",
  mutedColor: "--vp-muted",
  borderColor: "--vp-border",
  successColor: "--vp-success",
  warningColor: "--vp-warning",
  dangerColor: "--vp-danger",
  fontFamily: "--vp-font",
  borderRadius: "--vp-radius"
};
function themeStyle(theme = {}) {
  const style = {};
  for (const [key, cssVar] of Object.entries(THEME_VARS)) {
    const value = theme[key];
    if (typeof value === "string" && value && !/[;{}<>]/.test(value)) style[cssVar] = value;
  }
  if (typeof theme.backgroundColor === "string" && theme.backgroundColor) style.background = theme.backgroundColor;
  return style;
}

// src/components/ConsentGate.jsx
import { useState as useState2 } from "react";
import { Fragment, jsx as jsx2, jsxs } from "react/jsx-runtime";
function ConsentGate({ copy, logoUrl, feedback, busy, allowsHandoffChoice, onConsent, onShowQr }) {
  const [checked, setChecked] = useState2(false);
  const k = copy.consent;
  return /* @__PURE__ */ jsxs("div", { "data-vp-part": "consent", style: { maxWidth: 420, margin: "0 auto", fontFamily: T.font }, children: [
    logoUrl && /* @__PURE__ */ jsx2("img", { src: logoUrl, alt: "", style: { height: 32, marginBottom: 12 } }),
    /* @__PURE__ */ jsx2("h2", { style: { margin: "0 0 8px", fontSize: 20 }, children: k.title }),
    feedback && /* @__PURE__ */ jsx2("p", { role: "alert", children: feedback }),
    /* @__PURE__ */ jsxs("label", { style: { display: "flex", gap: 10, alignItems: "flex-start", color: T.text, fontSize: 14, lineHeight: 1.45 }, children: [
      /* @__PURE__ */ jsx2("input", { type: "checkbox", checked, onChange: (e) => setChecked(e.target.checked), style: { marginTop: 3, accentColor: T.primary } }),
      /* @__PURE__ */ jsx2("span", { children: k.statement })
    ] }),
    /* @__PURE__ */ jsx2(
      "button",
      {
        type: "button",
        onClick: () => onConsent(CONSENT_COPY_VERSION),
        disabled: !checked || busy,
        style: {
          width: "100%",
          marginTop: 16,
          padding: "12px 0",
          borderRadius: T.radius,
          background: T.primary,
          color: T.onPrimary,
          border: 0,
          fontSize: 16,
          cursor: checked ? "pointer" : "not-allowed",
          opacity: checked ? 1 : 0.45
        },
        children: k.continue
      }
    ),
    allowsHandoffChoice && /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 10, margin: "16px 0 12px", color: T.subtle, fontSize: 12 }, children: [
        /* @__PURE__ */ jsx2("span", { style: { flex: 1, height: 1, background: T.border } }),
        k.or,
        /* @__PURE__ */ jsx2("span", { style: { flex: 1, height: 1, background: T.border } })
      ] }),
      /* @__PURE__ */ jsx2(
        "button",
        {
          type: "button",
          onClick: onShowQr,
          style: {
            width: "100%",
            padding: "12px 0",
            borderRadius: T.radius,
            background: T.surface,
            color: T.primary,
            border: `2px solid ${T.primary}`,
            fontSize: 16,
            fontWeight: 600,
            cursor: "pointer"
          },
          children: k.showQr
        }
      ),
      /* @__PURE__ */ jsx2("p", { style: { margin: "8px 0 0", fontSize: 13, color: T.muted, textAlign: "center", lineHeight: 1.4 }, children: k.qrHint })
    ] })
  ] });
}

// src/components/ActionArrow.jsx
import { jsx as jsx3, jsxs as jsxs2 } from "react/jsx-runtime";
var ACTION_ARROWS = {
  turn_left: { rotate: 180, pos: { left: 6, top: "50%", transform: "translateY(-50%)" } },
  turn_right: { rotate: 0, pos: { right: 6, top: "50%", transform: "translateY(-50%)" } },
  look_up: { rotate: -90, pos: { top: 6, left: "50%", transform: "translateX(-50%)" } },
  look_down: { rotate: 90, pos: { bottom: 6, left: "50%", transform: "translateX(-50%)" } }
};
function ActionArrow({ action, copy }) {
  const spec = ACTION_ARROWS[action];
  if (!spec) return null;
  return /* @__PURE__ */ jsxs2(
    "div",
    {
      role: "img",
      "aria-label": copy.arrows[action],
      style: { position: "absolute", zIndex: 2, pointerEvents: "none", ...spec.pos },
      children: [
        /* @__PURE__ */ jsx3("div", { style: { transform: `rotate(${spec.rotate}deg)` }, children: /* @__PURE__ */ jsx3("svg", { width: "52", height: "52", viewBox: "0 0 52 52", style: { animation: "vp-arrow-nudge 0.9s ease-in-out infinite", display: "block", filter: "drop-shadow(0 1px 4px rgba(0,0,0,0.6))" }, children: /* @__PURE__ */ jsx3(
          "path",
          {
            d: "M6 26 H34 M24 12 L40 26 L24 40",
            fill: "none",
            stroke: "#FFFFFF",
            strokeWidth: "7",
            strokeLinecap: "round",
            strokeLinejoin: "round"
          }
        ) }) }),
        /* @__PURE__ */ jsx3("style", { children: "@keyframes vp-arrow-nudge { 0%,100% { transform: translateX(0) } 50% { transform: translateX(10px) } }" })
      ]
    }
  );
}

// src/components/CaptureView.jsx
import { jsx as jsx4, jsxs as jsxs3 } from "react/jsx-runtime";
function CaptureView({ v }) {
  const { state: vp, copy, step, livePhase, green } = v;
  const busy = vp.busy;
  const k = copy.capture;
  const isLiveness = step === "liveness";
  const isDoc = isDocumentStep(step);
  const faceStep = step === "face" || isLiveness;
  const livenessAction = isLiveness ? v.currentAction : null;
  const frameW = isDoc ? 340 : 280;
  const frameH = isDoc ? 212 : 280;
  const pillText = isLiveness ? copy.pills[livenessAction] || copy.actions[livenessAction] || livenessAction : isDoc ? k.pillDocument : k.pillFace;
  const awaiting = isLiveness && livePhase.phase === "await";
  const capturingBurst = isLiveness && livePhase.phase === "capturing";
  const performing = awaiting || capturingBurst;
  const showGuide = faceStep && !green && !performing;
  const pillDisplay = showGuide ? copy.guide[v.framingGuide] || k.positionFace : pillText;
  const ringColor = green ? T.success : T.border;
  const autoDetection = v.detectorStatus === "ready" && v.hasLandmarks;
  const error = vp.flow.error;
  const coach = livePhase.hint ? copy.coach[livePhase.hint] : null;
  return /* @__PURE__ */ jsxs3("div", { "data-vp-part": "capture", children: [
    /* @__PURE__ */ jsxs3("div", { style: { position: "relative", width: frameW, margin: "0 auto" }, children: [
      /* @__PURE__ */ jsx4("div", { "aria-live": "assertive", role: "status", style: {
        position: "absolute",
        top: 10,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 2,
        background: T.pill,
        color: "#fff",
        padding: "6px 14px",
        borderRadius: 999,
        fontSize: 14,
        whiteSpace: "nowrap",
        maxWidth: "calc(100% - 16px)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        boxShadow: "0 2px 10px rgba(0,0,0,0.25)"
      }, children: pillDisplay }),
      /* @__PURE__ */ jsxs3("div", { style: {
        position: "relative",
        width: frameW,
        height: frameH,
        margin: "0 auto",
        borderRadius: isDoc ? 16 : "50%",
        overflow: "hidden",
        background: "#111",
        border: `4px solid ${ringColor}`,
        boxShadow: green ? "0 0 0 4px rgba(5,150,105,0.25)" : "none",
        transition: "border-color .15s, box-shadow .15s"
      }, children: [
        /* @__PURE__ */ jsx4(
          "video",
          {
            ref: v.videoRef,
            playsInline: true,
            muted: true,
            style: { width: "100%", height: "100%", objectFit: "cover", transform: isDoc ? "none" : "scaleX(-1)" }
          }
        ),
        isDoc && /* card-aspect guide — capture crops to exactly this box */
        /* @__PURE__ */ jsx4("div", { style: {
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: `${DOC_GUIDE.widthFrac * 100}%`,
          aspectRatio: `${DOC_GUIDE.regionAspect} / 1`,
          border: `3px dashed ${green ? T.successBright : "rgba(255,255,255,0.85)"}`,
          borderRadius: 12,
          pointerEvents: "none",
          boxSizing: "border-box",
          zIndex: 1,
          boxShadow: "0 0 0 999px rgba(0,0,0,0.35)",
          transition: "border-color .15s"
        } }),
        faceStep && /* @__PURE__ */ jsx4(
          "canvas",
          {
            ref: v.overlayRef,
            width: frameW,
            height: frameH,
            style: {
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              transform: "scaleX(-1)",
              pointerEvents: "none",
              zIndex: 1
            }
          }
        ),
        isLiveness && performing && /* @__PURE__ */ jsx4(ActionArrow, { action: livenessAction, copy })
      ] })
    ] }),
    capturingBurst && /* @__PURE__ */ jsxs3("div", { style: { width: frameW, height: 6, background: T.border, borderRadius: 3, margin: "12px auto 0", overflow: "hidden" }, children: [
      /* @__PURE__ */ jsx4(
        "div",
        {
          style: {
            height: "100%",
            background: T.success,
            borderRadius: 3,
            transformOrigin: "left",
            animation: `vp-progress ${livePhase.total}ms linear forwards`
          }
        },
        livePhase.startedAt
      ),
      /* @__PURE__ */ jsx4("style", { children: "@keyframes vp-progress { from { transform: scaleX(0) } to { transform: scaleX(1) } }" })
    ] }),
    /* @__PURE__ */ jsx4("p", { "aria-live": "polite", role: "status", style: { textAlign: "center", fontSize: 14, margin: "12px 0 0", minHeight: 18, color: green ? T.success : T.muted }, children: !v.cameraReady ? k.startingCamera : capturingBurst ? k.gotIt : awaiting ? livePhase.hint ? coach ? fmt(coach, livenessAction) : fmt(copy.coach.none, livenessAction) : k.doItNow : busy ? k.uploading : isLiveness && v.detectorStatus === "loading" ? k.loadingDetection : isLiveness && !autoDetection ? k.noAutoDetection : isLiveness ? green ? k.getReady : k.centerToBegin : green ? k.holdStill : faceStep ? k.alignFace : v.docFaceBlocked ? k.documentIsFace : v.docSeen && !v.docShapeOk ? k.documentFit : v.docSeen ? k.documentHold : k.documentFit }),
    v.debugInfo && /* @__PURE__ */ jsx4("pre", { style: { fontSize: 11, background: "#111827", color: "#A7F3D0", padding: 8, borderRadius: 6, margin: "8px 0 0", whiteSpace: "pre-wrap" }, children: `phase ${v.debugInfo.phase} action ${v.debugInfo.action || "-"} guide ${v.debugInfo.guide || "-"} ratio ${v.debugInfo.ratio != null ? v.debugInfo.ratio.toFixed(2) : "-"}
yaw ${v.debugInfo.yaw != null ? v.debugInfo.yaw.toFixed(2) : "-"} pitch ${v.debugInfo.pitch != null ? v.debugInfo.pitch.toFixed(2) : "-"}  \u0394yaw ${v.debugInfo.dYaw != null ? v.debugInfo.dYaw.toFixed(2) : "-"} \u0394pitch ${v.debugInfo.dPitch != null ? v.debugInfo.dPitch.toFixed(2) : "-"}
ok ${v.debugInfo.ok} holding ${v.debugInfo.holding} wrongWay ${v.debugInfo.wrongWay} frames ${v.debugInfo.frames}` }),
    vp.feedback && /* @__PURE__ */ jsx4("p", { style: { color: T.warning, fontSize: 13, textAlign: "center", margin: "6px 0 0" }, children: vp.feedback }),
    error && /* @__PURE__ */ jsxs3("p", { style: { color: T.danger, fontSize: 13, textAlign: "center", margin: "6px 0 0" }, children: [
      error.message,
      " ",
      /* @__PURE__ */ jsx4("button", { onClick: v.retryStep, style: { textDecoration: "underline", background: "none", border: 0, color: "inherit", cursor: "pointer" }, children: k.retry })
    ] }),
    v.flashColor && /* @__PURE__ */ jsx4(
      "div",
      {
        "aria-hidden": "true",
        style: { position: "fixed", inset: 0, zIndex: 9999, background: `rgb(${v.flashColor[0]},${v.flashColor[1]},${v.flashColor[2]})`, display: "flex", alignItems: "flex-end", justifyContent: "center", pointerEvents: "none" },
        children: /* @__PURE__ */ jsx4("div", { style: { marginBottom: 32, padding: "6px 14px", borderRadius: 999, background: "rgba(0,0,0,0.55)", color: "#fff", fontSize: 14 }, children: k.flashHold })
      }
    ),
    v.cameraPaused && /* @__PURE__ */ jsx4(
      "button",
      {
        onClick: v.resumeCamera,
        style: { width: "100%", marginTop: 14, padding: "10px 0", borderRadius: T.radius, background: T.primary, color: T.onPrimary, border: 0, fontSize: 14, cursor: "pointer" },
        children: k.cameraPaused
      }
    ),
    isLiveness && v.canReissue && awaiting && /* @__PURE__ */ jsx4(
      "button",
      {
        onClick: v.reissue,
        disabled: busy,
        style: { width: "100%", marginTop: 14, padding: "10px 0", borderRadius: T.radius, background: "transparent", color: T.primary, border: `1px solid ${T.primary}`, fontSize: 14, cursor: busy ? "wait" : "pointer" },
        children: k.reissue
      }
    ),
    isLiveness && livePhase.hint === "budget" && /* @__PURE__ */ jsx4(
      "button",
      {
        onClick: () => v.capture({ livenessAdvance: true, mode: "auto" }),
        disabled: busy,
        style: { width: "100%", marginTop: 14, padding: "10px 0", borderRadius: T.radius, background: T.primary, color: T.onPrimary, border: 0, fontSize: 14, cursor: busy ? "wait" : "pointer" },
        children: k.continueNext
      }
    ),
    !(isLiveness && autoDetection) && /* @__PURE__ */ jsx4(
      "button",
      {
        onClick: v.capture,
        disabled: busy || !v.cameraReady,
        style: {
          width: "100%",
          marginTop: 14,
          padding: "10px 0",
          borderRadius: T.radius,
          background: "transparent",
          color: T.primary,
          border: `1px solid ${T.primary}`,
          fontSize: 14,
          cursor: busy || !v.cameraReady ? "wait" : "pointer",
          opacity: busy || !v.cameraReady ? 0.5 : 1
        },
        children: k.captureManually
      }
    ),
    isDoc && vp.attempts.manualUpload && /* @__PURE__ */ jsxs3("label", { style: {
      display: "block",
      width: "100%",
      marginTop: 10,
      padding: "10px 0",
      borderRadius: T.radius,
      background: T.primary,
      color: T.onPrimary,
      fontSize: 14,
      textAlign: "center",
      cursor: busy ? "wait" : "pointer",
      opacity: busy ? 0.5 : 1,
      boxSizing: "border-box"
    }, children: [
      k.uploadDocument,
      /* @__PURE__ */ jsx4(
        "input",
        {
          type: "file",
          accept: "image/jpeg,image/png,image/webp",
          onChange: (e) => {
            const file = e.target.files && e.target.files[0];
            e.target.value = "";
            v.uploadDocumentFile(file);
          },
          disabled: busy,
          style: { display: "none" }
        }
      )
    ] })
  ] });
}

// src/components/Spinner.jsx
import { Fragment as Fragment2, jsx as jsx5, jsxs as jsxs4 } from "react/jsx-runtime";
function Spinner({ margin = "0 auto 12px" }) {
  return /* @__PURE__ */ jsxs4(Fragment2, { children: [
    /* @__PURE__ */ jsx5("div", { style: {
      width: 32,
      height: 32,
      margin,
      borderRadius: "50%",
      border: `3px solid ${T.primary}`,
      borderTopColor: "transparent",
      animation: "vp-spin 0.8s linear infinite"
    } }),
    /* @__PURE__ */ jsx5("style", { children: "@keyframes vp-spin { to { transform: rotate(360deg) } }" })
  ] });
}
function ProcessingView({ copy }) {
  return /* @__PURE__ */ jsxs4("div", { "data-vp-part": "processing", style: { textAlign: "center", padding: "32px 0", color: T.muted }, children: [
    /* @__PURE__ */ jsx5(Spinner, {}),
    copy.processing.message
  ] });
}

// src/components/MobileHandoffView.jsx
import { jsx as jsx6, jsxs as jsxs5 } from "react/jsx-runtime";
var time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function MobileHandoffView({ v }) {
  const { state: vp, copy, qrDataUrl } = v;
  const k = copy.mobile;
  const h = vp.handoff;
  const error = vp.flow.error;
  const outlineButton = { padding: "8px 12px", borderRadius: T.radius, border: `1px solid ${T.primary}`, background: T.surface, color: T.primary, cursor: "pointer" };
  const mobileError = v.qrError === "encode" ? k.qrEncodeFailed : v.qrError === "load" ? k.qrLoadFailed : h.error;
  return /* @__PURE__ */ jsxs5("div", { "data-vp-part": "mobile", style: { textAlign: "center", padding: "8px 0" }, children: [
    /* @__PURE__ */ jsx6("p", { style: { margin: "0 0 16px", fontSize: 15, color: T.text }, children: k.intro }),
    h.url && /* @__PURE__ */ jsx6("div", { style: { display: "inline-flex", padding: 16, background: "#fff", borderRadius: 12, boxShadow: "0 2px 12px rgba(0,0,0,0.15)" }, children: qrDataUrl ? /* @__PURE__ */ jsx6("img", { src: qrDataUrl, alt: k.qrAlt, width: 256, height: 256 }) : /* @__PURE__ */ jsx6("div", { style: { width: 256, height: 256, display: "flex", alignItems: "center", justifyContent: "center", color: T.muted, fontSize: 14 }, children: k.generating }) }),
    mobileError && /* @__PURE__ */ jsx6("p", { role: "alert", style: { color: T.danger, fontSize: 13, margin: "12px 0 0" }, children: mobileError }),
    h.url && /* @__PURE__ */ jsxs5("div", { style: { display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", marginTop: 12 }, children: [
      !qrDataUrl && mobileError && /* @__PURE__ */ jsx6("button", { type: "button", onClick: v.retryQr, style: outlineButton, children: k.retryQr }),
      /* @__PURE__ */ jsx6("button", { type: "button", onClick: v.copyHandoffLink, style: outlineButton, children: k.copyLink }),
      /* @__PURE__ */ jsx6("a", { href: h.url, target: "_blank", rel: "noopener noreferrer", style: { ...outlineButton, background: void 0, textDecoration: "none" }, children: k.openHere })
    ] }),
    h.linkStatus && /* @__PURE__ */ jsx6("p", { role: "status", style: { margin: "8px 0 0", fontSize: 12, color: T.muted }, children: h.linkStatus === "copied" ? k.linkCopied : k.copyFailed }),
    h.url && /* @__PURE__ */ jsxs5("p", { style: { margin: "10px 0 0", fontSize: 12, color: T.muted }, children: [
      k.privacy,
      h.handoffExpiresAt ? fmt(k.codeExpires, time(h.handoffExpiresAt)) : "",
      h.expiresAt ? fmt(k.sessionExpires, time(h.expiresAt)) : ""
    ] }),
    error && /* @__PURE__ */ jsxs5("p", { role: "alert", style: { color: T.danger, fontSize: 13, margin: "12px 0 0", textAlign: "center" }, children: [
      error.message,
      " ",
      /* @__PURE__ */ jsx6("button", { onClick: v.retryHandoff, style: { textDecoration: "underline", background: "none", border: 0, color: "inherit", cursor: "pointer" }, children: copy.capture.retry })
    ] }),
    /* @__PURE__ */ jsx6("p", { "aria-live": "polite", role: "status", style: { margin: "16px 0 0", fontSize: 14, color: T.muted }, children: h.phase === "verifying" ? k.verifying : h.phase === "finalising" ? k.finalising : k.waiting }),
    h.polling && /* @__PURE__ */ jsx6(Spinner, { margin: "12px auto 0" }),
    h.allowsChoice && /* @__PURE__ */ jsx6(
      "button",
      {
        type: "button",
        onClick: () => v.selectHandoff(false),
        style: { display: "block", margin: "16px auto 0", background: "none", border: 0, color: T.primary, fontSize: 13, textDecoration: "underline", cursor: "pointer" },
        children: k.useThisDevice
      }
    )
  ] });
}

// src/components/OutcomeView.jsx
import { jsx as jsx7, jsxs as jsxs6 } from "react/jsx-runtime";
var RETRYABLE = ["rejected", "manual_review", "failed"];
var MAX_ATTEMPTS = 5;
function OutcomeView({ v }) {
  const { state: vp, copy } = v;
  const k = copy.outcome;
  const { result } = vp.flow;
  const { attempts, busy, feedback } = vp;
  const review = result.status === "manual_review";
  const reasonCodes = result.decision?.reasonCodes || [];
  return /* @__PURE__ */ jsxs6("div", { "data-vp-part": "outcome", style: { textAlign: "center", padding: "24px 0" }, children: [
    /* @__PURE__ */ jsx7("p", { style: { fontSize: 40, margin: 0 }, children: result.status === "approved" ? "\u2705" : review ? "\u23F3" : "\u274C" }),
    /* @__PURE__ */ jsxs6("p", { style: { fontSize: 16, margin: "8px 0" }, children: [
      result.status === "approved" && k.approved,
      review && k.manual_review,
      ["rejected", "failed", "expired"].includes(result.status) && k.unsuccessful
    ] }),
    ["rejected", "failed", "manual_review"].includes(result.status) && reasonCodes.length > 0 && /* @__PURE__ */ jsxs6("div", { style: { textAlign: "left", maxWidth: 320, margin: "12px auto 0", background: review ? "#FFFBEB" : "#FEF2F2", border: `1px solid ${review ? "#FDE68A" : "#FECACA"}`, borderRadius: 8, padding: "12px 16px" }, children: [
      /* @__PURE__ */ jsx7("p", { style: { margin: "0 0 8px", fontSize: 13, fontWeight: 600, color: review ? "#92400E" : "#991B1B" }, children: review ? k.improve : k.reasons }),
      reasonCodes.map((code) => /* @__PURE__ */ jsxs6("div", { style: { display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 4, fontSize: 13 }, children: [
        /* @__PURE__ */ jsx7("span", { style: { color: T.danger, marginTop: 1 }, children: "\u2022" }),
        /* @__PURE__ */ jsx7("span", { style: { color: "#374151" }, children: copy.reasons[code] || code })
      ] }, code))
    ] }),
    RETRYABLE.includes(result.status) && !attempts.exhausted && /* @__PURE__ */ jsxs6("div", { style: { marginTop: 16 }, children: [
      /* @__PURE__ */ jsx7(
        "button",
        {
          onClick: v.retry,
          disabled: busy,
          style: {
            padding: "10px 28px",
            borderRadius: T.radius,
            border: 0,
            fontSize: 14,
            background: T.primary,
            color: T.onPrimary,
            cursor: busy ? "wait" : "pointer",
            opacity: busy ? 0.6 : 1
          },
          children: busy ? k.restarting : k.tryAgain
        }
      ),
      /* @__PURE__ */ jsxs6("p", { style: { fontSize: 12, color: T.subtle, margin: "8px 0 0" }, children: [
        fmt(k.attempt, attempts.attempts, MAX_ATTEMPTS),
        attempts.attempts >= 3 ? k.manualUploadNext : ""
      ] })
    ] }),
    attempts.exhausted && RETRYABLE.includes(result.status) && /* @__PURE__ */ jsx7("p", { style: { fontSize: 13, color: T.muted, margin: "14px 0 0" }, children: k.exhausted }),
    feedback && /* @__PURE__ */ jsx7("p", { style: { color: T.warning, fontSize: 13, margin: "8px 0 0" }, children: feedback })
  ] });
}

// src/VerificationWidget.jsx
import { jsx as jsx8, jsxs as jsxs7 } from "react/jsx-runtime";
function VerificationWidget(props) {
  const { baseUrl, publicKey } = useVerifyPassConfig();
  const sessionKey = JSON.stringify([props.sessionId, props.sdkToken, props.baseUrl ?? baseUrl, props.publicKey ?? publicKey]);
  return /* @__PURE__ */ jsxs7("div", { "data-vp-widget": true, className: props.className, style: themeStyle(props.theme), children: [
    /* @__PURE__ */ jsx8("style", { children: "@media (prefers-reduced-motion: reduce) { [data-vp-widget] * { animation: none !important; transition: none !important; } }" }),
    /* @__PURE__ */ jsx8(VerificationWidgetSession, { ...props }, sessionKey)
  ] });
}
function VerificationWidgetSession(props) {
  const v = useVerification(props);
  const { state: vp, copy, step } = v;
  const theme = props.theme || {};
  if (vp?.status === "error") {
    return /* @__PURE__ */ jsxs7("div", { role: "alert", children: [
      /* @__PURE__ */ jsx8("p", { children: vp.initError }),
      /* @__PURE__ */ jsx8("button", { onClick: v.retryInit, children: copy.retryLoading })
    ] });
  }
  if (!vp || !vp.flow) return /* @__PURE__ */ jsx8("p", { role: "status", children: copy.loading });
  if (!vp.consented && !vp.handoff.enabled) {
    return /* @__PURE__ */ jsx8(
      ConsentGate,
      {
        copy,
        logoUrl: theme.logoUrl,
        feedback: vp.feedback,
        busy: vp.busy,
        allowsHandoffChoice: vp.handoff.allowsChoice,
        onConsent: v.recordConsent,
        onShowQr: () => v.selectHandoff(true)
      }
    );
  }
  const { steps, stepIndex, result } = vp.flow;
  const isLiveness = step === "liveness";
  const title = isLiveness && v.currentAction ? fmt(copy.capture.livenessTitle, vp.actionIndex + 1, vp.actions.length) : copy.steps[step].title;
  const isCaptureStep = isDocumentStep(step) || step === "face" || isLiveness;
  return /* @__PURE__ */ jsxs7("div", { style: { maxWidth: 420, margin: "0 auto", fontFamily: T.font }, children: [
    theme.logoUrl && /* @__PURE__ */ jsx8("img", { src: theme.logoUrl, alt: "", style: { height: 32, marginBottom: 12 } }),
    /* @__PURE__ */ jsx8("div", { "data-vp-part": "progress", style: { display: "flex", gap: 4, marginBottom: 16 }, children: steps.filter((s) => s !== "complete").map((s, i) => /* @__PURE__ */ jsx8("div", { style: {
      flex: 1,
      height: 4,
      borderRadius: 2,
      background: i <= stepIndex ? T.primary : T.border
    } }, s)) }),
    /* @__PURE__ */ jsx8("h2", { style: { margin: "0 0 12px", fontSize: 20 }, children: title }),
    isCaptureStep && /* @__PURE__ */ jsx8(CaptureView, { v }),
    step === "processing" && /* @__PURE__ */ jsx8(ProcessingView, { copy }),
    step === "mobile" && /* @__PURE__ */ jsx8(MobileHandoffView, { v }),
    step === "complete" && result && /* @__PURE__ */ jsx8(OutcomeView, { v })
  ] });
}

// src/index.js
import { claimMobileHandoff, createVerificationController as createVerificationController2, VerifyPassError } from "@verifypass/sdk-core";
export {
  CONSENT_COPY_VERSION,
  DEFAULT_COPY,
  DEFAULT_FACE_MODEL_URL,
  LIVE_TEST_API_BASE,
  LIVE_TEST_PUBLIC_KEY,
  ORT_VERSION,
  VerificationWidget,
  VerifyPassError,
  VerifyPassProvider,
  claimMobileHandoff,
  createFaceDetector,
  createVerificationController2 as createVerificationController,
  mergeCopy,
  runCaptureLoop,
  useVerification,
  useVerifyPass,
  useVerifyPassConfig
};
