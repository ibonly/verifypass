import { T } from "../theme";
import { fmt } from "../copy";
import { Spinner } from "./Spinner";

const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Desktop side of the mobile handoff: QR + secure link while the phone runs
 * the hosted page (its own consent and capture). Never acquires a camera.
 */
export function MobileHandoffView({ v }) {
  const { state: vp, copy, qrDataUrl } = v;
  const k = copy.mobile;
  const h = vp.handoff;
  const error = vp.flow.error;
  const outlineButton = { padding: "8px 12px", borderRadius: T.radius, border: `1px solid ${T.primary}`, background: T.surface, color: T.primary, cursor: "pointer" };
  const mobileError = v.qrError === "encode" ? k.qrEncodeFailed : v.qrError === "load" ? k.qrLoadFailed : h.error;
  return (
    <div data-vp-part="mobile" style={{ textAlign: "center", padding: "8px 0" }}>
      <p style={{ margin: "0 0 16px", fontSize: 15, color: T.text }}>{k.intro}</p>
      {h.url && (
        <div style={{ display: "inline-flex", padding: 16, background: "#fff", borderRadius: 12, boxShadow: "0 2px 12px rgba(0,0,0,0.15)" }}>
          {qrDataUrl ? (
            <img src={qrDataUrl} alt={k.qrAlt} width={256} height={256} />
          ) : (
            <div style={{ width: 256, height: 256, display: "flex", alignItems: "center", justifyContent: "center", color: T.muted, fontSize: 14 }}>
              {k.generating}
            </div>
          )}
        </div>
      )}
      {mobileError && (
        <p role="alert" style={{ color: T.danger, fontSize: 13, margin: "12px 0 0" }}>{mobileError}</p>
      )}
      {h.url && (
        <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", marginTop: 12 }}>
          {!qrDataUrl && mobileError && (
            <button type="button" onClick={v.retryQr} style={outlineButton}>{k.retryQr}</button>
          )}
          <button type="button" onClick={v.copyHandoffLink} style={outlineButton}>{k.copyLink}</button>
          <a href={h.url} target="_blank" rel="noopener noreferrer" style={{ ...outlineButton, background: undefined, textDecoration: "none" }}>
            {k.openHere}
          </a>
        </div>
      )}
      {h.linkStatus && (
        <p role="status" style={{ margin: "8px 0 0", fontSize: 12, color: T.muted }}>
          {h.linkStatus === "copied" ? k.linkCopied : k.copyFailed}
        </p>
      )}
      {h.url && (
        <p style={{ margin: "10px 0 0", fontSize: 12, color: T.muted }}>
          {k.privacy}
          {h.handoffExpiresAt ? fmt(k.codeExpires, time(h.handoffExpiresAt)) : ""}
          {h.expiresAt ? fmt(k.sessionExpires, time(h.expiresAt)) : ""}
        </p>
      )}
      {error && (
        <p role="alert" style={{ color: T.danger, fontSize: 13, margin: "12px 0 0", textAlign: "center" }}>
          {error.message}{" "}
          <button onClick={v.retryHandoff} style={{ textDecoration: "underline", background: "none", border: 0, color: "inherit", cursor: "pointer" }}>
            {copy.capture.retry}
          </button>
        </p>
      )}
      <p aria-live="polite" role="status" style={{ margin: "16px 0 0", fontSize: 14, color: T.muted }}>
        {h.phase === "verifying" ? k.verifying : h.phase === "finalising" ? k.finalising : k.waiting}
      </p>
      {h.polling && <Spinner margin="12px auto 0" />}
      {h.allowsChoice && (
        <button
          type="button"
          onClick={() => v.selectHandoff(false)}
          style={{ display: "block", margin: "16px auto 0", background: "none", border: 0, color: T.primary, fontSize: 13, textDecoration: "underline", cursor: "pointer" }}
        >
          {k.useThisDevice}
        </button>
      )}
    </div>
  );
}
