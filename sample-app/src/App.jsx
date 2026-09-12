import { useEffect, useState } from "react";
import { VerifyPassProvider, VerificationWidget } from "@verifypass/react";

// Local in-house webcam test harness. It plays the role a fintech BACKEND
// normally plays (creating a session with the secret key), then hands the
// self-locating sdkToken to the browser widget for DEVICE CAMERA capture.
//
// SECURITY NOTE: a real integration NEVER puts the secret key in the browser —
// the backend creates the session and passes only { sessionId, sdkToken } to
// the client. The sdkToken embeds the API origin, so the widget does not need a
// baseUrl. This app takes the secret key at runtime purely for local testing.

const CONFIGURED_API_BASE = typeof __VP_API_BASE__ !== "undefined" ? __VP_API_BASE__ : "";

function inferApiBase() {
  if (typeof window === "undefined") return "http://localhost:3000";

  const { hostname } = window.location;
  if (CONFIGURED_API_BASE) return CONFIGURED_API_BASE.replace(/\/$/, "");
  if (hostname === "localhost" || hostname === "127.0.0.1") return "http://localhost:3000";
  return window.location.origin;
}

const API_BASE = inferApiBase();

const PRIMARY = "#6D28D9";
// Outcomes the WIDGET can recover from itself (its result screen offers
// "Try again" + manual ID upload) — the host must keep it mounted for these.
const RETRYABLE_STATUSES = ["rejected", "manual_review", "failed"];

