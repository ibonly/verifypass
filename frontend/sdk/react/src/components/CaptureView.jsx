import { T } from "../theme";
import { fmt } from "../copy";
import { DOC_GUIDE } from "../useVerification";
import { isDocumentStep } from "../captureLoop";
import { ActionArrow } from "./ActionArrow";

/** Camera preview + guidance for document, liveness and selfie steps. */
export function CaptureView({ v }) {
  const { state: vp, copy, step, livePhase, green } = v;
  const busy = vp.busy;
  const k = copy.capture;
  const isLiveness = step === "liveness";
  const isDoc = isDocumentStep(step);
  const faceStep = step === "face" || isLiveness;
  const livenessAction = isLiveness ? v.currentAction : null;
  const frameW = isDoc ? 340 : 280;
  const frameH = isDoc ? 212 : 280;
  const pillText = isLiveness ? (copy.pills[livenessAction] || copy.actions[livenessAction] || livenessAction)
    : isDoc ? k.pillDocument
    : k.pillFace;
  const awaiting = isLiveness && livePhase.phase === "await";
  const capturingBurst = isLiveness && livePhase.phase === "capturing";
  const performing = awaiting || capturingBurst;
  // While awaiting/capturing the pill shows ONLY the action — framing guides
  // are irrelevant mid-movement, and swapping them caused flicker.
  const showGuide = faceStep && !green && !performing;
  const pillDisplay = showGuide ? (copy.guide[v.framingGuide] || k.positionFace) : pillText;
  const ringColor = green ? T.success : T.border;
  const autoDetection = v.detectorStatus === "ready" && v.hasLandmarks;
  const error = vp.flow.error;
  const coach = livePhase.hint ? copy.coach[livePhase.hint] : null;

  return (
    <div data-vp-part="capture">
      <div style={{ position: "relative", width: frameW, margin: "0 auto" }}>
        {/* action prompt pill */}
        <div aria-live="assertive" role="status" style={{
          position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)", zIndex: 2,
          background: T.pill, color: "#fff", padding: "6px 14px", borderRadius: 999,
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
            ref={v.videoRef}
            playsInline
            muted
            style={{ width: "100%", height: "100%", objectFit: "cover", transform: isDoc ? "none" : "scaleX(-1)" }}
          />
          {isDoc && (
            /* card-aspect guide — capture crops to exactly this box */
            <div style={{
              position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
              width: `${DOC_GUIDE.widthFrac * 100}%`, aspectRatio: `${DOC_GUIDE.regionAspect} / 1`,
              border: `3px dashed ${green ? T.successBright : "rgba(255,255,255,0.85)"}`,
              borderRadius: 12, pointerEvents: "none", boxSizing: "border-box", zIndex: 1,
              boxShadow: "0 0 0 999px rgba(0,0,0,0.35)", transition: "border-color .15s"
            }} />
          )}
          {faceStep && (
            <canvas
              ref={v.overlayRef}
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
          {isLiveness && performing && <ActionArrow action={livenessAction} copy={copy} />}
        </div>
      </div>

      {/* burst progress: CSS-animated so it never re-renders per frame */}
      {capturingBurst && (
        <div style={{ width: frameW, height: 6, background: T.border, borderRadius: 3, margin: "12px auto 0", overflow: "hidden" }}>
          <div
            key={livePhase.startedAt}
            style={{
              height: "100%", background: T.success, borderRadius: 3, transformOrigin: "left",
              animation: `vp-progress ${livePhase.total}ms linear forwards`
            }}
          />
          <style>{"@keyframes vp-progress { from { transform: scaleX(0) } to { transform: scaleX(1) } }"}</style>
        </div>
      )}

      <p aria-live="polite" role="status" style={{ textAlign: "center", fontSize: 14, margin: "12px 0 0", minHeight: 18, color: green ? T.success : T.muted }}>
        {!v.cameraReady ? k.startingCamera
          : capturingBurst ? k.gotIt
          : awaiting ? (livePhase.hint ? (coach ? fmt(coach, livenessAction) : fmt(copy.coach.none, livenessAction)) : k.doItNow)
          : busy ? k.uploading
          : isLiveness && v.detectorStatus === "loading" ? k.loadingDetection
          : isLiveness && !autoDetection ? k.noAutoDetection
          : isLiveness ? (green ? k.getReady : k.centerToBegin)
          : green ? k.holdStill
          : faceStep ? k.alignFace
          : v.docFaceBlocked ? k.documentIsFace
          : v.docSeen && !v.docShapeOk ? k.documentFit
          : v.docSeen ? k.documentHold
          : k.documentFit}
      </p>

      {v.debugInfo && (
        <pre style={{ fontSize: 11, background: "#111827", color: "#A7F3D0", padding: 8, borderRadius: 6, margin: "8px 0 0", whiteSpace: "pre-wrap" }}>
          {`phase ${v.debugInfo.phase} action ${v.debugInfo.action || "-"} guide ${v.debugInfo.guide || "-"} ratio ${v.debugInfo.ratio != null ? v.debugInfo.ratio.toFixed(2) : "-"}
yaw ${v.debugInfo.yaw != null ? v.debugInfo.yaw.toFixed(2) : "-"} pitch ${v.debugInfo.pitch != null ? v.debugInfo.pitch.toFixed(2) : "-"}  Δyaw ${v.debugInfo.dYaw != null ? v.debugInfo.dYaw.toFixed(2) : "-"} Δpitch ${v.debugInfo.dPitch != null ? v.debugInfo.dPitch.toFixed(2) : "-"}
ok ${v.debugInfo.ok} holding ${v.debugInfo.holding} wrongWay ${v.debugInfo.wrongWay} frames ${v.debugInfo.frames}`}
        </pre>
      )}

      {vp.feedback && (
        <p style={{ color: T.warning, fontSize: 13, textAlign: "center", margin: "6px 0 0" }}>{vp.feedback}</p>
      )}
      {error && (
        <p style={{ color: T.danger, fontSize: 13, textAlign: "center", margin: "6px 0 0" }}>
          {error.message}{" "}
          <button onClick={v.retryStep} style={{ textDecoration: "underline", background: "none", border: 0, color: "inherit", cursor: "pointer" }}>
            {k.retry}
          </button>
        </p>
      )}

      {v.flashColor && (
        <div
          aria-hidden="true"
          style={{ position: "fixed", inset: 0, zIndex: 9999, background: `rgb(${v.flashColor[0]},${v.flashColor[1]},${v.flashColor[2]})`, display: "flex", alignItems: "flex-end", justifyContent: "center", pointerEvents: "none" }}
        >
          <div style={{ marginBottom: 32, padding: "6px 14px", borderRadius: 999, background: "rgba(0,0,0,0.55)", color: "#fff", fontSize: 14 }}>{k.flashHold}</div>
        </div>
      )}
      {v.cameraPaused && (
        <button
          onClick={v.resumeCamera}
          style={{ width: "100%", marginTop: 14, padding: "10px 0", borderRadius: T.radius, background: T.primary, color: T.onPrimary, border: 0, fontSize: 14, cursor: "pointer" }}
        >
          {k.cameraPaused}
        </button>
      )}
      {isLiveness && v.canReissue && awaiting && (
        <button
          onClick={v.reissue}
          disabled={busy}
          style={{ width: "100%", marginTop: 14, padding: "10px 0", borderRadius: T.radius, background: "transparent", color: T.primary, border: `1px solid ${T.primary}`, fontSize: 14, cursor: busy ? "wait" : "pointer" }}
        >
          {k.reissue}
        </button>
      )}
      {isLiveness && livePhase.hint === "budget" && (
        <button
          onClick={() => v.capture({ livenessAdvance: true, mode: "auto" })}
          disabled={busy}
          style={{ width: "100%", marginTop: 14, padding: "10px 0", borderRadius: T.radius, background: T.primary, color: T.onPrimary, border: 0, fontSize: 14, cursor: busy ? "wait" : "pointer" }}
        >
          {k.continueNext}
        </button>
      )}

      {/* Manual capture on the LIVENESS step is a bypass of the action check
          (three taps = three frontal frames), so it is offered only when
          automatic detection is unavailable; frames it produces are marked
          captureMode:"manual" and never auto-approved server-side. */}
      {!(isLiveness && autoDetection) && (
        <button
          onClick={v.capture}
          disabled={busy || !v.cameraReady}
          style={{
            width: "100%", marginTop: 14, padding: "10px 0", borderRadius: T.radius,
            background: "transparent", color: T.primary, border: `1px solid ${T.primary}`, fontSize: 14,
            cursor: busy || !v.cameraReady ? "wait" : "pointer", opacity: busy || !v.cameraReady ? 0.5 : 1
          }}
        >
          {k.captureManually}
        </button>
      )}

      {isDoc && vp.attempts.manualUpload && (
        <label style={{
          display: "block", width: "100%", marginTop: 10, padding: "10px 0", borderRadius: T.radius,
          background: T.primary, color: T.onPrimary, fontSize: 14, textAlign: "center",
          cursor: busy ? "wait" : "pointer", opacity: busy ? 0.5 : 1, boxSizing: "border-box"
        }}>
          {k.uploadDocument}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => {
              const file = e.target.files && e.target.files[0];
              e.target.value = ""; // allow picking the same file again
              v.uploadDocumentFile(file);
            }}
            disabled={busy}
            style={{ display: "none" }}
          />
        </label>
      )}
    </div>
  );
}
