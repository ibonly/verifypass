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
const PREFILL_SECRET = typeof __VP_SECRET_KEY__ !== "undefined" ? __VP_SECRET_KEY__ : "";

function inferApiBase() {
  if (CONFIGURED_API_BASE) return CONFIGURED_API_BASE.replace(/\/$/, "");
  if (typeof window === "undefined") return "http://localhost:3000";

  const { protocol, hostname } = window.location;
  if (hostname === "localhost" || hostname === "127.0.0.1") return "http://localhost:3000";
  return window.location.origin;
}

const API_BASE = inferApiBase();

const PRIMARY = "#6D28D9";

export default function App() {
  const [secretKey, setSecretKey] = useState(PREFILL_SECRET);
  const [customerRef, setCustomerRef] = useState("");
  const [verificationType, setVerificationType] = useState("ID_AND_FACE");
  const [session, setSession] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [cameraState, setCameraState] = useState("pending"); // pending | granted | denied | unsupported
  const tokenIsSelfLocating = Boolean(session?.sdkToken?.startsWith("sdk_v1_"));
  const widgetBaseUrl = tokenIsSelfLocating ? null : API_BASE;

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
    setSession(null);
    setResult(null);
    setError(null);
  }

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

        {session && !result && (
          <Card>
            <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 8 }}>
              Session <code>{session.sessionId}</code>
              <br />
              {tokenIsSelfLocating
                ? "Widget API is resolved from the self-locating sdkToken."
                : "Legacy sdkToken detected; widget is using the local API fallback."}
            </div>
            <VerifyPassProvider publicKey={null} baseUrl={widgetBaseUrl} faceModelUrl="/models/fr_detect.onnx">
              <VerificationWidget
                sessionId={session.sessionId}
                sdkToken={session.sdkToken}
                onComplete={(r) => setResult(r)}
                onError={(err) => setError(err.message || String(err))}
              />
            </VerifyPassProvider>
            {error && <p style={{ color: "#DC2626", fontSize: 14, marginTop: 12 }}>{error}</p>}
            <button onClick={reset} style={linkBtn}>Cancel</button>
          </Card>
        )}

        {result && (
          <Card>
            <h2 style={{ marginTop: 0 }}>
              {result.status === "approved" ? "✅ Approved"
                : result.status === "manual_review" ? "⏳ Manual review"
                : "❌ Not successful"}
            </h2>
            <pre style={{ background: "#F9FAFB", padding: 12, borderRadius: 8, fontSize: 12, overflow: "auto" }}>
              {JSON.stringify(result, null, 2)}
            </pre>
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
