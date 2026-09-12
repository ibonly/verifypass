import { useCallback, useEffect, useRef, useState } from "react";
import {
  VerifyPassClient, createFlow, needsDocumentBack, assessFrame, collectCaptureSignals,
  startCamera, stopCamera, captureFrame, captureGuideFrame,
  grabAnalysisFrame, grabSquareFrame, grabFixedFrame, frameMotion, toGrayscale, meanBrightness, laplacianVariance,
  createFramingStabilizer, createActionDetector, bandMotion, createDocumentGate, isDominantFace, isFrontalPose,
  nextVideoFrame, isReferencePose, frontalRefFromSamples, FLASH, flashCropRect
} from "@verifypass/sdk-core";
import { useVerifyPass } from "./VerifyPassProvider";
import { createFaceDetector } from "./faceDetector";

// Both document sides share capture UX (card guide, doc gate, back camera).
const isDocumentStep = (s) => s === "document" || s === "document_back";

const STEP_COPY = {
  document: {
    title: "Scan your ID",
    hint: "Place your ID inside the frame. Avoid glare and shadows.",
    facingMode: "environment"
  },
  document_back: {
    title: "Scan the BACK of your ID",
    hint: "Flip your ID over and place the back inside the frame.",
    facingMode: "environment"
  },
  liveness: {
    title: "Liveness check",
    hint: "Follow the prompt so we know you're really here.",
    facingMode: "user"
  },
  face: {
    title: "Take a selfie",
    hint: "Look straight at the camera in good lighting.",
    facingMode: "user"
  },
  processing: { title: "Verifying…", hint: "This usually takes a few seconds." },
  complete: { title: "Done", hint: "" }
};

// Document-step guide box: ID-1 card aspect (85.6×54mm), centered, matching
// the on-screen guide overlay — capture crops to exactly this region.
// displayAspect must equal frameW/frameH of the document preview (340/212).
const DOC_GUIDE = { displayAspect: 340 / 212, widthFrac: 0.88, regionAspect: 1.586 };

// Client-side mirror of the server's per-action liveness frame budget (FV-3,
// MAX_LIVENESS_FRAMES_PER_ACTION, default 6). The widget stops uploading
// BEFORE the server would reject: redo cycles after a stalled burst add an
// extra early-shot + burst per cycle, which used to blow past the cap and
// dead-end the whole flow with "too many liveness frames" — the user kept
// turning their head at a wall that could never accept another frame.
const LIVENESS_FRAME_BUDGET = 8; // two full cycles (early shot + 3-frame burst) — mirrors the server default

// Directional arrow overlay per head action. Shown over the (mirrored)
// preview while the user performs the movement. Mirror math: a selfie
// preview behaves like a MIRROR — lateral movement keeps its screen
// direction (turn your head left → your image turns toward screen-left) —
// so a screen-left arrow correctly means "YOUR left"; no flipping needed.
// rotate: degrees applied to a right-pointing arrow. pos: placement inside
// the circular frame. Expression actions (smile) have no direction.
const ACTION_ARROWS = {
  // labels are SCREEN-relative on purpose: "your left" is ambiguous on a
  // camera that pre-mirrors its frames (v4), "the left side of the screen" is not
  turn_left: { rotate: 180, pos: { left: 6, top: "50%", transform: "translateY(-50%)" }, label: "Turn your head toward the arrow on the left side of the screen" },
  turn_right: { rotate: 0, pos: { right: 6, top: "50%", transform: "translateY(-50%)" }, label: "Turn your head toward the arrow on the right side of the screen" },
  look_up: { rotate: -90, pos: { top: 6, left: "50%", transform: "translateX(-50%)" }, label: "Tilt your head up, lifting your chin toward the ceiling" },
  look_down: { rotate: 90, pos: { bottom: 6, left: "50%", transform: "translateX(-50%)" }, label: "Tilt your head down, lowering your chin toward your chest" }
};

// Diagnosis-driven coaching (replaces the old single timer hint, which told
// users to make the movement "bigger and slower" while they were already
// holding a full turn the detector had simply missed).
const COACH_COPY = {
  wrong_way: (a) => a === "look_up" ? "That's down — lift your chin and look UP"
    : a === "look_down" ? "That's up — lower your chin and look DOWN"
    : "Other way — turn your head toward the arrow",
  face_lost: () => "We lost your face — come back a little so we can still see you",
  recenter: () => "Face the camera straight first — then do the movement",
  budget: () => "We've recorded everything we can for this movement. Continue — if it isn't accepted you'll be asked to try again.",
  further: (a) => a === "look_up" ? "Almost — lift your chin further, toward the ceiling"
    : a === "look_down" ? "Almost — lower your chin a bit more"
    : a === "blink" ? "Almost — close your eyes fully for a second, then open them"
    : a === "open_mouth" ? "Almost — open your mouth wider and hold it"
    : "Almost — keep turning toward the arrow and hold it",
  none: (a) => a === "look_up" || a === "look_down" ? "We haven't seen it yet — tilt your head slowly and hold"
    : a === "blink" ? "We haven't seen it yet — close your eyes for a full second, then open them"
    : a === "open_mouth" ? "We haven't seen it yet — open your mouth wide and hold it"
    : "We haven't seen it yet — turn slowly toward the arrow and hold"
};

/** Pulsing directional arrow rendered over the camera preview. */
function ActionArrow({ action }) {
  const spec = ACTION_ARROWS[action];
  if (!spec) return null;
  return (
    <div
      role="img"
      aria-label={spec.label}
      style={{ position: "absolute", zIndex: 2, pointerEvents: "none", ...spec.pos }}
    >
      <div style={{ transform: `rotate(${spec.rotate}deg)` }}>
        {/* right-pointing arrow; rotation + the nudge animation (translateX
            AFTER rotation) make it point and pulse toward the direction */}
        <svg width="52" height="52" viewBox="0 0 52 52" style={{ animation: "vp-arrow-nudge 0.9s ease-in-out infinite", display: "block", filter: "drop-shadow(0 1px 4px rgba(0,0,0,0.6))" }}>
          <path
            d="M6 26 H34 M24 12 L40 26 L24 40"
            fill="none"
            stroke="#FFFFFF"
            strokeWidth="7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <style>{"@keyframes vp-arrow-nudge { 0%,100% { transform: translateX(0) } 50% { transform: translateX(10px) } }"}</style>
    </div>
  );
}

// Prompts for each server-issued challenge action.
// Short on-screen pill text (the arrow carries the side; the full
// screen-relative sentence is in ACTION_COPY / aria-labels).
const PILL_COPY = {
  turn_left: "Turn toward the ← arrow",
  turn_right: "Turn toward the → arrow",
  look_up: "Lift your chin — look UP",
  look_down: "Lower your chin — look DOWN",
  blink: "Close your eyes, then open them",
  open_mouth: "Open your mouth wide"
};

const ACTION_COPY = {
  // a real blink is ~150 ms — too quick for the capture pipeline, so ask for
  // a slow one: the closed-eye frame is captured while the eyes are shut
  blink: "Close your eyes for a second, then open them",
  open_mouth: "Open your mouth wide and hold it for a moment",
  turn_left: "Slowly turn your head toward the arrow on the LEFT side of the screen",
  turn_right: "Slowly turn your head toward the arrow on the RIGHT side of the screen",
  look_up: "Tilt your head UP — lift your chin toward the ceiling",
  look_down: "Tilt your head DOWN",
  smile: "Smile"
};

// Framing guidance from the client face model.
const GUIDE_COPY = {
  model_loading: "Loading face model...",
  model_error: "Face model unavailable - capture manually",
  no_face: "Position your face in the circle",
  move_closer: "Move closer",
  move_back: "Move back",
  center: "Center your face",
  focus: "Hold steady - image is soft"
};

const ISSUE_COPY = {
  DOCUMENT_BLURRY: "Image looks blurry — hold steady and try again.",
  TOO_DARK: "Too dark — move somewhere brighter.",
  TOO_BRIGHT: "Too bright — reduce direct light or glare."
};

// Human-readable labels shown on the result screen for each rejection reason code.
const RESULT_REASON_LABELS = {
  LIVENESS_FAILED: "Liveness check failed",
  LIVENESS_BORDERLINE: "Liveness score was borderline",
  LIVENESS_CHALLENGE_FAILED: "Liveness challenge actions not detected",
  LIVENESS_CHALLENGE_INCOMPLETE: "Liveness challenge was not completed",
  LIVENESS_CHALLENGE_EXPIRED: "The liveness challenge timed out — try again",
  LIVENESS_CHALLENGE_SEQUENCE_INVALID: "The movements took too long or were out of order — try again without pausing",
  LIVENESS_POSE_UNAVAILABLE: "We couldn't measure your head movements — try again with your face well lit and fully in the circle",
  DOCUMENT_IMAGE_LOW_QUALITY: "Your ID photo was blurry or poorly lit",
  DOCUMENT_IS_LIVE_FACE: "We saw a face instead of your ID card",
  SESSION_TIMEOUT: "The verification took too long — please try again",
  FACE_MATCH_FAILED: "Face doesn't match the ID document",
  FACE_MATCH_BORDERLINE: "Face similarity score was borderline",
  NO_FACE_ON_SELFIE: "No face detected in your selfie",
  NO_FACE_ON_DOCUMENT: "No face detected on your ID document",
  MULTIPLE_FACES_DETECTED: "Multiple faces detected in the image",
  DOCUMENT_OCR_FAILED: "Could not read the text on your ID",
  DOCUMENT_EXPIRED: "Your ID document appears to be expired",
  DEVICE_SHARED_ACROSS_IDENTITIES: "This device has been flagged for suspicious activity",
  TOO_MANY_FAILED_ATTEMPTS: "Too many failed attempts — please try again later",
  IP_RATE_LIMIT: "Too many requests from your network"
};


