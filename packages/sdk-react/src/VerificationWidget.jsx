import { useCallback, useEffect, useRef, useState } from "react";
import {
  VerifyPassClient, createFlow, assessFrame,
  startCamera, stopCamera, captureFrame,
  grabAnalysisFrame, grabSquareFrame, frameMotion, toGrayscale, meanBrightness, laplacianVariance
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

  const capture = useCallback(async () => {
    if (capturingRef.current) return;
    capturingRef.current = true;
    const flow = flowRef.current;
    const client = clientRef.current;
    const step = flow.state().step;
    setBusy(true);
    setFeedback(null);
    try {
      const { imageData, base64 } = captureFrame(videoRef.current);
      const quality = assessFrame(imageData);
      if (!quality.ok) {
        setFeedback(quality.issues.map((i) => ISSUE_COPY[i] || i).join(" "));
        return;
      }
      if (step === "document") {
        await client.uploadDocument(base64, "front");
        flow.advance();
      } else if (step === "liveness") {
        const action = actionsRef.current[actionIdxRef.current];
        await client.uploadLivenessFrame(action, base64);
        const next = actionIdxRef.current + 1;
        if (next >= actionsRef.current.length) {
          actionIdxRef.current = 0;
          setActionIdx(0);
          flow.advance(); // → face
        } else {
          actionIdxRef.current = next;
          setActionIdx(next);
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
    let lastGuide = null;
    const history = [];
    const HOLD_MS = 550;
    const LIVENESS_HOLD_MS = 1600;
    const SETTLE_DELTA = 3;
    const DETECT_MS = 140;

    const tick = () => {
      const video = videoRef.current;
      if (video && !capturingRef.current) {
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
        }

        // face model framing (throttled) for face/liveness
        if (faceModelUrl && detectorStatus === "failed" && lastGuide !== "model_error") {
          lastGuide = "model_error";
          setFramingGuide("model_error");
        } else if (requiresFaceModel && !faceGate && lastGuide !== "model_loading") {
          lastGuide = "model_loading";
          setFramingGuide("model_loading");
        }

        if (faceGate && !detecting && now - lastDetect > DETECT_MS) {
          lastDetect = now;
          detecting = true;
          // Analyse the SAME center-square the circular preview shows so the
          // green gate agrees with what the user sees.
          const modelFrame = grabSquareFrame(video, 320, 240);
          detectorRef.current
            .detect(modelFrame)
            .then((f) => {
              if (cancelled) return;
              let next = f || { present: false, inFrame: false, guide: "no_face" };
              if (next.inFrame) {
                const faceCrop = cropImageData(modelFrame, next.box);
                const focus = faceCrop ? laplacianVariance(faceCrop) : 0;
                next = { ...next, focus, inFrame: focus >= FACE_FOCUS_MIN, guide: focus >= FACE_FOCUS_MIN ? "ok" : "focus" };
              }
              framingRef.current = next;
              if (next.guide !== lastGuide) { lastGuide = next.guide; setFramingGuide(next.guide); }
            })
            .catch(() => {
              if (cancelled) return;
              framingRef.current = { present: false, inFrame: false, guide: "no_face" };
              if (lastGuide !== "no_face") { lastGuide = "no_face"; setFramingGuide("no_face"); }
            })
            .finally(() => { detecting = false; });
        }

        const inPosition = requiresFaceModel
          ? faceGate && !!(framingRef.current && framingRef.current.inFrame) && lightOk
          : settled && lightOk;
        setGreen(inPosition);

        if (inPosition) {
          const holdMs = step === "liveness" ? LIVENESS_HOLD_MS : HOLD_MS;
          if (!greenSince) greenSince = now;
          else if (now - greenSince > holdMs) { greenSince = 0; captureRef.current(); }
        } else {
          greenSince = 0;
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
          const fr = framingRef.current;
          if (fr && fr.box) {
            const b = fr.box;
            const x = (b.x1 / 320) * cw;
            const y = (b.y1 / 240) * ch;
            const w = ((b.x2 - b.x1) / 320) * cw;
            const h = ((b.y2 - b.y1) / 240) * ch;
            ctx.strokeStyle = fr.inFrame ? "#10B981" : "#F59E0B";
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
  const showGuide = faceStep && !green;
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

          <p style={{ textAlign: "center", fontSize: 14, margin: "12px 0 0", minHeight: 18, color: green ? "#059669" : "#6B7280" }}>
            {!cameraReady ? "Starting camera…"
              : busy ? "Uploading…"
              : green && isLiveness ? "Keep performing the action…"
              : green ? "Hold still…"
              : faceStep ? "Align your face in the circle"
              : "Hold steady"}
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
          <p style={{ fontSize: 16 }}>
            {result.status === "approved" && "Verification approved."}
            {result.status === "manual_review" && "Your verification is under review. You'll be notified shortly."}
            {["rejected", "failed", "expired"].includes(result.status) && "Verification was not successful."}
          </p>
        </div>
      )}
    </div>
  );
}
