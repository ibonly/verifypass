import { useState } from "react";
import { T } from "../theme";
import { CONSENT_COPY_VERSION } from "../copy";

/** Biometric consent, recorded server-side with the copy version. */
export function ConsentGate({ copy, logoUrl, feedback, busy, allowsHandoffChoice, onConsent, onShowQr }) {
  const [checked, setChecked] = useState(false);
  const k = copy.consent;
  return (
    <div data-vp-part="consent" style={{ maxWidth: 420, margin: "0 auto", fontFamily: T.font }}>
      {logoUrl && (
        <img src={logoUrl} alt="" style={{ height: 32, marginBottom: 12 }} />
      )}
      <h2 style={{ margin: "0 0 8px", fontSize: 20 }}>{k.title}</h2>
      {feedback && <p role="alert">{feedback}</p>}
      <label style={{ display: "flex", gap: 10, alignItems: "flex-start", color: T.text, fontSize: 14, lineHeight: 1.45 }}>
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} style={{ marginTop: 3, accentColor: T.primary }} />
        <span>{k.statement}</span>
      </label>
      <button
        type="button"
        onClick={() => onConsent(CONSENT_COPY_VERSION)}
        disabled={!checked || busy}
        style={{
          width: "100%", marginTop: 16, padding: "12px 0", borderRadius: T.radius,
          background: T.primary, color: T.onPrimary, border: 0, fontSize: 16,
          cursor: checked ? "pointer" : "not-allowed", opacity: checked ? 1 : 0.45
        }}
      >
        {k.continue}
      </button>
      {/* Phone handoff is offered here, before consent, because the phone
          records its OWN consent on the hosted page — ticking the box on
          this device first would capture a consent nobody acts on. */}
      {allowsHandoffChoice && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0 12px", color: T.subtle, fontSize: 12 }}>
            <span style={{ flex: 1, height: 1, background: T.border }} />
            {k.or}
            <span style={{ flex: 1, height: 1, background: T.border }} />
          </div>
          <button
            type="button"
            onClick={onShowQr}
            style={{
              width: "100%", padding: "12px 0", borderRadius: T.radius,
              background: T.surface, color: T.primary, border: `2px solid ${T.primary}`,
              fontSize: 16, fontWeight: 600, cursor: "pointer"
            }}
          >
            {k.showQr}
          </button>
          <p style={{ margin: "8px 0 0", fontSize: 13, color: T.muted, textAlign: "center", lineHeight: 1.4 }}>
            {k.qrHint}
          </p>
        </>
      )}
    </div>
  );
}