const DEFAULT_CONSENT_COPY = "I consent to VerifyPass capturing and processing my ID images, my selfie, short video frames of my head movements, and my device and camera details (such as camera type and browser) to verify my identity and prevent fraud. This includes biometric processing. Images are stored securely for the period set by the organisation that requested this verification, then deleted.";
// Bump when the consent wording changes — recorded server-side with each
// consent so audits know WHICH text the user accepted.
const CONSENT_COPY_VERSION = "2026-09-04.1"; // v5 E3: processing scope now names liveness frames + device/camera metadata + retention
const FACE_FOCUS_MIN = 12;

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

/**
 * <VerificationWidget sessionId sdkToken onComplete onError theme steps />
 * (PRD §9.14). sessionId + sdkToken come from the fintech backend's
 * create-session call.
 */
/**
 * Run the screen-flash sequence: dark baseline, then FLASH.count random
 * colours over the whole viewport; after each switch wait for the display +
 * camera to settle and grab the face crop (from the same 320-px square frame
 * the detector analyses, so `box` is in its coordinates) into one horizontal
 * mosaic: [baseline | c1 | c2 | c3 | c4]. Resolves {base64, sequence, tile}
 * or null when the camera is not ready.
 */
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
  src.width = 320; src.height = 320;
  const sctx = src.getContext("2d");
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < steps.length; i++) {
    if (signal?.aborted || document.hidden) throw new Error("Capture interrupted");
    setColor(steps[i]);
    await wait(FLASH.sampleDelayMs);
    await nextVideoFrame(video, { signal });
    const frame = grabSquareFrame(video, 320, 320);
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

export function VerificationWidget(props) {
  const { baseUrl, publicKey } = useVerifyPass();
  const sessionKey = JSON.stringify([props.sessionId, props.sdkToken, baseUrl, publicKey]);
  return <div data-vp-widget><style>{"@media (prefers-reduced-motion: reduce) { [data-vp-widget] * { animation: none !important; transition: none !important; } }"}</style><VerificationWidgetSession key={sessionKey} {...props} /></div>;
}
function VerificationWidgetSession({
  sessionId,
  sdkToken,
  theme = {},
  consentCopy = DEFAULT_CONSENT_COPY,
  onComplete,
  onError,
  onStepChange,
  /** Screen-flash liveness after the selfie (v7 1.1). Off only for tenants that opt out. */
  screenFlash = true
}) {
  const { publicKey, baseUrl, faceModelUrl, landmarkModelUrl } = useVerifyPass();
  const videoRef = useRef(null);
  const flowRef = useRef(null);
  const clientRef = useRef(null);
  const actionsRef = useRef([]);
  const actionIdxRef = useRef(0);
  // Frames uploaded per action for the CURRENT challenge (mirrors the server
  // budget; reset whenever a challenge is issued/reissued).
  const livenessFrameCountsRef = useRef({});
  const capturingRef = useRef(false);
  const detectorRef = useRef(null);
  const framingRef = useRef(null);
  const overlayRef = useRef(null);

  // Callback props via refs so effects don't re-run when the parent passes new
  // inline function identities each render.
  const onErrorRef = useRef(onError);
  const onStepChangeRef = useRef(onStepChange);
  const onCompleteRef = useRef(onComplete);
  onErrorRef.current = onError;
  onStepChangeRef.current = onStepChange;
  onCompleteRef.current = onComplete;

  const [flowState, setFlowState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [green, setGreen] = useState(false);
  const [framingGuide, setFramingGuide] = useState("no_face");
  const [detectorStatus, setDetectorStatus] = useState(faceModelUrl ? "loading" : "disabled");
  const [actions, setActions] = useState([]);
  const [actionIdx, setActionIdx] = useState(0);
  const [consentChecked, setConsentChecked] = useState(false);
  const [consented, setConsented] = useState(false);
  const [initError, setInitError] = useState(null);
  const [initEpoch, setInitEpoch] = useState(0);
  const [challengeEpoch, setChallengeEpoch] = useState(0);
  // Liveness capture phases: "align" (frontal lock) → "perform" (burst capture
  // while the user does the action). Set once per transition — never per frame.
  const [livePhase, setLivePhase] = useState({ phase: "align", startedAt: 0, total: 0 });
  // ?vpdebug: live pose/phase readout (throttled) so "it doesn't see my turn"
  // reports come with numbers.
  const [debugInfo, setDebugInfo] = useState(null);
  // Screen-flash overlay colour ([r,g,b]) while the flash sequence runs; null otherwise.
  const [flashColor, setFlashColor] = useState(null);
  const [allowFlash, setAllowFlash] = useState(false);
  const screenFlashRef = useRef(false);
  screenFlashRef.current = screenFlash && allowFlash;
  // Framing stabilizer persists ACROSS liveness actions so the next action
  // doesn't pay a fresh lock-in ("Center your face" between every action).
  const livenessStabRef = useRef(null);
  // Session-level FRONTAL pose reference (yaw/pitch), captured at the first
  // liveness align while the face is frontal, reused for every action. All
  // movement verdicts are measured against THIS — never against the pose at
  // instruction time, which is often still turned from the previous action.
  const livenessFrontalRef = useRef(null);
  const livenessRefSamplesRef = useRef([]); // reference-frontal pose samples seen while aligning
  // v5 E1: capture telemetry — how each action was captured (sent with submit)
  const telemetryRef = useRef({ actions: [], detectMs: null, landmarkMs: null, modelLoadMs: null, startedAt: 0 });
  const [canReissue, setCanReissue] = useState(false); // D3: "try a different movement" offer
  const [cameraPaused, setCameraPaused] = useState(false); // B5
  const [cameraEpoch, setCameraEpoch] = useState(0);       // bump to restart the camera effect
  // Document step: has the ID actually entered the frame? (drives the hint)
  const [docSeen, setDocSeen] = useState(false);
  // Document step: does the change-region look like a CARD? (straight edges)
  const [docShapeOk, setDocShapeOk] = useState(false);
  // Document step: a LIVE face is filling the frame instead of a card
  const [docFaceBlocked, setDocFaceBlocked] = useState(false);
  // Retry flow: attempt counter from the server (audit-logged there). After 3
  // camera attempts the server suggests manual file upload for the document.
  const [attemptInfo, setAttemptInfo] = useState({ attempts: 1, manualUpload: false, exhausted: false });

  // init: create client, fetch the server-issued challenge, build the flow
  useEffect(() => {
    let cancelled = false;
    let client;
    let off = () => {};
    (async () => {
      let verificationType = "ID_AND_FACE";
      let challengeActions = [];
      let documentTypes = [];
      try {
        client = new VerifyPassClient({ baseUrl, publicKey, sessionId, sdkToken });
        clientRef.current = client;
        const c = await client.getChallenge();
        if (cancelled) return;
        verificationType = c.verificationType || "ID_AND_FACE";
        challengeActions = Array.isArray(c.livenessActions) ? c.livenessActions : [];
        documentTypes = Array.isArray(c.documentTypes) ? c.documentTypes : [];
        // Rehydrate attempt state — a refresh mid-retry must not reset the
        // counter or hide the manual-upload option the server already granted.
        if (typeof c.attempts === "number") {
          setAttemptInfo({
            attempts: c.attempts,
            manualUpload: !!c.manualUploadSuggested,
            exhausted: c.attempts >= (c.maxAttempts || 5)
          });
        }
      } catch (err) {
        if (!cancelled) setInitError(err.message);
        if (!cancelled && onErrorRef.current) onErrorRef.current(err);
        return;
      }
      if (cancelled) return;
      actionsRef.current = challengeActions;
      livenessFrameCountsRef.current = {}; // fresh challenge → fresh budgets
      setActions(challengeActions);
      let flow;
      try {
        flow = createFlow(verificationType, { documentBack: needsDocumentBack(documentTypes) });
      } catch (err) {
        setInitError("Unsupported verification workflow");
        onErrorRef.current?.(err);
        return;
      }
      flowRef.current = flow;
      setFlowState(flow.state());
      off = flow.onChange((s) => {
        setFlowState(s);
        if (onStepChangeRef.current) onStepChangeRef.current(s.step);
      });
    })();
    return () => { cancelled = true; client?.dispose(); off(); };
  }, [baseUrl, publicKey, sessionId, sdkToken, initEpoch]);

  // camera lifecycle keyed on facingMode (not step) so same-camera transitions
  // like liveness → face keep the existing stream instead of restarting it.
  // Also keyed on `consented` because the <video> element only mounts after the
  // consent gate is dismissed.
  const captureFacing = (() => {
    const step = flowState?.step;
    return (isDocumentStep(step) || step === "face" || step === "liveness")
      ? STEP_COPY[step].facingMode
      : null;
  })();
  useEffect(() => {
    if (!consented || !captureFacing) return undefined;
    const video = videoRef.current;
    if (!video) return undefined;
    let cancelled = false;
    const cameraController = new AbortController();
    setCameraReady(false);
    startCamera(video, { facingMode: captureFacing, signal: cameraController.signal })
      .then((stream) => {
        // If this effect was torn down before getUserMedia resolved, stop the
        // freshly acquired stream so the camera doesn't stay on (leak) and don't
        // flip readiness for a step that no longer applies.
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        // P0 capture integrity: report the active camera's metadata (virtual
        // camera heuristics included) — sent to the server at submit.
        collectCaptureSignals(stream).then((sig) => {
          if (!cancelled && sig && clientRef.current) clientRef.current.setCaptureSignals(sig);
        }).catch(() => {});
        // B5: the OS ends the track when the app is backgrounded / camera is
        // taken by another app — surface it instead of ticking on a frozen frame
        const track = stream.getVideoTracks && stream.getVideoTracks()[0];
        if (track) track.onended = () => { if (!cancelled) { setCameraReady(false); setCameraPaused(true); } };
        if (!telemetryRef.current.startedAt) telemetryRef.current.startedAt = performance.now();
        setCameraReady(true);
      })
      .catch((err) => {
        if (cancelled || cameraController.signal.aborted) return;
        flowRef.current.fail({ code: "CAMERA_ERROR", message: err.message });
        if (onErrorRef.current) onErrorRef.current(err);
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

  // if there are no challenge actions, don't linger on the liveness step
  useEffect(() => {
    if (flowState?.step === "liveness" && actionsRef.current.length === 0) {
      flowRef.current.advance();
    }
  }, [flowState?.step]);

  // Start the challenge clock when the user REACHES the liveness step: the
  // server's challenge TTL and issue→first-frame window run from this call,
  // not from session creation (consent, camera permission and document
  // capture come first). Best-effort — on failure the server keeps the
  // original clock. Re-armed per challenge (retry / reissue).
  const begunEpochRef = useRef(-1);
  useEffect(() => {
    const client = clientRef.current;
    if (!client || !consented || flowState?.step !== "liveness" || actionsRef.current.length === 0) return;
    if (begunEpochRef.current === challengeEpoch) return;
    begunEpochRef.current = challengeEpoch;
    client.beginChallenge().catch(() => { begunEpochRef.current = -1; });
  }, [flowState?.step, consented, challengeEpoch]);

  // E1: compact capture telemetry sent with submit (never decision input)
  const buildTelemetry = () => {
    const t = telemetryRef.current;
    return {
      detectMs: t.detectMs, landmarkMs: t.landmarkMs, modelLoadMs: t.modelLoadMs,
      totalMs: t.startedAt ? Math.round(performance.now() - t.startedAt) : null,
      actions: t.actions.map((a) => ({ action: a.action, msToTrigger: a.msToTrigger, wrongWay: a.wrongWay, hints: a.hints, frames: a.frames, mode: a.mode || "unknown", reissued: a.reissued }))
    };
  };

  // D3: the user cannot perform the current action — ask for a different
  // challenge (server-capped + audited), excluding it.
  const reissueChallenge = useCallback(async () => {
    const client = clientRef.current;
    if (!client || busy || capturingRef.current) return;
    capturingRef.current = true;
    const action = actionsRef.current[actionIdxRef.current];
    setBusy(true);
    try {
      const r = await client.reissueChallenge([action]);
      if (client.controller.signal.aborted) return;
      const acts = r.livenessChallenge?.actions || [];
      const tel = telemetryRef.current.actions.find((a) => a.action === action && !a.done);
      if (tel) { tel.reissued = true; tel.done = true; }
      actionsRef.current = acts;
      setActions(acts);
      setChallengeEpoch(e => e + 1);
      livenessFrontalRef.current = null;
      livenessRefSamplesRef.current = [];
      actionIdxRef.current = 0;
      setActionIdx(0);
      livenessFrameCountsRef.current = {};
      setCanReissue(false);
    } catch (err) {
      setFeedback(err.message || String(err));
    } finally {
      capturingRef.current = false;
      setBusy(false);
    }
  }, [busy]);

  const capture = useCallback(async (opts = {}) => {
    // Called with an Event from the manual button, or {livenessAdvance} from
    // the burst loop — Event has no livenessAdvance, so manual defaults to true.
    const livenessAdvance = opts.livenessAdvance !== false;
    // How this liveness frame is being taken. The manual button passes an
    // Event (no .mode) → "manual"; the burst loop passes "auto"/"fallback".
    const captureMode = typeof opts.mode === "string" ? opts.mode : "manual";
    if (capturingRef.current) return;
    const flow = flowRef.current;
    // A latched step error (definitive server rejection, e.g. the session
    // evidence cap) must halt auto-capture/burst shots — the rAF tick keeps
    // calling capture() every frame while the user stays in position, spamming
    // uploads that can only fail again. The on-screen Retry (flow.retry())
    // clears the error and re-arms capture.
    if (!flow || flow.state().error) return;
    capturingRef.current = true;
    const client = clientRef.current;
    const step = flow.state().step;
    setBusy(true);
    setFeedback(null);
    // Shared "next action / next step" transition for the liveness step.
    const advanceLiveness = () => {
      const action = actionsRef.current[actionIdxRef.current];
      const tel = telemetryRef.current.actions.find((a) => a.action === action && !a.done);
      if (tel) { tel.frames = livenessFrameCountsRef.current[action] || 0; tel.done = true; }
      const next = actionIdxRef.current + 1;
      if (next >= actionsRef.current.length) {
        actionIdxRef.current = 0;
        setActionIdx(0);
        flow.advance(); // → face
      } else {
        actionIdxRef.current = next;
        setActionIdx(next);
      }
    };
    try {
      if (step === "liveness" && opts.advanceOnly) { advanceLiveness(); return true; }
      if (step === "liveness"
        && (livenessFrameCountsRef.current[actionsRef.current[actionIdxRef.current]] || 0) >= LIVENESS_FRAME_BUDGET) {
        // Budget spent for this action — no frame can be uploaded, so skip
        // the capture + quality gate entirely and just advance the flow.
        if (livenessAdvance) advanceLiveness();
        return;
      }
      // Documents are cropped to the on-screen card guide so the ID FILLS the
      // evidence photo (matches what the user aligned to; better OCR/review).
      await nextVideoFrame(videoRef.current, { signal: client.controller.signal });
      const { imageData, base64 } = isDocumentStep(step)
        ? captureGuideFrame(videoRef.current, DOC_GUIDE)
        : step === "liveness"
          ? captureFrame(videoRef.current, null, { maxSide: 640, quality: 0.85 }) // D4: challenge frames need no more
          : captureFrame(videoRef.current);
      // Sharpness gating is per-step:
      //   liveness — skipped: the head is MOVING, motion blur is evidence.
      //   face     — skipped WHEN the detector is active: the detect loop
      //              already enforces Laplacian focus on the FACE CROP before
      //              the ring goes green. Re-measuring the FULL frame here
      //              graded the background (a sharp face against a smooth
      //              wall scores "blurry" forever → capture never fired).
      //   document — full-frame gate kept (the card should fill the crop).
      // Brightness is always checked. The server judges authoritatively.
      const skipSharpness = step === "liveness" || (step === "face" && !!detectorRef.current);
      const quality = assessFrame(imageData, skipSharpness ? { minSharpness: 0 } : undefined);
      if (!quality.ok) {
        setFeedback(quality.issues.map((i) => ISSUE_COPY[i] || i).join(" "));
        return;
      }
      if (isDocumentStep(step)) {
        await client.uploadDocument(base64, step === "document_back" ? "back" : "front");
        if (client.controller.signal.aborted) return false;
        flow.advance();
        // ID_ONLY has no face step — the document is the last capture, so THIS
        // branch must submit, or the session sits in "started" forever.
        if (flow.state().step === "processing") {
          client.setCaptureTelemetry(buildTelemetry());
          await client.submit();
          const result = await client.waitForResult({ timeoutMs: 300000 }); // 5 min — covers worker restarts + stale-job reclaim
          if (client.controller.signal.aborted) return false;
          flow.finish(result);
          if (onCompleteRef.current) onCompleteRef.current(result);
        }
      } else if (step === "liveness") {
        const action = actionsRef.current[actionIdxRef.current];
        const counts = livenessFrameCountsRef.current;
        const used = counts[action] || 0;
        if (used < LIVENESS_FRAME_BUDGET) {
          try {
            await client.uploadLivenessFrame(action, base64, captureMode);
            counts[action] = used + 1;
            if (captureMode === "manual") { const t = telemetryRef.current.actions.find((a) => a.action === action && !a.done); if (t) t.mode = "manual"; else telemetryRef.current.actions.push({ action, msToTrigger: null, wrongWay: 0, hints: [], frames: 0, mode: "manual", reissued: false, done: false }); }
          } catch (err) {
            // Server says the action's budget is spent (frames from another
            // tab / a redo within the same challenge window). That means the
            // action already carries MAX evidence — completion, not failure:
            // swallow it, mark the budget spent locally, and let the flow
            // advance below. Every other error is real and still fails.
            if (!/too many liveness frames/i.test((err && err.message) || "")) throw err;
            counts[action] = LIVENESS_FRAME_BUDGET;
          }
        }
        // Budget already spent → skip the upload entirely (the server would
        // only reject it) but still advance so the flow can't dead-end.
        // Burst mode uploads several frames per action; only the last one
        // advances. More frames per action = far better odds the server finds
        // one live, single-face, pose-matching frame.
        if (livenessAdvance) advanceLiveness();
        return true;
      } else if (step === "face") {
        await client.uploadFace(base64);
        if (client.controller.signal.aborted) return false;
        // Screen-flash liveness (v7 1.1): the face is framed and frontal right
        // now — flash a random colour sequence and upload the tiled response.
        // Best-effort and record-first: any failure here must never block the
        // customer (the server scores what it gets; nothing = no signal).
        if (screenFlashRef.current && detectorRef.current && framingRef.current && framingRef.current.box) {
          try {
            const mosaic = await runScreenFlash(videoRef.current, framingRef.current.box, setFlashColor, client.flashSequence, client.controller.signal);
            if (mosaic) await client.uploadFlash(mosaic.base64, mosaic.sequence, mosaic.tile);
          } catch (_) { /* record-first: ignore */ } finally { setFlashColor(null); }
        }
        if (client.controller.signal.aborted) return false;
        flow.advance(); // → processing
        client.setCaptureTelemetry(buildTelemetry());
        await client.submit();
        const result = await client.waitForResult({ timeoutMs: 300000 }); // 5 min — covers worker restarts + stale-job reclaim
        if (client.controller.signal.aborted) return false;
        flow.finish(result);
        if (onCompleteRef.current) onCompleteRef.current(result);
      }
    } catch (err) {
      if (client.controller.signal.aborted) return false;
      flow.fail(err);
      if (onErrorRef.current) onErrorRef.current(err);
    } finally {
      setBusy(false);
      capturingRef.current = false;
    }
  }, [onComplete, onError]);

  // Keep a live ref to capture() so the auto-capture loop always calls the latest.
  const captureRef = useRef(capture);
  captureRef.current = capture;

  // Try again after a rejected / review / failed outcome. The server reopens
  // the session, reissues the challenge, logs the attempt, and enforces the cap.
  const retryVerification = useCallback(async () => {
    const client = clientRef.current;
    const flow = flowRef.current;
    if (!client || !flow || busy || capturingRef.current) return;
    capturingRef.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      const r = await client.retrySession();
      if (client.controller.signal.aborted) return;
      setChallengeEpoch(e => e + 1);
      const acts = r.livenessChallenge?.actions || [];
      actionsRef.current = acts;
      livenessFrameCountsRef.current = {}; // reissued challenge → fresh budgets
      livenessFrontalRef.current = null;    // new attempt → fresh frontal reference (user may have moved)
      livenessRefSamplesRef.current = [];
      livenessStabRef.current = null;
      telemetryRef.current = { actions: [], detectMs: null, landmarkMs: null, modelLoadMs: null, startedAt: 0 };
      setActions(acts);
      actionIdxRef.current = 0;
      setActionIdx(0);
      setAttemptInfo({
        attempts: r.attempts,
        manualUpload: !!r.manualUploadSuggested,
        exhausted: (r.attemptsRemaining ?? 1) <= 0
      });
      flow.reset();
    } catch (err) {
      if (client.controller.signal.aborted) return;
      if (err && err.code === "RETRY_LIMIT_REACHED") {
        setAttemptInfo((s) => ({ ...s, exhausted: true }));
      }
      setFeedback(err.message || String(err));
    } finally {
      setBusy(false);
      capturingRef.current = false;
    }
  }, [busy]);

  // Manual file upload for the DOCUMENT after repeated camera failures.
  // Deliberately document-only: selfie and liveness must stay live captures
  // or the anti-spoofing guarantees are meaningless.
  const onDocumentFile = useCallback(async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // allow picking the same file again
    if (!file || capturingRef.current) return;
    const flow = flowRef.current;
    const client = clientRef.current;
    const step = flow?.state().step;
    if (!client || client.controller.signal.aborted || !isDocumentStep(step)) return;
    capturingRef.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      if (file.size > 3 * 1024 * 1024) throw new Error("Image is larger than 3MB — choose a smaller photo.");
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Could not read the selected file."));
        reader.readAsDataURL(file);
      });
      if (client.controller.signal.aborted) return;
      if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(base64)) {
        throw new Error("Choose a JPEG or PNG photo of your ID.");
      }
      await client.uploadDocument(base64, step === "document_back" ? "back" : "front");
      if (client.controller.signal.aborted) return;
      flow.advance();
      if (flow.state().step === "processing") {
        client.setCaptureTelemetry(buildTelemetry());
        await client.submit();
        const result = await client.waitForResult({ timeoutMs: 300000 }); // 5 min — covers worker restarts + stale-job reclaim
        if (client.controller.signal.aborted) return false;
        flow.finish(result);
        if (onCompleteRef.current) onCompleteRef.current(result);
      }
    } catch (err) {
      if (client.controller.signal.aborted) return;
      setFeedback(err.message || String(err));
    } finally {
      setBusy(false);
      capturingRef.current = false;
    }
  }, []);

  // Load the browser face model (optional). If it fails, we fall back to
  // motion-based auto-capture and the frame won't gate on face framing.
  useEffect(() => {
    if (!faceModelUrl) {
      detectorRef.current = null;
      setDetectorStatus("disabled");
      return undefined;
    }
    let disposed = false;
    let det = null;
    const modelController = new AbortController();
    detectorRef.current = null;
    setDetectorStatus("loading");
    let timedOut = false;
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => { timedOut = true; modelController.abort(); reject(new Error("Face model load timed out")); }, 12000);
    });
    // Framing: minRatio relaxed 0.34 → 0.24. Replay of real sessions showed the
    // median face width at a normal laptop distance is ≈0.34 of the frame, so
    // half of all well-positioned frames read "Move closer". 0.24 still keeps
    // a face large enough for the server's liveness/face-match crops.
    const detectorOpts = { landmarkUrl: landmarkModelUrl, framing: { minRatio: 0.24, centerTol: 0.13 }, signal: modelController.signal };
    const loadStart = performance.now();
    Promise.race([createFaceDetector(faceModelUrl, detectorOpts).then(d => { if (disposed || timedOut) { d.dispose?.(); throw new Error("Model load cancelled"); } return d; }), timeout])
      .then((d) => {
        if (disposed) { d.dispose && d.dispose(); return; }
        clearTimeout(timeoutId);
        det = d;
        detectorRef.current = d;
        telemetryRef.current.modelLoadMs = Math.round(performance.now() - loadStart);
        setDetectorStatus("ready");
      })
      .catch(() => {
        clearTimeout(timeoutId);
        if (disposed) return;
        detectorRef.current = null;
        setDetectorStatus("failed");
      });
    return () => { disposed = true; modelController.abort(); clearTimeout(timeoutId); detectorRef.current = null; if (det && det.dispose) det.dispose(); };
  }, [faceModelUrl, landmarkModelUrl]);

  // Auto-capture loop. When the face model is loaded (face/liveness steps), the
  // frame turns green only when a face is present at the right distance and
  // centered ("in focus"). For liveness, a short action window gives the user
  // time to perform the prompt, then the server verifies whether it was valid.
  // On the ID step, it falls back to a steady, well-lit frame. Face/liveness
  // steps fail closed for auto-capture when the model is loading or unavailable
  // so a bright empty frame cannot advance the flow.
  useEffect(() => {
    const step = flowState?.step;
    if (!cameraReady) return undefined;
    if (!(isDocumentStep(step) || step === "face" || step === "liveness")) return undefined;

    setGreen(false);
    framingRef.current = null;
    setLivePhase({ phase: "align", startedAt: 0, total: 0 });
    setFramingGuide(step === "face" || step === "liveness"
      ? detectorStatus === "failed" ? "model_error" : "model_loading"
      : "no_face");
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
    // temporal smoothing: no flicker, no hold-timer resets on jitter. On the
    // liveness step the stabilizer is shared across actions: if the user is
    // still locked from the previous action we go straight to "await".
    const reuseStab = step === "liveness" && !!livenessStabRef.current;
    const stab = reuseStab ? livenessStabRef.current : createFramingStabilizer();
    if (step === "liveness") livenessStabRef.current = stab; else { livenessStabRef.current = null; livenessFrontalRef.current = null; livenessRefSamplesRef.current = []; }
    let stable = null;
    // Document step gate: "change-then-steady" — learns the EMPTY scene first,
    // then requires the ID to actually enter the frame (sustained scene change)
    // and be held still. A bare steadiness check photographed empty rooms.
    const docGate = isDocumentStep(step) ? createDocumentGate() : null;
    let docState = { armed: false, present: false, steady: false, ready: false, shape: null };
    let lastDocSeen = false;
    let lastDocShapeOk = false;
    setDocSeen(false);
    setDocShapeOk(false);
    // Face-vs-card check on the document step (hysteresis so it doesn't flap)
    let docBlockStreak = 0;
    let docClearStreak = 0;
    let docFaceNow = false;
    let docRelaxSince = 0;
    setDocFaceBlocked(false);
    const HOLD_MS = 550;
    const SETTLE_DELTA = 3;
    const DETECT_MS = 110; // faster sampling → triggers fire ~1 frame sooner
    // Liveness three-phase capture:
    //   align     — lock a frontal face (baseline box recorded)
    //   await     — instruction shown; WAIT until the face-box dynamics (or a
    //               motion spike, for blink/smile) show the action is actually
    //               being performed. No timer-based capture: nothing uploads
    //               until the user moves.
    //   capturing — short burst (3 frames over ~700ms) at the action's peak.
    const ALIGN_LOCK_MS = reuseStab ? 120 : 350; // subsequent actions: already locked
    // Burst timing: FIRST frame fires AT the trigger, while the turning face
    // is still detectable by the server's frontal-biased detector — every
    // action needs at least one face-bearing frame or it's INCOMPLETE. Later
    // frames catch the pose peak for the (calibration/pose) evidence.
    const BURST_AT = [0, 350, 700]; // offsets from the trigger moment
    const BURST_TOTAL = 800;        // progress bar duration
    const AWAIT_HINT_MS = 3500;     // no movement detected → coach the user
    // Detection here is UX-only — the server verifies pose magnitude and
    // liveness authoritatively. If THIS action's signature never fires (the
    // frontal-biased detector loses some faces sooner turning one way than
    // the other — turn_right vs turn_left asymmetry on some cameras/lighting),
    // don't starve the flow forever: after the hint has been up a while,
    // capture a fallback burst while the user performs the movement anyway.
    const AWAIT_FALLBACK_MS = 9000; // hint shown + still no trigger → fallback burst
    const AWAIT_FACE_LOST_MS = 4000; // face gone this long → back to align
    // Document step: if something is present, lit and face-clear this long but
    // the strict card-shape gate hasn't passed (hand/forearm in the mask,
    // low-contrast card), capture anyway — server validation backstops.
    const DOC_SHAPE_RELAX_MS = 5000;
    const currentAction = actionsRef.current[actionIdxRef.current] || null;
    let phase = "align";
    let baselineBox = null;
    let awaitStart = 0;
    let triggerAt = 0;
    let shots = 0;
    let hintShown = false;
    let lastHint = null;      // last diagnosis shown ("wrong_way" | "face_lost" | "further" | "none")
    let lastHintAt = 0;
    // The pitch proxy from the browser landmarks is noisy on tilted faces: a
    // single "wrong way" tick coaching the user to reverse a correct look-down
    // pushed testers into reissuing the challenge (3 sessions, 2026-09-07).
    // Only a sustained opposite-direction reading is a wrong-way diagnosis.
    let wrongWayStreak = 0;
    const WRONG_WAY_TICKS = 4;
    // What did the detector actually see? Drives the coaching copy.
    //   wrong_way — pose moved past threshold in the OPPOSITE direction
    //   face_lost — the face left detection mid-movement
    //   further   — some movement, below threshold
    //   none      — nothing at all
    const isExprAction = () => currentAction === "blink" || currentAction === "open_mouth" || currentAction === "smile";
    const coachDiag = (now) => (actionState.armed === false && now - lastPresentAt <= 700) ? (isExprAction() ? "none" : "recenter")
      : wrongWayStreak >= WRONG_WAY_TICKS ? "wrong_way"
      : (now - lastPresentAt > 700) ? "face_lost"
      : (actionState.magnitude > 0.08) ? "further"
      : "none";
    let lastPresentAt = performance.now();
    // Action-SPECIFIC detector (geometry signature for turns/tilts, eye/mouth
    // band motion for blink/smile) — created when align completes.
    let actionDet = null;
    let actionState = { ok: false, triggered: false, holding: false, armed: true, hasPose: false };
    let prevModelGray = null;
    // One frame captured at the FIRST action-consistent detection while the
    // face is still visible — the disappearance-clause trigger often fires
    // after the face has already turned out of detection range, and the
    // server requires at least one face-bearing frame per action.
    let earlyShotTaken = false;
    let expressionShotTaken = false;
    // True when the current burst was started by the AWAIT_FALLBACK_MS timer
    // rather than the action detector — relaxes the per-shot hold/presence
    // gates that a detector-blind movement can never satisfy.
    let fallbackBurst = false;
    let budgetHintShown = false;
    let detectEma = null;     // EMA of the detect+landmark pass (ms)
    let awaitSamples = 0;     // detections seen since the instruction appeared
    const AWAIT_MIN_SAMPLES = 12; // B4: coach after this many looks (and ≥2.5 s)
    const REISSUE_OFFER_MS = 15000; // D3: offer "try a different movement"
    let reissueOffered = false;
    // per-action telemetry entry (E1)
    const telEntry = () => {
      const t = telemetryRef.current;
      let e = t.actions.find((a) => a.action === currentAction && !a.done);
      if (!e) { e = { action: currentAction, msToTrigger: null, wrongWay: 0, hints: [], frames: 0, mode: null, reissued: false, done: false }; t.actions.push(e); }
      return e;
    };

    const tick = () => {
      if (cancelled) return;
      if (document.hidden) { raf = requestAnimationFrame(tick); return; }
      const video = videoRef.current;
      if (video) {
        const now = performance.now();
        const faceStep = step === "face" || step === "liveness";
        const requiresFaceModel = !!faceModelUrl && faceStep;
        const faceGate = requiresFaceModel && detectorStatus === "ready" && !!detectorRef.current;

        // motion + light from a cheap downscaled frame
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
            // With dims the gate is fail-closed: ready additionally requires
            // the change-region to be CARD-shaped (straight-edged solid
            // rectangle) — a person/hand/wall present+steady never captures.
            docState = docGate.update(gray, small.width, small.height);
            if (docState.present !== lastDocSeen) {
              lastDocSeen = docState.present;
              setDocSeen(docState.present);
            }
            const shapeOk = !!(docState.shape && docState.shape.cardLike);
            if (shapeOk !== lastDocShapeOk) {
              lastDocShapeOk = shapeOk;
              setDocShapeOk(shapeOk);
            }
          }
        }

        // face model framing (throttled) for face/liveness
        if (faceModelUrl && detectorStatus === "failed" && publishedGuide !== "model_error") {
          publishedGuide = "model_error";
          setFramingGuide("model_error");
        } else if (requiresFaceModel && !faceGate && publishedGuide !== "model_loading") {
          publishedGuide = "model_loading";
          setFramingGuide("model_loading");
        }

        // On the DOCUMENT step the detector serves the opposite purpose:
        // block capture while a LIVE face dominates the frame (people show
        // their face instead of the card).
        const docDetect = isDocumentStep(step) && !!faceModelUrl && detectorStatus === "ready" && !!detectorRef.current;

        if ((faceGate || docDetect) && !detecting && now - lastDetect > DETECT_MS && !capturingRef.current) {
          lastDetect = now;
          detecting = true;
          // Face steps analyse the SAME center-square the circular preview
          // shows so the green gate agrees with what the user sees. The
          // document step must scan the FULL frame — a face outside the
          // center square (leaning in from the side) still has to block.
          const modelFrame = docDetect ? grabFixedFrame(video, 320, 240) : grabSquareFrame(video, 320, 240);
          const detectStart = performance.now();
          detectorRef.current
            .detect(modelFrame)
            .then((f) => {
              if (cancelled) return;
              // B4: running average of the detect+landmark pass; the coaching
              // timers count SAMPLES, not wall-clock, so a slow phone gets the
              // same number of looks before being coached.
              const passMs = performance.now() - detectStart;
              detectEma = detectEma == null ? passMs : detectEma * 0.8 + passMs * 0.2;
              telemetryRef.current.detectMs = Math.round(detectEma);
              if (phase === "await") awaitSamples++;
              if (docDetect) {
                // Relative rule when a card region is visible: a real ID's
                // printed portrait is a small fraction of the card's width; a
                // face (live or photo) filling the "document" blocks capture.
                const shape = docState.shape;
                const docWidthPx = shape && shape.found ? shape.widthFrac * 320 : 0;
                const blocked = isDominantFace(f && f.box, 320, { docWidthPx });
                docBlockStreak = blocked ? docBlockStreak + 1 : 0;
                docClearStreak = blocked ? 0 : docClearStreak + 1;
                if (!docFaceNow && docBlockStreak >= 2) {
                  docFaceNow = true;
                  setDocFaceBlocked(true);
                } else if (docFaceNow && docClearStreak >= 3) {
                  docFaceNow = false;
                  setDocFaceBlocked(false);
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
              // Stabilizer absorbs per-detection jitter; publish its guide only
              // on real change (dwell-timed inside), so the pill never flickers.
              stable = stab.update(next, performance.now());
              if (stable.guide && stable.guide !== publishedGuide) {
                publishedGuide = stable.guide;
                setFramingGuide(stable.guide);
              }
              // Feed the per-action detector: box geometry vs baseline, plus
              // eye/mouth band motion between consecutive detection frames
              // (expressions don't move the box). Bands fall back to the
              // baseline box while the head is mid-expression.
              if (actionDet) {
                const gray = toGrayscale(modelFrame);
                const bandBox = next.box || actionDet.baseline;
                const bands = prevModelGray && bandBox
                  ? bandMotion(prevModelGray, gray, 320, bandBox)
                  : { eyes: 0, mouth: 0 };
                prevModelGray = gray;
                actionState = actionDet.update({ box: next.box, eyes: bands.eyes, mouth: bands.mouth, pose: next.pose || null, expr: next.expr || null });
                wrongWayStreak = actionState.wrongWay ? wrongWayStreak + 1 : 0;
              } else {
                prevModelGray = toGrayscale(modelFrame);
              }
            })
            .catch(() => {
              if (cancelled) return;
              framingRef.current = { present: false, inFrame: false, guide: "no_face" };
              stable = stab.update(framingRef.current, performance.now());
            })
            .finally(() => { detecting = false; });
        }

        const lockedOk = faceGate && !!(stable && stable.locked) && lightOk;

        // Liveness needs the LANDMARK model (pose): with only the box detector
        // a movement cannot be matched to an instruction, so the step fails
        // closed to manual capture instead of guessing from motion.
        const poseGate = faceGate && !!(detectorRef.current && detectorRef.current.hasLandmarks);
        if (step === "liveness" && poseGate) {
          const rawBox = framingRef.current && framingRef.current.box;
          const facePresent = !!(stable && stable.present);
          if (facePresent) lastPresentAt = now;

          if (phase === "align") {
            setGreen(lockedOk);
            const alignPose = framingRef.current && framingRef.current.pose;
            const alignFrontal = !alignPose || isFrontalPose(alignPose);
            // accumulate reference-frontal samples (tight band) while aligning
            if (alignPose && lockedOk && isReferencePose(alignPose)) {
              const arr = livenessRefSamplesRef.current;
              if (!arr.length || arr[arr.length - 1].observedAt !== framingRef.current.observedAt) { arr.push({ yaw: alignPose.yaw, pitch: alignPose.pitch, observedAt: framingRef.current.observedAt }); if (arr.length > 15) arr.shift(); }
            }
            if (lockedOk && alignFrontal && stable.lockedSince && now - stable.lockedSince >= ALIGN_LOCK_MS) {
              phase = "await";
              baselineBox = (stable && stable.box) || rawBox || null;
              // session reference = MEDIAN of the reference-frontal samples seen
              // while aligning (a single frame captured mid-lean blocked arming
              // for the whole session in replay)
              const refFromSamples = frontalRefFromSamples(livenessRefSamplesRef.current);
              if (refFromSamples && (!livenessFrontalRef.current || refFromSamples.samples >= 3)) {
                livenessFrontalRef.current = { yaw: refFromSamples.yaw, pitch: refFromSamples.pitch };
              }
              actionDet = createActionDetector(currentAction, baselineBox, {
                frontalRef: livenessFrontalRef.current,
                requireArm: true, // count nothing until the face is frontal again
                mirrorPreview: true // face steps render the video with scaleX(-1); direction is toward the arrow
              });
              actionState = { ok: false, triggered: false, holding: false, armed: true, hasPose: false };
              earlyShotTaken = false;
              expressionShotTaken = false;
              awaitStart = now;
              awaitSamples = 0;
              hintShown = false;
              reissueOffered = false;
              setCanReissue(false);
              setLivePhase({ phase: "await", startedAt: now, total: 0, hint: false });
            }
          } else if (phase === "await") {
            // Instruction shown — capture NOTHING until THIS action's own
            // signature is seen (2 consecutive detections; jitter can't fire it).
            setGreen(true);
            // Budget spent for this action (redo cycles): nothing more can be
            // uploaded, so asking for ANOTHER head turn is pure neck pain.
            // Advance immediately — the action already carries max evidence.
            if ((livenessFrameCountsRef.current[currentAction] || 0) >= LIVENESS_FRAME_BUDGET) {
              // Budget spent: the frames already uploaded carry whatever was
              // seen. Do NOT advance silently (the user would read that as
              // "it accepted a movement I didn't make") — explain and let the
              // user continue explicitly; the server judges the evidence.
              if (!budgetHintShown) { budgetHintShown = true; setLivePhase({ phase: "await", startedAt: awaitStart, total: 0, hint: "budget" }); }
              raf = requestAnimationFrame(tick);
              return;
            }
            // the detector self-heals a bad reference; keep the session in sync
            if (actionDet && actionDet.healed && actionDet.poseBaseline) livenessFrontalRef.current = actionDet.poseBaseline;
            // Taken as soon as the face is detectable in the await phase: it
            // is the FRONTAL reference for this action — the only frame of a
            // look-up/look-down burst the frontal-biased passive model can
            // score, and the start point of the trajectory. The server
            // excludes it from the per-action time window, so coaching time
            // before the movement no longer counts against the user.
            if (rawBox && !earlyShotTaken && !capturingRef.current) {
              // movement just started and the face is STILL detectable —
              // grab the guaranteed face-bearing frame for this action now
              captureRef.current({ livenessAdvance: false, mode: "auto" }).then(ok => { if (!cancelled && ok) earlyShotTaken = true; });
            }
            if (earlyShotTaken && !expressionShotTaken && ["blink", "open_mouth"].includes(currentAction) && actionState.ok && !capturingRef.current) {
              captureRef.current({ livenessAdvance: false, mode: "auto" }).then(ok => { if (!cancelled && ok) expressionShotTaken = true; });
            }
            if (facePresent && actionState.triggered) {
              phase = "capturing";
              fallbackBurst = false;
              triggerAt = now;
              shots = 0;
              telEntry().msToTrigger = Math.round(now - awaitStart);
              telEntry().mode = "auto";
              setCanReissue(false);
              setLivePhase({ phase: "capturing", startedAt: now, total: BURST_TOTAL });
            } else if ((awaitSamples >= AWAIT_MIN_SAMPLES || now - awaitStart > AWAIT_HINT_MS) && now - awaitStart >= 2500 && now - lastHintAt > 900 && coachDiag(now) !== lastHint) {
              // Coach from DIAGNOSIS, not a timer (see coachDiag). Only a CHANGED
              // diagnosis stops the chain here, so the fallback / face-lost
              // branches below still run on the other ticks.
              lastHint = coachDiag(now);
              lastHintAt = now;
              hintShown = true;
              telEntry().hints.push(lastHint);
              if (lastHint === "wrong_way") telEntry().wrongWay++;
              setLivePhase({ phase: "await", startedAt: awaitStart, total: 0, hint: lastHint });
              if (now - awaitStart > REISSUE_OFFER_MS && !reissueOffered) { reissueOffered = true; setCanReissue(true); }
            } else if (hintShown && now - awaitStart > AWAIT_FALLBACK_MS
              && !actionState.hasPose // with live pose the detector is not blind — keep coaching instead
              && now - lastPresentAt < 2000 && !capturingRef.current) {
              // The user has been here, coached, and moving for ~9s without
              // the signature firing — capture anyway; the server is the
              // authoritative judge of whether the action happened.
              phase = "capturing";
              fallbackBurst = true;
              triggerAt = now;
              shots = 0;
              telEntry().mode = "fallback";
              setCanReissue(false);
              setLivePhase({ phase: "capturing", startedAt: now, total: BURST_TOTAL });
            } else if (now - lastPresentAt > AWAIT_FACE_LOST_MS) {
              phase = "align"; // user walked off — re-establish the baseline
              actionDet = null;
              setLivePhase({ phase: "align", startedAt: 0, total: 0 });
            }
          } else {
            // capturing: burst while the pose is HELD. Turns/tilts require the
            // geometric signature at each shot (frames must show the action);
            // blink/smile are momentary, so their shots follow the schedule.
            setGreen(true);
            // blink: shots 2–3 deliberately follow the schedule so the burst
            // holds closed-eye (early + trigger) AND re-opened frames.
            const holdRequired = currentAction !== "blink" && currentAction !== "smile" && currentAction !== "open_mouth";
            // Hold is required only for the FIRST shot (fired AT the trigger,
            // inherently mid-action). Demanding it for later shots stalled the
            // whole burst whenever the user snapped back to frontal quickly —
            // the early faced-frame + trigger frame already carry the action
            // evidence, and the server tolerates mid-return frames.
            // B2: later shots must still show the movement (≥60 % of the
            // trigger threshold) or they add frontal frames that read as a
            // static trajectory server-side; if the pose is released, finish
            // the burst with what was captured (the early + trigger frames
            // already carry the action).
            const tiltAction = currentAction === "look_up" || currentAction === "look_down";
            const stillTurned = actionState.holding || actionState.magnitude >= 0.6 * (tiltAction ? 0.2 : 0.22);
            const canShoot = fallbackBurst
              // Fallback burst: the detector never saw the action, so demanding
              // `holding` would stall forever. The FIRST shot still waits for a
              // detectable face (the server needs one face-bearing frame per
              // action); later shots may catch the mid-turn profile the
              // frontal-biased detector loses.
              ? (shots > 0 || facePresent)
              : (shots === 0 ? (!holdRequired || actionState.holding) : (!holdRequired || stillTurned));
            const presenceOk = facePresent || (fallbackBurst && shots > 0);
            if (shots < BURST_AT.length && now - triggerAt >= BURST_AT[shots] && !capturingRef.current && presenceOk && canShoot) {
              const isLast = shots === BURST_AT.length - 1;
              captureRef.current({ livenessAdvance: isLast, mode: fallbackBurst ? "fallback" : "auto" }).then(ok => { if (!cancelled && ok) shots++; });
            } else if (!fallbackBurst && shots >= 2 && shots < BURST_AT.length && !capturingRef.current && now - triggerAt > BURST_AT[shots] + 1200) {
              // pose released before the remaining shots: finish the action
              // with the frames already uploaded — no frontal padding frames
              shots = BURST_AT.length;
              captureRef.current({ advanceOnly: true });
            } else if (!capturingRef.current && now - triggerAt > BURST_TOTAL + 1500) {
              // Burst stalled (pose released mid-burst, or an upload was
              // rejected by the quality gate) — return to await with a FRESH
              // detector so the user redoes the movement; a stale latched
              // trigger would re-fire instantly.
              phase = "await";
              fallbackBurst = false;
              actionDet = createActionDetector(currentAction, baselineBox, { frontalRef: livenessFrontalRef.current, requireArm: true, mirrorPreview: true });
              actionState = { ok: false, triggered: false, holding: false, armed: true, hasPose: false };
              // redo cycle: the early face-bearing frame already exists for this
              // action — don't spend another budget slot on it
              earlyShotTaken = true;
              awaitStart = now;
              hintShown = true;
              lastHint = "none";
              lastHintAt = now;
              setLivePhase({ phase: "await", startedAt: now, total: 0, hint: "none" });
            }
          }
        } else if (!capturingRef.current) {
          // Doc capture may only proceed once the face check has POSITIVELY
          // cleared the frame (>=2 consecutive detections without a dominant
          // face). While the model is still loading nothing has been checked,
          // so capture waits — otherwise a face gets photographed as "ID"
          // during the load window. Detector failed/absent degrades gracefully.
          const docFaceClear = !faceModelUrl || detectorStatus === "failed"
            ? true
            : docDetect && !docFaceNow && docClearStreak >= 2;
          // Shape-relax timer: real hands holding real cards can corrupt the
          // change-mask (the forearm merges into the region), starving the
          // strict cardLike gate forever. If SOMETHING has been present, lit
          // and face-clear for a sustained window, capture anyway — the
          // dominant-face veto stays active and the server independently
          // rejects a live face submitted as a document.
          if (docGate && docState.present && lightOk && docFaceClear) {
            if (!docRelaxSince) docRelaxSince = now;
          } else {
            docRelaxSince = 0;
          }
          const docRelaxed = docRelaxSince > 0 && now - docRelaxSince > DOC_SHAPE_RELAX_MS;
          // Selfie: besides the framing lock, require a FRONTAL pose when the
          // landmark model is available — passive liveness and face-match
          // score turned/tilted faces low, and replayed sessions showed the
          // selfie being captured mid-lean (→ manual review).
          const latestPose = framingRef.current && framingRef.current.pose;
          const frontalOk = step !== "face" || !latestPose || isFrontalPose(latestPose);
          // FAIL CLOSED on the liveness step: with no face detector there is
          // nothing to match the instruction against, so motion-settle
          // auto-capture would "complete" every action the moment the user
          // holds still (this is what happened on the hosted page, which
          // shipped without models). Manual capture stays available and the
          // server verifies pose on what it receives.
          const livenessBlind = step === "liveness" && !(faceGate && detectorRef.current && detectorRef.current.hasLandmarks);
          const inPosition = livenessBlind ? false
            : requiresFaceModel
            ? lockedOk && frontalOk
            : docGate ? (docState.ready || docRelaxed) && lightOk && docFaceClear
              : settled && lightOk;
          setGreen(inPosition);
          if (inPosition) {
            if (!greenSince) greenSince = now;
            else if (now - greenSince > HOLD_MS) { greenSince = 0; captureRef.current(); }
          } else {
            greenSince = 0;
          }
        }

        if (DEBUG && faceStep && now - lastDebugAt > 250) {
          lastDebugAt = now;
          const p = framingRef.current && framingRef.current.pose;
          const pb = actionDet && actionDet.poseBaseline;
          setDebugInfo({
            phase, action: currentAction, guide: publishedGuide,
            yaw: p ? p.yaw : null, pitch: p ? p.pitch : null,
            dYaw: p && pb ? p.yaw - pb.yaw : null, dPitch: p && pb ? p.pitch - pb.pitch : null,
            ratio: framingRef.current && framingRef.current.ratio,
            ok: actionState.ok, holding: actionState.holding, wrongWay: actionState.wrongWay,
            frames: livenessFrameCountsRef.current[currentAction] || 0
          });
        }

        // Overlay: draw the detected face box (mapped to the display square) so
        // framing is visible. The canvas shares the video's mirror transform.
        const canvas = overlayRef.current;
        if (canvas && faceStep) {
          const cw = canvas.width;
          const ch = canvas.height;
          const ctx = canvas.getContext("2d");
          ctx.clearRect(0, 0, cw, ch);
          if (DEBUG) {
            ctx.strokeStyle = "rgba(255,255,255,0.6)";
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.arc(cw / 2, ch / 2, cw * 0.11, 0, 2 * Math.PI); ctx.stroke();
            ctx.fillStyle = "rgba(255,255,255,0.6)";
            ctx.beginPath(); ctx.arc(cw / 2, ch / 2, 2, 0, 2 * Math.PI); ctx.fill();
          }
          // Align phase: the SMOOTHED box (EMA) glides instead of twitching.
          // During the movement itself draw the RAW detection — the EMA trails
          // a moving face by 200–450 ms and reads as "it can't see me".
          const moving = step === "liveness" && phase !== "align";
          const b = moving
            ? (framingRef.current && framingRef.current.box) || (stable && stable.box)
            : (stable && stable.box) || (framingRef.current && framingRef.current.box);
          if (b) {
            const x = (b.x1 / 320) * cw;
            const y = (b.y1 / 240) * ch;
            const w = ((b.x2 - b.x1) / 320) * cw;
            const h = ((b.y2 - b.y1) / 240) * ch;
            ctx.strokeStyle = stable && stable.locked ? "#10B981" : "#F59E0B";
            ctx.lineWidth = 2;
            ctx.strokeRect(x, y, w, h);
            if (DEBUG) {
              ctx.fillStyle = "red";
              ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, 3, 0, 2 * Math.PI); ctx.fill();
            }
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelled = true; cancelAnimationFrame(raf); setGreen(false); framingRef.current = null; };
  }, [cameraReady, flowState?.step, actionIdx, challengeEpoch, faceModelUrl, detectorStatus]);

  if (initError) return <div role="alert"><p>{initError}</p><button onClick={() => { setInitError(null); setInitEpoch(e => e + 1); }}>Retry loading verification</button></div>;
  if (!flowState) return <p role="status">Loading verification…</p>;
  const { step, steps, stepIndex, error, result } = flowState;
  const copy = STEP_COPY[step];
  const primary = theme.primaryColor || "#6D28D9";
  const isLiveness = step === "liveness";
  const livenessAction = isLiveness ? actions[actionIdx] : null;
  const title = isLiveness && livenessAction
    ? `Liveness check (${actionIdx + 1}/${actions.length})`
    : copy.title;
  const hint = isLiveness && livenessAction
    ? (ACTION_COPY[livenessAction] || livenessAction)
    : copy.hint;
  const isDoc = isDocumentStep(step);
  const isCaptureStep = isDocumentStep(step) || step === "face" || step === "liveness";
  const frameW = isDoc ? 340 : 280;
  const frameH = isDoc ? 212 : 280;
  const pillText = isLiveness ? (PILL_COPY[livenessAction] || ACTION_COPY[livenessAction] || livenessAction)
    : isDoc ? "Fit your ID inside the frame"
    : "Center your face in the circle";
  const faceStep = step === "face" || step === "liveness";
  const awaiting = isLiveness && livePhase.phase === "await";
  const capturingBurst = isLiveness && livePhase.phase === "capturing";
  const performing = awaiting || capturingBurst;
  // While awaiting/capturing the pill shows ONLY the action — framing guides
  // are irrelevant mid-movement, and swapping them caused flicker.
  const showGuide = faceStep && !green && !performing;
  const pillDisplay = showGuide ? (GUIDE_COPY[framingGuide] || "Position your face") : pillText;
  const ringColor = green ? "#059669" : "#E5E7EB";

  if (!consented) {
    return (
      <div style={{ maxWidth: 420, margin: "0 auto", fontFamily: "system-ui, sans-serif" }}>
        {theme.logoUrl && (
          <img src={theme.logoUrl} alt="" style={{ height: 32, marginBottom: 12 }} />
        )}
        <h2 style={{ margin: "0 0 8px", fontSize: 20 }}>Consent required</h2>
        {feedback && <p role="alert">{feedback}</p>}
        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", color: "#374151", fontSize: 14, lineHeight: 1.45 }}>
          <input type="checkbox" checked={consentChecked} onChange={(e) => setConsentChecked(e.target.checked)} style={{ marginTop: 3 }} />
          <span>{consentCopy}</span>
        </label>
        {screenFlash && <label style={{ display: "block", margin: "12px 0" }}>
          <input type="checkbox" checked={allowFlash} onChange={e => setAllowFlash(e.target.checked)} />
          Allow a short sequence of changing screen colours. Leave this unchecked if flashing light causes discomfort; verification can be reviewed without it.
        </label>}
        <button
          type="button"
          onClick={async () => {
            if (!clientRef.current || busy) return;
            setBusy(true); setFeedback(null);
            try { await clientRef.current.recordConsent(CONSENT_COPY_VERSION); setConsented(true); }
            catch (err) { setFeedback(err.message); }
            finally { setBusy(false); }
          }}
          disabled={!consentChecked || busy}
          style={{
            width: "100%", marginTop: 16, padding: "12px 0", borderRadius: 8,
            background: primary, color: "#fff", border: 0, fontSize: 16,
            cursor: consentChecked ? "pointer" : "not-allowed", opacity: consentChecked ? 1 : 0.45
          }}
        >
          Continue
        </button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 420, margin: "0 auto", fontFamily: "system-ui, sans-serif" }}>
      {theme.logoUrl && (
        <img src={theme.logoUrl} alt="" style={{ height: 32, marginBottom: 12 }} />
      )}

      {/* progress */}
      <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
        {steps.filter((s) => s !== "complete").map((s, i) => (
          <div key={s} style={{
            flex: 1, height: 4, borderRadius: 2,
            background: i <= stepIndex ? primary : "#E5E7EB"
          }} />
        ))}
      </div>

      <h2 style={{ margin: "0 0 12px", fontSize: 20 }}>{title}</h2>

      {isCaptureStep && (
        <div>
          <div style={{ position: "relative", width: frameW, margin: "0 auto" }}>
            {/* action prompt pill */}
            <div aria-live="assertive" role="status" style={{
              position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)", zIndex: 2,
              background: "#111827", color: "#fff", padding: "6px 14px", borderRadius: 999,
              fontSize: 14, whiteSpace: "nowrap", maxWidth: "calc(100% - 16px)", overflow: "hidden", textOverflow: "ellipsis",
              boxShadow: "0 2px 10px rgba(0,0,0,0.25)"
            }}>
              {pillDisplay}
            </div>
            {/* framed (circular for face/liveness) camera preview */}
            <div style={{
              position: "relative",
              width: frameW, height: frameH, margin: "0 auto",
              borderRadius: isDoc ? 16 : "50%", overflow: "hidden", background: "#111",
              border: `4px solid ${ringColor}`,
              boxShadow: green ? "0 0 0 4px rgba(5,150,105,0.25)" : "none",
              transition: "border-color .15s, box-shadow .15s"
            }}>
              <video
                ref={videoRef}
                playsInline
                muted
                style={{ width: "100%", height: "100%", objectFit: "cover", transform: isDoc ? "none" : "scaleX(-1)" }}
              />
              {isDoc && (
                /* card-aspect guide — capture crops to exactly this box */
                <div style={{
                  position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
                  width: `${DOC_GUIDE.widthFrac * 100}%`, aspectRatio: `${DOC_GUIDE.regionAspect} / 1`,
                  border: `3px dashed ${green ? "#10B981" : "rgba(255,255,255,0.85)"}`,
                  borderRadius: 12, pointerEvents: "none", boxSizing: "border-box", zIndex: 1,
                  boxShadow: "0 0 0 999px rgba(0,0,0,0.35)", transition: "border-color .15s"
                }} />
              )}
              {faceStep && (
                <canvas
                  ref={overlayRef}
                  width={frameW}
                  height={frameH}
                  style={{
                    position: "absolute", top: 0, left: 0, width: "100%", height: "100%",
                    transform: "scaleX(-1)", pointerEvents: "none", zIndex: 1
                  }}
                />
              )}
              {/* directional cue for head actions — visible from the moment
                  the instruction shows until the burst completes */}
              {isLiveness && performing && <ActionArrow action={livenessAction} />}
            </div>
          </div>

          {/* burst progress: CSS-animated so it never re-renders per frame */}
          {capturingBurst && (
            <div style={{ width: frameW, height: 6, background: "#E5E7EB", borderRadius: 3, margin: "12px auto 0", overflow: "hidden" }}>
              <div
                key={livePhase.startedAt}
                style={{
                  height: "100%", background: "#059669", borderRadius: 3, transformOrigin: "left",
                  animation: `vp-progress ${livePhase.total}ms linear forwards`
                }}
              />
              <style>{"@keyframes vp-progress { from { transform: scaleX(0) } to { transform: scaleX(1) } }"}</style>
            </div>
          )}

          <p aria-live="polite" role="status" style={{ textAlign: "center", fontSize: 14, margin: "12px 0 0", minHeight: 18, color: green ? "#059669" : "#6B7280" }}>
            {!cameraReady ? "Starting camera…"
              : capturingBurst ? "Got it — hold on…"
              : awaiting ? (livePhase.hint ? (COACH_COPY[livePhase.hint] && COACH_COPY[livePhase.hint](livenessAction)) || COACH_COPY.none(livenessAction) : "Do it now — we'll capture automatically")
              : busy ? "Uploading…"
              : isLiveness && detectorStatus === "loading" ? "Loading face detection…"
              : isLiveness && (detectorStatus !== "ready" || !(detectorRef.current && detectorRef.current.hasLandmarks)) ? "Automatic detection isn't available here — do the movement, then tap Capture manually"
              : isLiveness ? (green ? "Get ready…" : "Center your face to begin")
              : green ? "Hold still…"
              : faceStep ? "Align your face in the circle"
              : docFaceBlocked ? "That's a face — hold up your ID card instead"
              : docSeen && !docShapeOk ? "Fit your ID inside the box"
              : docSeen ? "Hold steady…"
              : "Fit your ID inside the box"}
          </p>

          {debugInfo && (
            <pre style={{ fontSize: 11, background: "#111827", color: "#A7F3D0", padding: 8, borderRadius: 6, margin: "8px 0 0", whiteSpace: "pre-wrap" }}>
              {`phase ${debugInfo.phase} action ${debugInfo.action || "-"} guide ${debugInfo.guide || "-"} ratio ${debugInfo.ratio != null ? debugInfo.ratio.toFixed(2) : "-"}
yaw ${debugInfo.yaw != null ? debugInfo.yaw.toFixed(2) : "-"} pitch ${debugInfo.pitch != null ? debugInfo.pitch.toFixed(2) : "-"}  Δyaw ${debugInfo.dYaw != null ? debugInfo.dYaw.toFixed(2) : "-"} Δpitch ${debugInfo.dPitch != null ? debugInfo.dPitch.toFixed(2) : "-"}
ok ${debugInfo.ok} holding ${debugInfo.holding} wrongWay ${debugInfo.wrongWay} frames ${debugInfo.frames}`}
            </pre>
          )}

          {feedback && (
            <p style={{ color: "#B45309", fontSize: 13, textAlign: "center", margin: "6px 0 0" }}>{feedback}</p>
          )}
          {error && (
            <p style={{ color: "#DC2626", fontSize: 13, textAlign: "center", margin: "6px 0 0" }}>
              {error.message}{" "}
              <button onClick={() => flowRef.current.retry()} style={{ textDecoration: "underline", background: "none", border: 0, color: "inherit", cursor: "pointer" }}>
                Retry
              </button>
            </p>
          )}

          {flashColor && (
            <div
              aria-hidden="true"
              style={{ position: "fixed", inset: 0, zIndex: 9999, background: `rgb(${flashColor[0]},${flashColor[1]},${flashColor[2]})`, display: "flex", alignItems: "flex-end", justifyContent: "center", pointerEvents: "none" }}
            >
              <div style={{ marginBottom: 32, padding: "6px 14px", borderRadius: 999, background: "rgba(0,0,0,0.55)", color: "#fff", fontSize: 14 }}>Hold still — checking lighting</div>
            </div>
          )}
          {cameraPaused && (
            <button
              onClick={() => { setCameraPaused(false); setCameraEpoch((e) => e + 1); }}
              style={{ width: "100%", marginTop: 14, padding: "10px 0", borderRadius: 8, background: primary, color: "#fff", border: 0, fontSize: 14, cursor: "pointer" }}
            >
              Camera paused — tap to resume
            </button>
          )}
          {isLiveness && canReissue && awaiting && (
            <button
              onClick={reissueChallenge}
              disabled={busy}
              style={{ width: "100%", marginTop: 14, padding: "10px 0", borderRadius: 8, background: "transparent", color: primary, border: `1px solid ${primary}`, fontSize: 14, cursor: busy ? "wait" : "pointer" }}
            >
              I can't do this movement — try a different one
            </button>
          )}
          {isLiveness && livePhase.hint === "budget" && (
            <button
              onClick={() => captureRef.current({ livenessAdvance: true, mode: "auto" })}
              disabled={busy}
              style={{ width: "100%", marginTop: 14, padding: "10px 0", borderRadius: 8, background: primary, color: "#fff", border: 0, fontSize: 14, cursor: busy ? "wait" : "pointer" }}
            >
              Continue to the next movement
            </button>
          )}

          {/* Manual capture on the LIVENESS step is a bypass of the action check
              (three taps = three frontal frames), so it is offered only when
              automatic detection is unavailable; frames it produces are marked
              captureMode:"manual" and never auto-approved server-side. */}
          {!(isLiveness && detectorStatus === "ready" && detectorRef.current && detectorRef.current.hasLandmarks) && (
            <button
              onClick={capture}
              disabled={busy || !cameraReady}
              style={{
                width: "100%", marginTop: 14, padding: "10px 0", borderRadius: 8,
                background: "transparent", color: primary, border: `1px solid ${primary}`, fontSize: 14,
                cursor: busy || !cameraReady ? "wait" : "pointer", opacity: busy || !cameraReady ? 0.5 : 1
              }}
            >
              Capture manually
            </button>
          )}

          {isDoc && attemptInfo.manualUpload && (
            <label style={{
              display: "block", width: "100%", marginTop: 10, padding: "10px 0", borderRadius: 8,
              background: primary, color: "#fff", fontSize: 14, textAlign: "center",
              cursor: busy ? "wait" : "pointer", opacity: busy ? 0.5 : 1, boxSizing: "border-box"
            }}>
              Upload a photo of your ID instead
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={onDocumentFile}
                disabled={busy}
                style={{ display: "none" }}
              />
            </label>
          )}
        </div>
      )}

      {step === "processing" && (
        <div style={{ textAlign: "center", padding: "32px 0", color: "#6B7280" }}>
          <div style={{
            width: 32, height: 32, margin: "0 auto 12px", borderRadius: "50%",
            border: `3px solid ${primary}`, borderTopColor: "transparent",
            animation: "vp-spin 0.8s linear infinite"
          }} />
          <style>{"@keyframes vp-spin { to { transform: rotate(360deg) } }"}</style>
          Checking liveness and matching your ID…
        </div>
      )}

      {step === "complete" && result && (
        <div style={{ textAlign: "center", padding: "24px 0" }}>
          <p style={{ fontSize: 40, margin: 0 }}>
            {result.status === "approved" ? "✅" : result.status === "manual_review" ? "⏳" : "❌"}
          </p>
          <p style={{ fontSize: 16, margin: "8px 0" }}>
            {result.status === "approved" && "Verification approved."}
            {result.status === "manual_review" && "Your verification is under review. You can wait to be notified — or try again now."}
            {["rejected", "failed", "expired"].includes(result.status) && "Verification was not successful."}
          </p>
          {["rejected", "failed", "manual_review"].includes(result.status) && result.decision?.reasonCodes?.length > 0 && (
            <div style={{ textAlign: "left", maxWidth: 320, margin: "12px auto 0", background: result.status === "manual_review" ? "#FFFBEB" : "#FEF2F2", border: `1px solid ${result.status === "manual_review" ? "#FDE68A" : "#FECACA"}`, borderRadius: 8, padding: "12px 16px" }}>
              <p style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 600, color: result.status === "manual_review" ? "#92400E" : "#991B1B" }}>
                {result.status === "manual_review" ? "What to improve if you try again:" : "Reasons:"}
              </p>
              {result.decision.reasonCodes.map((code) => (
                <div key={code} style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 4, fontSize: 13 }}>
                  <span style={{ color: "#DC2626", marginTop: 1 }}>•</span>
                  <span style={{ color: "#374151" }}>
                    {RESULT_REASON_LABELS[code] || code}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Try again — reopens the SAME session (attempts audit-logged
              server-side, cap enforced). After 3 camera attempts the document
              step also offers manual file upload. */}
          {["rejected", "manual_review", "failed"].includes(result.status) && !attemptInfo.exhausted && (
            <div style={{ marginTop: 16 }}>
              <button
                onClick={retryVerification}
                disabled={busy}
                style={{
                  padding: "10px 28px", borderRadius: 8, border: 0, fontSize: 14,
                  background: primary, color: "#fff",
                  cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1
                }}
              >
                {busy ? "Restarting…" : "Try again"}
              </button>
              <p style={{ fontSize: 12, color: "#9CA3AF", margin: "8px 0 0" }}>
                Attempt {attemptInfo.attempts} of 5
                {attemptInfo.attempts >= 3 ? " — you can also upload a photo of your ID on the next try" : ""}
              </p>
            </div>
          )}
          {attemptInfo.exhausted && ["rejected", "manual_review", "failed"].includes(result.status) && (
            <p style={{ fontSize: 13, color: "#6B7280", margin: "14px 0 0" }}>
              All attempts have been used. Please contact support to continue.
            </p>
          )}
          {feedback && (
            <p style={{ color: "#B45309", fontSize: 13, margin: "8px 0 0" }}>{feedback}</p>
          )}
        </div>
      )}
    </div>
  );
}