export default function App() {
  const [secretKey, setSecretKey] = useState("");
  const [customerRef, setCustomerRef] = useState("");
  const [verificationType, setVerificationType] = useState("ID_AND_FACE");
  const [session, setSession] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [cameraState, setCameraState] = useState("pending"); // pending | granted | denied | unsupported
  const widgetBaseUrl = API_BASE;

  // Request camera permission as soon as the page loads (not at capture time).
  // Once granted, the widget's camera starts later without a second prompt.
  useEffect(() => {
    let stream = null;
    let cancelled = false;
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : null;
    if (!md || !md.getUserMedia) {
      setCameraState("unsupported");
      return undefined;
    }
    md.getUserMedia({ video: { facingMode: "user" } })
      .then((s) => {
        // Permission granted; release the camera until the flow needs it.
        s.getTracks().forEach((t) => t.stop());
        if (!cancelled) setCameraState("granted");
      })
      .catch(() => { if (!cancelled) setCameraState("denied"); });
    return () => { cancelled = true; if (stream) stream.getTracks().forEach((t) => t.stop()); };
  }, []);

  async function startSession(e) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/v1/verification-sessions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secretKey.trim()}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          customerReference: customerRef || `SAMPLE-${Date.now()}`,
          verificationType
        })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
      setSession(json); // { sessionId, sdkToken, livenessChallenge, ... }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    // Synchronous state clear; guarded so a double click can't race a fetch.
    setDetails(null);
    setSession(null);
    setResult(null);
    setError(null);
  }

  // DEV-ONLY: after a terminal result, pull the tenant result (secret key) so
  // testers see the FULL reason codes + per-action challenge detail that the
  // end-user widget deliberately does not show.
  const [details, setDetails] = useState(null);
  useEffect(() => {
    if (!result || !session || !secretKey.trim()) return undefined;
    let cancelled = false;
    fetch(`${API_BASE}/v1/verification-sessions/${session.sessionId}/result`, {
      headers: { Authorization: `Bearer ${secretKey.trim()}` }
    }).then((r) => r.json()).then((j) => { if (!cancelled) setDetails(j); }).catch(() => {});
    return () => { cancelled = true; };
  }, [result, session, secretKey]);

  return (
    <div style={{ minHeight: "100vh", fontFamily: "system-ui, sans-serif", color: "#111827" }}>
      <header style={{ background: "#111827", color: "#fff", padding: "14px 20px" }}>
        <strong>VerifyPass</strong> · Sample Webcam Test App
        <span style={{ float: "right", fontSize: 12, color: "#9CA3AF" }}>Session API: {API_BASE}</span>
      </header>

      <main style={{ maxWidth: 460, margin: "24px auto", padding: "0 16px" }}>
        {!session && (
          <Card>
            <h2 style={{ marginTop: 0 }}>Start a verification</h2>
            <p style={{ color: "#6B7280", fontSize: 14 }}>
              Paste a <b>secret key</b> from the dev stack output
              (<code>vp_sec_…</code>). This stands in for your backend creating a
              session; the returned sdkToken then tells the widget which API to use.
            </p>

            <Warning>
              For local testing only. Never expose a secret key in a real browser
              app — create sessions from your server.
            </Warning>

            <CameraStatus state={cameraState} />

            <form onSubmit={startSession}>
              <Label>Secret key</Label>
              <input
                style={input} value={secretKey} onChange={(e) => setSecretKey(e.target.value)}
                placeholder="vp_sec_test_…" autoComplete="off"
              />
              <Label>Customer reference (optional)</Label>
              <input
                style={input} value={customerRef} onChange={(e) => setCustomerRef(e.target.value)}
                placeholder="e.g. user-123"
              />
              <Label>Verification type</Label>
              <select style={input} value={verificationType} onChange={(e) => setVerificationType(e.target.value)}>
                <option value="ID_AND_FACE">ID + Face (document, liveness, selfie)</option>
                <option value="FACE_ONLY">Face only (liveness, selfie)</option>
                <option value="ID_ONLY">ID only (document)</option>
              </select>

              {error && <p style={{ color: "#DC2626", fontSize: 14 }}>{error}</p>}

              <button type="submit" disabled={busy || !secretKey.trim()} style={{
                width: "100%", marginTop: 12, padding: 12, borderRadius: 8, border: 0,
                background: PRIMARY, color: "#fff", fontSize: 16,
                cursor: busy ? "wait" : "pointer", opacity: (busy || !secretKey.trim()) ? 0.6 : 1
              }}>
                {busy ? "Creating session…" : "Start verification"}
              </button>
            </form>
          </Card>
        )}

        {/* Keep the widget MOUNTED for retryable outcomes — its result screen
            owns "Try again" (+ manual ID upload after 3 attempts). Unmounting
            on every onComplete was hiding that UI entirely. */}
        {session && (!result || RETRYABLE_STATUSES.includes(result.status)) && (
          <Card>
            <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 8 }}>
              Session <code>{session.sessionId}</code>
              <br />
              Widget API is using the secure same-origin proxy.
            </div>
            <VerifyPassProvider publicKey={null} baseUrl={widgetBaseUrl} faceModelUrl={import.meta.env.VITE_VP_FACE_MODEL_URL || "/models/fr_detect.onnx"}>
              <VerificationWidget
                sessionId={session.sessionId}
                sdkToken={session.sdkToken}
                onComplete={(r) => setResult(r)}
                onStepChange={(s) => {
                  // a retry reset the flow — clear the stale result
                  if (s !== "complete" && s !== "processing") setResult(null);
                }}
                onError={(err) => setError(err.message || String(err))}
              />
            </VerifyPassProvider>
            {error && <p style={{ color: "#DC2626", fontSize: 14, marginTop: 12 }}>{error}</p>}
            {result && <DevDetails details={details} />}
            <button onClick={reset} style={linkBtn}>Cancel</button>
          </Card>
        )}

        {result && !RETRYABLE_STATUSES.includes(result.status) && (
          <Card>
            <h2 style={{ marginTop: 0 }}>
              {result.status === "approved" ? "✅ Approved"
                : result.status === "manual_review" ? "⏳ Manual review"
                : "❌ Not successful"}
            </h2>
            <pre style={{ background: "#F9FAFB", padding: 12, borderRadius: 8, fontSize: 12, overflow: "auto" }}>
              {JSON.stringify(result, null, 2)}
            </pre>
            <DevDetails details={details} />
            <button onClick={reset} style={{
              width: "100%", marginTop: 8, padding: 12, borderRadius: 8, border: 0,
              background: PRIMARY, color: "#fff", fontSize: 16, cursor: "pointer"
            }}>
              Run another
            </button>
          </Card>
        )}
      </main>
    </div>
  );
}

