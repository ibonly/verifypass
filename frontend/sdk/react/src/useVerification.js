// Headless React integration: everything the widget does, minus the markup.
// Bind `videoRef` to a <video> (and optionally `overlayRef` to a <canvas>),
// render from the returned state, call the returned actions. The bundled
// <VerificationWidget> is built on exactly this hook.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createVerificationController, assessFrame, collectCaptureSignals, startCamera, stopCamera,
  captureFrame, captureGuideFrame, nextVideoFrame
} from "@verifypass/sdk-core";
import { useVerifyPassConfig, DEFAULT_FACE_MODEL_URL } from "./VerifyPassProvider";
import { createFaceDetector, hasBundledOrtWasm } from "./faceDetector";
import { runCaptureLoop, isDocumentStep } from "./captureLoop";
import { runScreenFlash } from "./screenFlash";
import { mergeCopy, fmt } from "./copy";
import { hostedAssetBase, hostedModelUrl } from "./assets";

// Document-step guide box: ID-1 card aspect (85.6×54mm), centered, matching
// the on-screen guide overlay — capture crops to exactly this region.
// displayAspect must equal frameW/frameH of the document preview (340/212).
export const DOC_GUIDE = { displayAspect: 340 / 212, widthFrac: 0.88, regionAspect: 1.586 };
const FACING = { document: "environment", document_back: "environment", liveness: "user", face: "user" };
// Bundler/explicit WASM loads fast; the hosted WASM (~14 MB, ~3.7 MB gzip)
// is fetched once then cached, so its first load gets a longer window.
const MODEL_TIMEOUT_MS = 12000;
const HOSTED_MODEL_TIMEOUT_MS = 30000;

let warnedModelFailure = false;

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
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

/**
 * @param {object} opts sessionId, sdkToken (required); mobileHandoff, screenFlash,
 *   copy, consentCopy, onComplete, onError, onStepChange, onTelemetry; and any
 *   provider setting (publicKey, baseUrl, faceModelUrl, landmarkModelUrl,
 *   ortWasmUrl) to override <VerifyPassProvider>.
 */
