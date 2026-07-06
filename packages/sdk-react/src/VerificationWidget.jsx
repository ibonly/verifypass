import { useCallback, useEffect, useRef, useState } from "react";
import {
  VerifyPassClient, createFlow, assessFrame,
  startCamera, stopCamera, captureFrame, captureGuideFrame,
  grabAnalysisFrame, grabSquareFrame, grabFixedFrame, frameMotion, toGrayscale, meanBrightness, laplacianVariance,
  createFramingStabilizer, createActionDetector, bandMotion, createDocumentGate, isDominantFace
} from "@verifypass/sdk-core";
import { useVerifyPass } from "./VerifyPassProvider";
import { createFaceDetector } from "./faceDetector";

const STEP_COPY = {
  document: {
    title: "Scan your ID",
    hint: "Place your ID inside the frame. Avoid glare and shadows.",
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

// Prompts for each server-issued challenge action.
const ACTION_COPY = {
  blink: "Blink your eyes",
  turn_left: "Slowly turn your head to the LEFT",
  turn_right: "Slowly turn your head to the RIGHT",
  look_up: "Tilt your head UP",
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


const DEFAULT_CONSENT_COPY = "I consent to VerifyPass capturing and processing my ID images, selfie, and biometric data for identity verification.";
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
export function VerificationWidget({
  sessionId,
  sdkToken,
  theme = {},
  consentCopy = DEFAULT_CONSENT_COPY,
  onComplete,
  onError,
  onStepChange
}) {
  const { publicKey, baseUrl, faceModelUrl } = useVerifyPass();
  const videoRef = useRef(null);
  const flowRef = useRef(null);
  const clientRef = useRef(null);
  const actionsRef = useRef([]);
  const actionIdxRef = useRef(0);
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
  // Liveness capture phases: "align" (frontal lock) → "perform" (burst capture
  // while the user does the action). Set once per transition — never per frame.
  const [livePhase, setLivePhase] = useState({ phase: "align", startedAt: 0, total: 0 });
  // Document step: has the ID actually entered the frame? (drives the hint)
  const [docSeen, setDocSeen] = useState(false);
  // Document step: does the change-region look like a CARD? (straight edges)
  const [docShapeOk, setDocShapeOk] = useState(false);
  // Document step: a LIVE face is filling the frame instead of a card
  const [docFaceBlocked, setDocFaceBlocked] = useState(false);

  // init: create client, fetch the server-issued challenge, build the flow
  useEffect(() => {
    let cancelled = false;
    const client = new VerifyPassClient({ baseUrl, publicKey, sessionId, sdkToken });
    clientRef.current = client;
    let off = () => {};
    (async () => {
      let verificationType = "ID_AND_FACE";
      let challengeActions = [];
      try {
        const c = await client.getChallenge();
        verificationType = c.verificationType || "ID_AND_FACE";
        challengeActions = Array.isArray(c.livenessActions) ? c.livenessActions : [];
      } catch (err) {
        if (onErrorRef.current) onErrorRef.current(err);
      }
      if (cancelled) return;
      actionsRef.current = challengeActions;
      setActions(challengeActions);
      const flow = createFlow(verificationType);
      flowRef.current = flow;
      setFlowState(flow.state());
      off = flow.onChange((s) => {
        setFlowState(s);
        if (onStepChangeRef.current) onStepChangeRef.current(s.step);
      });
    })();
    return () => { cancelled = true; off(); };
  }, [baseUrl, publicKey, sessionId, sdkToken]);

  // camera lifecycle keyed on facingMode (not step) so same-camera transitions
  // like liveness → face keep the existing stream instead of restarting it.
  // Also keyed on `consented` because the <video> element only mounts after the
  // consent gate is dismissed.
  const captureFacing = (() => {
    const step = flowState?.step;
    return (step === "document" || step === "face" || step === "liveness")
      ? STEP_COPY[step].facingMode
      : null;
  })();
  useEffect(() => {
    if (!consented || !captureFacing) return undefined;
    const video = videoRef.current;
    if (!video) return undefined;
    let cancelled = false;
    setCameraReady(false);
    startCamera(video, { facingMode: captureFacing })
      .then((stream) => {
        // If this effect was torn down before getUserMedia resolved, stop the
        // freshly acquired stream so the camera doesn't stay on (leak) and don't
        // flip readiness for a step that no longer applies.
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        setCameraReady(true);
      })
      .catch((err) => {
        if (cancelled) return;
        flowRef.current.fail({ code: "CAMERA_ERROR", message: err.message });
        if (onErrorRef.current) onErrorRef.current(err);
      });
    return () => { cancelled = true; stopCamera(video); setCameraReady(false); };
  }, [captureFacing, consented]);

  // if there are no challenge actions, don't linger on the liveness step
  useEffect(() => {
    if (flowState?.step === "liveness" && actionsRef.current.length === 0) {
      flowRef.current.advance();
    }
  }, [flowState?.step]);

  const capture = useCallback(async (opts = {}) => {
    // Called with an Event from the manual button, or {livenessAdvance} from
    // the burst loop — Event has no livenessAdvance, so manual defaults to true.
    const livenessAdvance = opts.livenessAdvance !== false;
    if (capturingRef.current) return;
    capturingRef.current = true;
    const flow = flowRef.current;
    const client = clientRef.current;
    const step = flow.state().step;
    setBusy(true);
    setFeedback(null);
    try {
      // Documents are cropped to the on-screen card guide so the ID FILLS the
      // evidence photo (matches what the user aligned to; better OCR/review).
      const { imageData, base64 } = step === "document"
        ? captureGuideFrame(videoRef.current, DOC_GUIDE)
        : captureFrame(videoRef.current);
      // During liveness actions the head is MOVING — motion blur is expected
      // and desired evidence. Gating those frames on sharpness silently dropped
      // them (→ LIVENESS_CHALLENGE_INCOMPLETE). Server verifies authoritatively.
      const quality = assessFrame(imageData, step === "liveness" ? { minSharpness: 0 } : undefined);
      if (!quality.ok) {
        setFeedback(quality.issues.map((i) => ISSUE_COPY[i] || i).join(" "));
        return;
      }
      if (step === "document") {
        await client.uploadDocument(base64, "front");
        flow.advance();
        // ID_ONLY has no face step — the document is the last capture, so THIS
        // branch must submit, or the session sits in "started" forever.
        if (flow.state().step === "processing") {
          await client.submit();
          const result = await client.waitForResult();
          flow.finish(result);
          if (onCompleteRef.current) onCompleteRef.current(result);
        }
      } else if (step === "liveness") {
        const action = actionsRef.current[actionIdxRef.current];
        await client.uploadLivenessFrame(action, base64);
        // Burst mode uploads several frames per action; only the last one
        // advances. More frames per action = far better odds the server finds
        // one live, single-face, pose-matching frame.
        if (livenessAdvance) {
          const next = actionIdxRef.current + 1;
          if (next >= actionsRef.current.length) {
            actionIdxRef.current = 0;
            setActionIdx(0);
            flow.advance(); // → face
          } else {
            actionIdxRef.current = next;
            setActionIdx(next);
          }
        }
      } else if (step === "face") {
        await client.uploadFace(base64);
        flow.advance(); // → processing
        await client.submit();
        const result = await client.waitForResult();
        flow.finish(result);
        if (onCompleteRef.current) onCompleteRef.current(result);
      }
    } catch (err) {
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
    detectorRef.current = null;
    setDetectorStatus("loading");
    const timeout = new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error("Face model load timed out")), 12000);
    });
    Promise.race([createFaceDetector(faceModelUrl), timeout])
      .then((d) => {
        if (disposed) { d.dispose && d.dispose(); return; }
        det = d;
        detectorRef.current = d;
        setDetectorStatus("ready");
      })
      .catch(() => {
        if (disposed) return;
        detectorRef.current = null;
        setDetectorStatus("failed");
      });
    return () => { disposed = true; detectorRef.current = null; if (det && det.dispose) det.dispose(); };
  }, [faceModelUrl]);

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
    if (!(step === "document" || step === "face" || step === "liveness")) return undefined;

    setGreen(false);
    framingRef.current = null;
    setLivePhase({ phase: "align", startedAt: 0, total: 0 });
    setFramingGuide(step === "face" || step === "liveness"
      ? detectorStatus === "failed" ? "model_error" : "model_loading"
      : "no_face");
    const DEBUG = /[?&]vpdebug\b/.test(typeof window !== "undefined" ? window.location.search : "");
    let raf = 0;
    let cancelled = false;
    let prevGray = null;
    let greenSince = 0;
    let lastDetect = 0;
    let detecting = false;
    let publishedGuide = null;
    const history = [];
    const stab = createFramingStabilizer(); // temporal smoothing: no flicker, no hold-timer resets on jitter
    let stable = null;
    // Document step gate: "change-then-steady" — learns the EMPTY scene first,
    // then requires the ID to actually enter the frame (sustained scene change)
    // and be held still. A bare steadiness check photographed empty rooms.
    const docGate = step === "document" ? createDocumentGate() : null;
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
    const DETECT_MS = 140;
    // Liveness three-phase capture:
    //   align     — lock a frontal face (baseline box recorded)
    //   await     — instruction shown; WAIT until the face-box dynamics (or a
    //               motion spike, for blink/smile) show the action is actually
    //               being performed. No timer-based capture: nothing uploads
    //               until the user moves.
    //   capturing — short burst (3 frames over ~700ms) at the action's peak.
    const ALIGN_LOCK_MS = 500;
    // Burst timing: FIRST frame fires AT the trigger, while the turning face
    // is still detectable by the server's frontal-biased detector — every
    // action needs at least one face-bearing frame or it's INCOMPLETE. Later
    // frames catch the pose peak for the (calibration/pose) evidence.
    const BURST_AT = [0, 450, 900]; // offsets from the trigger moment
    const BURST_TOTAL = 1100;       // progress bar duration
    const AWAIT_HINT_MS = 5000;     // no movement detected → coach the user
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
    let lastPresentAt = performance.now();
    // Action-SPECIFIC detector (geometry signature for turns/tilts, eye/mouth
    // band motion for blink/smile) — created when align completes.
    let actionDet = null;
    let actionState = { ok: false, triggered: false, holding: false };
    let prevModelGray = null;
    // One frame captured at the FIRST action-consistent detection while the
    // face is still visible — the disappearance-clause trigger often fires
    // after the face has already turned out of detection range, and the
    // server requires at least one face-bearing frame per action.
    let earlyShotTaken = false;

    const tick = () => {
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
        const docDetect = step === "document" && !!faceModelUrl && detectorStatus === "ready" && !!detectorRef.current;

        if ((faceGate || docDetect) && !detecting && now - lastDetect > DETECT_MS && !capturingRef.current) {
          lastDetect = now;
          detecting = true;
          // Face steps analyse the SAME center-square the circular preview
          // shows so the green gate agrees with what the user sees. The
          // document step must scan the FULL frame — a face outside the
          // center square (leaning in from the side) still has to block.
          const modelFrame = docDetect ? grabFixedFrame(video, 320, 240) : grabSquareFrame(video, 320, 240);
          detectorRef.current
            .detect(modelFrame)
            .then((f) => {
              if (cancelled) return;
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
                next = { ...next, focus, inFrame: focus >= FACE_FOCUS_MIN, guide: focus >= FACE_FOCUS_MIN ? "ok" : "focus" };
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
                actionState = actionDet.update({ box: next.box, eyes: bands.eyes, mouth: bands.mouth });
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

        if (step === "liveness" && faceGate) {
          const rawBox = framingRef.current && framingRef.current.box;
          const facePresent = !!(stable && stable.present);
          if (facePresent) lastPresentAt = now;

          if (phase === "align") {
            setGreen(lockedOk);
            if (lockedOk && stable.lockedSince && now - stable.lockedSince >= ALIGN_LOCK_MS) {
              phase = "await";
              baselineBox = (stable && stable.box) || rawBox || null;
              actionDet = createActionDetector(currentAction, baselineBox);
              actionState = { ok: false, triggered: false, holding: false };
              earlyShotTaken = false;
              awaitStart = now;
              hintShown = false;
              setLivePhase({ phase: "await", startedAt: now, total: 0, hint: false });
            }
          } else if (phase === "await") {
            // Instruction shown — capture NOTHING until THIS action's own
            // signature is seen (2 consecutive detections; jitter can't fire it).
            setGreen(true);
            if (actionState.ok && rawBox && !earlyShotTaken && !capturingRef.current) {
              // movement just started and the face is STILL detectable —
              // grab the guaranteed face-bearing frame for this action now
              earlyShotTaken = true;
              captureRef.current({ livenessAdvance: false });
            }
            if (facePresent && actionState.triggered) {
              phase = "capturing";
              triggerAt = now;
              shots = 0;
              setLivePhase({ phase: "capturing", startedAt: now, total: BURST_TOTAL });
            } else if (!hintShown && now - awaitStart > AWAIT_HINT_MS) {
              hintShown = true; // still waiting — coach, don't capture
              setLivePhase({ phase: "await", startedAt: awaitStart, total: 0, hint: true });
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
            const holdRequired = currentAction !== "blink" && currentAction !== "smile";
            const canShoot = !holdRequired || actionState.holding;
            if (shots < BURST_AT.length && now - triggerAt >= BURST_AT[shots] && !capturingRef.current && facePresent && canShoot) {
              const isLast = shots === BURST_AT.length - 1;
              shots++;
              captureRef.current({ livenessAdvance: isLast });
            } else if (!capturingRef.current && now - triggerAt > BURST_TOTAL + 2500) {
              // Burst stalled (pose released mid-burst, or an upload was
              // rejected by the quality gate) — return to await with a FRESH
              // detector so the user redoes the movement; a stale latched
              // trigger would re-fire instantly.
              phase = "await";
              actionDet = createActionDetector(currentAction, baselineBox);
              actionState = { ok: false, triggered: false, holding: false };
              awaitStart = now;
              hintShown = true;
              setLivePhase({ phase: "await", startedAt: now, total: 0, hint: true });
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
          const inPosition = requiresFaceModel
            ? lockedOk
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
          // draw the SMOOTHED box (EMA) so the overlay glides instead of twitching
          const b = (stable && stable.box) || (framingRef.current && framingRef.current.box);
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
  }, [cameraReady, flowState?.step, actionIdx, faceModelUrl, detectorStatus]);

  if (!flowState) return null;
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
  const isDoc = step === "document";
  const isCaptureStep = step === "document" || step === "face" || step === "liveness";
  const frameW = isDoc ? 340 : 280;
  const frameH = isDoc ? 212 : 280;
  const pillText = isLiveness ? (ACTION_COPY[livenessAction] || livenessAction)
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
        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", color: "#374151", fontSize: 14, lineHeight: 1.45 }}>
          <input type="checkbox" checked={consentChecked} onChange={(e) => setConsentChecked(e.target.checked)} style={{ marginTop: 3 }} />
          <span>{consentCopy}</span>
        </label>
        <button
          type="button"
          onClick={() => setConsented(true)}
          disabled={!consentChecked}
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
            <div style={{
              position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)", zIndex: 2,
              background: "#111827", color: "#fff", padding: "6px 14px", borderRadius: 999,
              fontSize: 14, whiteSpace: "nowrap", boxShadow: "0 2px 10px rgba(0,0,0,0.25)"
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

          <p style={{ textAlign: "center", fontSize: 14, margin: "12px 0 0", minHeight: 18, color: green ? "#059669" : "#6B7280" }}>
            {!cameraReady ? "Starting camera…"
              : capturingBurst ? "Got it — hold on…"
              : awaiting ? (livePhase.hint ? "We haven't seen it yet — make the movement bigger and slower" : "Do it now — we'll capture automatically")
              : busy ? "Uploading…"
              : isLiveness ? (green ? "Get ready…" : "Center your face to begin")
              : green ? "Hold still…"
              : faceStep ? "Align your face in the circle"
              : docFaceBlocked ? "That's a face — hold up your ID card instead"
              : docSeen && !docShapeOk ? "Fit your ID inside the box"
              : docSeen ? "Hold steady…"
              : "Fit your ID inside the box"}
          </p>

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
            {result.status === "manual_review" && "Your verification is under review. You'll be notified shortly."}
            {["rejected", "failed", "expired"].includes(result.status) && "Verification was not successful."}
          </p>
          {["rejected", "failed"].includes(result.status) && result.decision?.reasonCodes?.length > 0 && (
            <div style={{ textAlign: "left", maxWidth: 320, margin: "12px auto 0", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "12px 16px" }}>
              <p style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 600, color: "#991B1B" }}>Reasons:</p>
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
        </div>
      )}
    </div>
  );
}