function DevDetails({ details }) {
  if (!details) return null;
  const codes = details.decision?.reasonCodes || [];
  const lc = details.livenessChallenge;
  return (
    <div style={{ marginTop: 12, fontSize: 12, background: "#111827", color: "#E5E7EB", borderRadius: 8, padding: 12 }}>
      <div style={{ color: "#9CA3AF", marginBottom: 6 }}>Developer details (secret-key result — not shown to end users)</div>
      <div><b>status</b> {details.status} · <b>risk</b> {details.riskLevel || "-"} · <b>liveness</b> {details.liveness ? `${details.liveness.status} (${details.liveness.score ?? "-"})` : "n/a"}
        {details.faceMatch ? <> · <b>faceMatch</b> {details.faceMatch.status} ({details.faceMatch.similarityScore ?? "-"})</> : null}</div>
      <div style={{ marginTop: 4 }}><b>reasonCodes</b> {codes.length ? codes.join(", ") : "(none)"}</div>
      {details.liveness && (
        <div style={{ marginTop: 4, color: details.liveness.score > 0.6 && (details.liveness.selfieScore ?? details.liveness.score) > 0.6 ? "#34D399" : "#FBBF24" }}>
          <b>60% rule:</b> {details.liveness.score > 0.6 && (details.liveness.selfieScore ?? details.liveness.score) > 0.6
            ? "Auto-approved (>60% confidence & frontal score)"
            : "Retry prompted (confidence or frontal score ≤60%)"}
        </div>
      )}
      {lc && (
        <div style={{ marginTop: 4 }}>
          <b>challenge</b> {lc.ok ? "ok" : "FAILED"} {lc.reasonCodes?.length ? `(${lc.reasonCodes.join(", ")})` : ""}
          <div style={{ marginLeft: 8 }}>
            {(lc.actions || []).map((a) => {
              const pa = lc.perAction?.[a] || {};
              return <div key={a}>{a}: present={String(pa.present)} live={String(pa.live)} pose={pa.poseChecked ? String(pa.poseOk) : "n/a"}{pa.peakYaw != null ? ` yaw=${pa.peakYaw > 0 ? "+" : ""}${pa.peakYaw}°` : pa.maxAbsYaw != null ? ` |yaw|=${Number(pa.maxAbsYaw).toFixed(1)}°` : ""}{pa.peakPitch != null ? ` pitch=${pa.peakPitch > 0 ? "+" : ""}${pa.peakPitch}°` : ""}{pa.trajectoryChecked ? ` motion=${pa.trajectoryOk ? "ok" : "static"}` : ""}{pa.score != null ? ` score=${Number(pa.score).toFixed(2)}` : ""}</div>;
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Card({ children }) {
  return (
    <div style={{ background: "#fff", borderRadius: 12, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }}>
      {children}
    </div>
  );
}
function Label({ children }) {
  return <div style={{ fontSize: 13, fontWeight: 600, margin: "10px 0 4px" }}>{children}</div>;
}
function Warning({ children }) {
  return (
    <div style={{ background: "#FEF3C7", color: "#92400E", borderRadius: 8, padding: "8px 10px", fontSize: 13, margin: "10px 0" }}>
      {children}
    </div>
  );
}

function CameraStatus({ state }) {
  const map = {
    pending: { bg: "#EFF6FF", fg: "#1D4ED8", text: "Requesting camera access…" },
    granted: { bg: "#ECFDF5", fg: "#047857", text: "Camera access granted ✓" },
    denied: { bg: "#FEF2F2", fg: "#B91C1C", text: "Camera blocked — allow it in your browser to run the flow." },
    unsupported: { bg: "#FEF2F2", fg: "#B91C1C", text: "This browser has no camera API (use HTTPS or localhost)." }
  };
  const s = map[state] || map.pending;
  return (
    <div style={{ background: s.bg, color: s.fg, borderRadius: 8, padding: "8px 10px", fontSize: 13, margin: "10px 0" }}>
      {s.text}
    </div>
  );
}

const input = { width: "100%", padding: 10, borderRadius: 8, border: "1px solid #D1D5DB", fontSize: 14, boxSizing: "border-box" };
const linkBtn = { display: "block", margin: "12px auto 0", background: "none", border: 0, color: "#6B7280", cursor: "pointer", fontSize: 13 };