export function useVerification(opts) {
  const config = useVerifyPassConfig();
  const pick = (k) => (opts[k] === undefined ? config[k] : opts[k]);
  const publicKey = pick("publicKey");
  const baseUrl = pick("baseUrl");
  const faceModelSetting = pick("faceModelUrl");
  const landmarkModelUrl = pick("landmarkModelUrl");
  const ortWasmUrl = pick("ortWasmUrl");
  const { sessionId, sdkToken, mobileHandoff, screenFlash = true, onComplete, onError, onStepChange, onTelemetry } = opts;
  const copy = useMemo(() => mergeCopy(opts.copy, opts.consentCopy), [opts.copy, opts.consentCopy]);
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
  // Liveness capture phases: "align" → "await" → "capturing"; set once per transition.
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

  // Screen flash is disclosed in the consent statement; reduced-motion users
  // are the photosensitivity escape hatch and skip it.
  const reducedMotion = usePrefersReducedMotion();
  const screenFlashRef = useRef(false);
  screenFlashRef.current = screenFlash && !reducedMotion;

  // ── Session controller ───────────────────────────────────────────
  useEffect(() => {
    const c = createVerificationController({
      sessionId, sdkToken, publicKey, baseUrl, mobileHandoff,
      onComplete: (r) => callbacksRef.current.onComplete?.(r),
      onError: (e) => callbacksRef.current.onError?.(e),
      onStepChange: (s) => callbacksRef.current.onStepChange?.(s),
      onTelemetry: (t) => callbacksRef.current.onTelemetry?.(t)
    });
    ctrlRef.current = c;
    const off = c.subscribe(setVp);
    setVp(c.getState());
    c.start();
    return () => { off(); c.dispose(); if (ctrlRef.current === c) ctrlRef.current = null; setVp(null); };
  }, [sessionId, sdkToken, publicKey, baseUrl, mobileHandoff]);

  const step = vp?.flow?.step || null;
  const consented = !!vp?.consented;
  const challengeEpoch = vp?.challengeEpoch || 0;
  const attemptEpoch = vp?.attemptEpoch || 0;
  const currentAction = vp ? vp.actions[vp.actionIndex] || null : null;

  // New challenge (reissue / retry) → fresh frontal reference; new attempt → fresh stabilizer too.
  useEffect(() => {
    livenessFrontalRef.current = null;
    livenessRefSamplesRef.current = [];
    setCanReissue(false);
  }, [challengeEpoch]);
  useEffect(() => { livenessStabRef.current = null; }, [attemptEpoch]);

  // ── Camera: keyed on facingMode so liveness → face keeps the stream ──
  const captureFacing = FACING[step] || null;
  useEffect(() => {
    const c = ctrlRef.current;
    if (!c || !consented || !captureFacing) return undefined;
    const video = videoRef.current;
    if (!video) return undefined;
    let cancelled = false;
    const cameraController = new AbortController();
    setCameraReady(false);
    startCamera(video, { facingMode: captureFacing, signal: cameraController.signal })
      .then((stream) => {
        // Torn down before getUserMedia resolved: stop the fresh stream.
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        // Capture integrity: camera metadata (virtual-camera heuristics) sent at submit.
        collectCaptureSignals(stream).then((sig) => {
          if (!cancelled && sig && c.client) c.client.setCaptureSignals(sig);
        }).catch(() => {});
        // The OS ends the track when backgrounded / taken by another app.
        const track = stream.getVideoTracks && stream.getVideoTracks()[0];
        if (track) track.onended = () => { if (!cancelled) { setCameraReady(false); setCameraPaused(true); } };
        const t = c.getTelemetry();
        if (!t.startedAt) t.startedAt = performance.now();
        setCameraReady(true);
      })
      .catch((err) => {
        if (cancelled || cameraController.signal.aborted) return;
        const k = copyRef.current.capture;
        const isPermission = err.name === "NotAllowedError" || err.name === "PermissionDeniedError" || /permission/i.test(err.message || "");
        const userMessage = err.message && !/permission denied/i.test(err.message)
          ? err.message
          : (isPermission ? k.cameraDenied : (err.message || k.cameraFailed));
        c.reportCameraError(err, userMessage);
      });
    const pauseCamera = () => {
      if (cancelled) return;
      cameraController.abort();
      stopCamera(video);
      setCameraReady(false); setCameraPaused(true);
      livenessFrontalRef.current = null;
      livenessRefSamplesRef.current = [];
    };
    const onVis = () => { if (document.hidden) pauseCamera(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("orientationchange", pauseCamera);
    return () => { cancelled = true; cameraController.abort(); document.removeEventListener("visibilitychange", onVis); window.removeEventListener("orientationchange", pauseCamera); stopCamera(video); setCameraReady(false); };
  }, [captureFacing, consented, cameraEpoch]);

  // ── Face model (optional; failure falls back to motion auto-capture) ──
  // Explicit URL → used as-is. Omitted → the hosted VerifyPass origin, once
  // the challenge has told us where that is.
  const assetBaseUrl = hostedAssetBase(vp?.hostedBaseUrl);
  const challengeLoaded = vp?.status === "ready";
  const faceModelUrl = faceModelSetting === null ? null
    : typeof faceModelSetting === "string" ? faceModelSetting
    : !challengeLoaded ? undefined
    : (hostedModelUrl(assetBaseUrl, "fr_detect.onnx") || DEFAULT_FACE_MODEL_URL);
  const faceModelEnabled = faceModelSetting !== null;
  useEffect(() => {
    if (faceModelUrl === null) {
      detectorRef.current = null;
      setDetectorStatus("disabled");
      return undefined;
    }
    detectorRef.current = null;
    setDetectorStatus("loading");
    if (faceModelUrl === undefined) return undefined; // waiting for the challenge
    let disposed = false;
    let det = null;
    const modelController = new AbortController();
    let timedOut = false;
    let timeoutId;
    const usesHostedWasm = !ortWasmUrl && !hasBundledOrtWasm && !!assetBaseUrl;
    const timeout = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => { timedOut = true; modelController.abort(); reject(new Error("Face model load timed out")); }, usesHostedWasm ? HOSTED_MODEL_TIMEOUT_MS : MODEL_TIMEOUT_MS);
    });
    // Framing: minRatio 0.24 (median laptop face ≈0.34 of the frame read
    // "Move closer" at 0.34); still large enough for server crops.
    const detectorOpts = { landmarkUrl: landmarkModelUrl, ortWasmUrl, assetBaseUrl, framing: { minRatio: 0.24, centerTol: 0.13 }, signal: modelController.signal };
    const loadStart = performance.now();
    Promise.race([createFaceDetector(faceModelUrl, detectorOpts).then((d) => { if (disposed || timedOut) { d.dispose?.(); throw new Error("Model load cancelled"); } return d; }), timeout])
      .then((d) => {
        if (disposed) { d.dispose && d.dispose(); return; }
        clearTimeout(timeoutId);
        det = d;
        detectorRef.current = d;
        const c = ctrlRef.current;
        if (c) c.getTelemetry().modelLoadMs = Math.round(performance.now() - loadStart);
        setDetectorStatus("ready");
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        if (disposed) return;
        detectorRef.current = null;
        setDetectorStatus("failed");
        // Visible, not silent: capture still works (motion auto-capture / manual).
        callbacksRef.current.onTelemetry?.({ type: "face_model_load_failed", errorName: (err && err.name) || "Error", timedOut, hostedAssets: usesHostedWasm });
        if (!warnedModelFailure && typeof console !== "undefined") {
          warnedModelFailure = true;
          console.warn("[VerifyPass] Face model failed to load; falling back to motion-based capture.", err && err.message);
        }
      });
    return () => { disposed = true; modelController.abort(); clearTimeout(timeoutId); detectorRef.current = null; if (det && det.dispose) det.dispose(); };
  }, [faceModelUrl, landmarkModelUrl, ortWasmUrl, assetBaseUrl]);

  // ── One capture attempt (manual button, auto-capture, burst shots) ──
  const capture = useCallback((o = {}) => {
    const c = ctrlRef.current;
    if (!c) return undefined;
    // Manual button passes an Event (no livenessAdvance) → advance; no mode → "manual".
    const livenessAdvance = o.livenessAdvance !== false;
    const captureMode = typeof o.mode === "string" ? o.mode : "manual";
    return c.runCapture(async (cap) => {
      const s = c.getState().flow.step;
      if (s === "liveness" && o.advanceOnly) { c.advanceLiveness(); return true; }
      if (s === "liveness" && c.livenessBudgetSpent()) {
        // Budget spent: no frame can be uploaded, just advance.
        if (livenessAdvance) c.advanceLiveness();
        return undefined;
      }
      // Documents are cropped to the on-screen card guide so the ID fills the evidence photo.
      await nextVideoFrame(videoRef.current, { signal: c.client.controller.signal });
      const { imageData, base64 } = isDocumentStep(s)
        ? captureGuideFrame(videoRef.current, DOC_GUIDE)
        : s === "liveness"
          ? captureFrame(videoRef.current, null, { maxSide: 640, quality: 0.85 }) // challenge frames need no more
          : captureFrame(videoRef.current);
      // Sharpness: skipped on liveness (motion blur is evidence) and on face
      // when the detector already gated focus on the face crop. Brightness
      // always checked. The server judges authoritatively.
      const skipSharpness = s === "liveness" || (s === "face" && !!detectorRef.current);
      const quality = assessFrame(imageData, skipSharpness ? { minSharpness: 0 } : undefined);
      if (!quality.ok) {
        c.setFeedback(quality.issues.map((i) => fmt(copyRef.current.issues[i]) || i).join(" "));
        return undefined;
      }
      if (isDocumentStep(s)) return cap.document(base64);
      if (s === "liveness") return cap.livenessFrame(base64, captureMode, livenessAdvance);
      if (s === "face") {
        return cap.face(base64, {
          // Screen-flash liveness while the face is framed; record-first.
          flash: async (sequence, signal) => {
            if (!(screenFlashRef.current && detectorRef.current && framingRef.current && framingRef.current.box)) return null;
            try { return await runScreenFlash(videoRef.current, framingRef.current.box, setFlashColor, sequence, signal); }
            finally { setFlashColor(null); }
          }
        });
      }
      return undefined;
    });
  }, []);
  const captureRef = useRef(capture);
  captureRef.current = capture;

  // ── Auto-capture loop ────────────────────────────────────────────
  useEffect(() => {
    const c = ctrlRef.current;
    if (!c || !cameraReady || !step) return undefined;
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
      framingRef, livenessStabRef, livenessFrontalRef, livenessRefSamplesRef,
      set: {
        green: setGreen, framingGuide: setFramingGuide, livePhase: setLivePhase, docSeen: setDocSeen,
        docShapeOk: setDocShapeOk, docFaceBlocked: setDocFaceBlocked, canReissue: setCanReissue, debugInfo: setDebugInfo
      }
    });
  }, [cameraReady, step, vp?.actionIndex, challengeEpoch, faceModelEnabled, detectorStatus]);

  // ── Mobile handoff QR (lazy `qrcode`; inline data URL, no network) ──
  const handoffUrl = vp?.handoff?.url || null;
  useEffect(() => {
    setQrDataUrl(null);
    setQrError(null);
    if (!handoffUrl) return undefined;
    let cancelled = false;
    import("qrcode").then(async (QR) => {
      try {
        const dataUrl = await QR.toDataURL(handoffUrl, { errorCorrectionLevel: "M", margin: 2, width: 256 });
        if (!cancelled) { setQrDataUrl(dataUrl); setQrError(null); }
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
    return () => { cancelled = true; };
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
    resumeCamera: () => { setCameraPaused(false); setCameraEpoch((e) => e + 1); },
    controller: ctrlRef.current
  };
}
