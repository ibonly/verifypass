import { useVerifyPassConfig } from "./VerifyPassProvider";
import { useVerification } from "./useVerification";
import { isDocumentStep } from "./captureLoop";
import { fmt } from "./copy";
import { T, themeStyle } from "./theme";
import { ConsentGate } from "./components/ConsentGate";
import { CaptureView } from "./components/CaptureView";
import { ProcessingView } from "./components/Spinner";
import { MobileHandoffView } from "./components/MobileHandoffView";
import { OutcomeView } from "./components/OutcomeView";

/**
 * <VerificationWidget sessionId sdkToken onComplete onError theme copy />
 * (PRD §9.14). sessionId + sdkToken come from the integrator backend's
 * create-session call. Drop-in UI over useVerification(); theme via the
 * `theme` prop or --vp-* CSS custom properties, text via `copy`.
 */
export function VerificationWidget(props) {
  const { baseUrl, publicKey } = useVerifyPassConfig();
  const sessionKey = JSON.stringify([props.sessionId, props.sdkToken, props.baseUrl ?? baseUrl, props.publicKey ?? publicKey]);
  return (
    <div data-vp-widget className={props.className} style={themeStyle(props.theme)}>
      <style>{"@media (prefers-reduced-motion: reduce) { [data-vp-widget] * { animation: none !important; transition: none !important; } }"}</style>
      <VerificationWidgetSession key={sessionKey} {...props} />
    </div>
  );
}

function VerificationWidgetSession(props) {
  const v = useVerification(props);
  const { state: vp, copy, step } = v;
  const theme = props.theme || {};

  if (vp?.status === "error") {
    return <div role="alert"><p>{vp.initError}</p><button onClick={v.retryInit}>{copy.retryLoading}</button></div>;
  }
  if (!vp || !vp.flow) return <p role="status">{copy.loading}</p>;

  if (!vp.consented && !vp.handoff.enabled) {
    return (
      <ConsentGate
        copy={copy}
        logoUrl={theme.logoUrl}
        feedback={vp.feedback}
        busy={vp.busy}
        allowsHandoffChoice={vp.handoff.allowsChoice}
        onConsent={v.recordConsent}
        onShowQr={() => v.selectHandoff(true)}
      />
    );
  }

  const { steps, stepIndex, result } = vp.flow;
  const isLiveness = step === "liveness";
  const title = isLiveness && v.currentAction
    ? fmt(copy.capture.livenessTitle, vp.actionIndex + 1, vp.actions.length)
    : copy.steps[step].title;
  const isCaptureStep = isDocumentStep(step) || step === "face" || isLiveness;

  return (
    <div style={{ maxWidth: 420, margin: "0 auto", fontFamily: T.font }}>
      {theme.logoUrl && (
        <img src={theme.logoUrl} alt="" style={{ height: 32, marginBottom: 12 }} />
      )}

      {/* progress */}
      <div data-vp-part="progress" style={{ display: "flex", gap: 4, marginBottom: 16 }}>
        {steps.filter((s) => s !== "complete").map((s, i) => (
          <div key={s} style={{
            flex: 1, height: 4, borderRadius: 2,
            background: i <= stepIndex ? T.primary : T.border
          }} />
        ))}
      </div>

      <h2 style={{ margin: "0 0 12px", fontSize: 20 }}>{title}</h2>

      {isCaptureStep && <CaptureView v={v} />}
      {step === "processing" && <ProcessingView copy={copy} />}
      {step === "mobile" && <MobileHandoffView v={v} />}
      {step === "complete" && result && <OutcomeView v={v} />}
    </div>
  );
}
