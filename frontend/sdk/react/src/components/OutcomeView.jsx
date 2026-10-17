import { T } from "../theme";
import { fmt } from "../copy";

const RETRYABLE = ["rejected", "manual_review", "failed"];
const MAX_ATTEMPTS = 5;

/** Terminal result, user-actionable reasons and the server-capped retry. */
export function OutcomeView({ v }) {
  const { state: vp, copy } = v;
  const k = copy.outcome;
  const { result } = vp.flow;
  const { attempts, busy, feedback } = vp;
  const review = result.status === "manual_review";
  const reasonCodes = result.decision?.reasonCodes || [];
  return (
    <div data-vp-part="outcome" style={{ textAlign: "center", padding: "24px 0" }}>
      <p style={{ fontSize: 40, margin: 0 }}>
        {result.status === "approved" ? "✅" : review ? "⏳" : "❌"}
      </p>
      <p style={{ fontSize: 16, margin: "8px 0" }}>
        {result.status === "approved" && k.approved}
        {review && k.manual_review}
        {["rejected", "failed", "expired"].includes(result.status) && k.unsuccessful}
      </p>
      {["rejected", "failed", "manual_review"].includes(result.status) && reasonCodes.length > 0 && (
        <div style={{ textAlign: "left", maxWidth: 320, margin: "12px auto 0", background: review ? "#FFFBEB" : "#FEF2F2", border: `1px solid ${review ? "#FDE68A" : "#FECACA"}`, borderRadius: 8, padding: "12px 16px" }}>
          <p style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 600, color: review ? "#92400E" : "#991B1B" }}>
            {review ? k.improve : k.reasons}
          </p>
          {reasonCodes.map((code) => (
            <div key={code} style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 4, fontSize: 13 }}>
              <span style={{ color: T.danger, marginTop: 1 }}>•</span>
              <span style={{ color: "#374151" }}>{copy.reasons[code] || code}</span>
            </div>
          ))}
        </div>
      )}

      {/* Try again — reopens the SAME session (attempts audit-logged
          server-side, cap enforced). After 3 camera attempts the document
          step also offers manual file upload. */}
      {RETRYABLE.includes(result.status) && !attempts.exhausted && (
        <div style={{ marginTop: 16 }}>
          <button
            onClick={v.retry}
            disabled={busy}
            style={{
              padding: "10px 28px", borderRadius: T.radius, border: 0, fontSize: 14,
              background: T.primary, color: T.onPrimary,
              cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1
            }}
          >
            {busy ? k.restarting : k.tryAgain}
          </button>
          <p style={{ fontSize: 12, color: T.subtle, margin: "8px 0 0" }}>
            {fmt(k.attempt, attempts.attempts, MAX_ATTEMPTS)}
            {attempts.attempts >= 3 ? k.manualUploadNext : ""}
          </p>
        </div>
      )}
      {attempts.exhausted && RETRYABLE.includes(result.status) && (
        <p style={{ fontSize: 13, color: T.muted, margin: "14px 0 0" }}>{k.exhausted}</p>
      )}
      {feedback && (
        <p style={{ color: T.warning, fontSize: 13, margin: "8px 0 0" }}>{feedback}</p>
      )}
    </div>
  );
}
