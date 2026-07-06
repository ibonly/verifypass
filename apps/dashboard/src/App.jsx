import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiDownload, setAuth, getToken } from "./api";

const PRIMARY = "#6D28D9";
const STATUS_COLORS = {
  approved: "#059669", rejected: "#DC2626", manual_review: "#D97706",
  submitted: "#2563EB", started: "#2563EB", created: "#6B7280",
  expired: "#9CA3AF", failed: "#DC2626", abandoned: "#9CA3AF",
  delivered: "#059669", pending: "#D97706", exhausted: "#DC2626"
};

// Human-readable labels for decision reason codes
const REASON_LABELS = {
  LIVENESS_FAILED: "Liveness check failed",
  LIVENESS_BORDERLINE: "Liveness score in borderline range",
  LIVENESS_CHALLENGE_FAILED: "Liveness challenge failed",
  LIVENESS_CHALLENGE_INCOMPLETE: "Liveness challenge not completed",
  FACE_MATCH_FAILED: "Face does not match ID document",
  FACE_MATCH_BORDERLINE: "Face match score in borderline range",
  NO_FACE_ON_SELFIE: "No face detected in selfie",
  NO_FACE_ON_DOCUMENT: "No face detected on ID document",
  MULTIPLE_FACES_DETECTED: "Multiple faces detected",
  DOCUMENT_OCR_FAILED: "Could not read ID document text",
  DOCUMENT_EXPIRED: "ID document appears expired",
  DEVICE_SHARED_ACROSS_IDENTITIES: "Device flagged for multiple identities",
  TOO_MANY_FAILED_ATTEMPTS: "Too many failed attempts from this user",
  IP_RATE_LIMIT: "Too many attempts from this IP address"
};

export default function App() {
  const [user, setUser] = useState(null);
  const [view, setView] = useState("overview");
  const [selectedSession, setSelectedSession] = useState(null);

  if (!getToken() || !user) return <Login onLogin={setUser} />;

  const views = {
    overview: <Overview />,
    sessions: <Sessions onSelectSession={setSelectedSession} />,
    review: <ReviewQueue />,
    reports: <Reports />,
    settings: <Settings />,
    webhooks: <Webhooks />
  };

  const NAV_LABELS = {
    overview: "Overview", sessions: "Sessions", review: "Manual Review",
    reports: "Reports", settings: "Settings", webhooks: "Webhooks"
  };

  return (
    <div style={{ display: "flex", minHeight: "100vh", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <nav style={{ width: 200, background: "#111827", color: "#D1D5DB", padding: 16, flexShrink: 0 }}>
        <h3 style={{ color: "#fff", margin: "0 0 20px", fontSize: 16 }}>VerifyPass</h3>
        {Object.keys(views).map((v) => (
          <div key={v}
            onClick={() => { setView(v); setSelectedSession(null); }}
            style={{
              padding: "8px 10px", borderRadius: 6, marginBottom: 4, cursor: "pointer",
              background: view === v ? PRIMARY : "transparent",
              color: view === v ? "#fff" : "#D1D5DB"
            }}>
            {NAV_LABELS[v]}
          </div>
        ))}
        <div style={{ marginTop: 32, fontSize: 12 }}>
          {user.email}<br />
          <span style={{ color: "#9CA3AF" }}>{user.role}</span><br />
          <button onClick={() => { setAuth(null); setUser(null); }}
            style={{ marginTop: 8, background: "none", border: "1px solid #4B5563", color: "#D1D5DB", borderRadius: 4, padding: "4px 8px" }}>
            Sign out
          </button>
        </div>
      </nav>

      <main style={{ flex: 1, padding: 24, maxWidth: 1000, overflowY: "auto" }}>
        {views[view]}
      </main>

      {/* Session Detail Slide-in Panel */}
      {selectedSession && (
        <SessionDetail
          sessionId={selectedSession}
          onClose={() => setSelectedSession(null)}
        />
      )}
    </div>
  );
}

// ─── Login ────────────────────────────────────────────────────────────────────

function Login({ onLogin }) {
  const [form, setForm] = useState({ email: "", password: "", totp: "", tenant: "" });
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setError(null);
    try {
      const res = await api("/v1/auth/login", { method: "POST", body: form });
      setAuth(res.token, form.tenant || null);
      onLogin({ email: res.email, role: res.role });
    } catch (err) {
      setError(err.message);
    }
  }

  const input = { width: "100%", padding: 10, marginBottom: 10, borderRadius: 6, border: "1px solid #D1D5DB", boxSizing: "border-box" };
  return (
    <div style={{ maxWidth: 360, margin: "12vh auto" }}>
      <h2>Sign in to VerifyPass</h2>
      <form onSubmit={submit}>
        <input style={input} placeholder="Email" value={form.email} onChange={set("email")} />
        <input style={input} type="password" placeholder="Password" value={form.password} onChange={set("password")} />
        <input style={input} placeholder="TOTP code (if enrolled)" value={form.totp} onChange={set("totp")} />
        <input style={input} placeholder="Tenant ID (super admin only)" value={form.tenant} onChange={set("tenant")} />
        {error && <p style={{ color: "#DC2626", fontSize: 14 }}>{error}</p>}
        <button type="submit" style={{ width: "100%", padding: 12, background: PRIMARY, color: "#fff", border: 0, borderRadius: 6, fontSize: 16, cursor: "pointer" }}>
          Sign in
        </button>
      </form>
    </div>
  );
}

// ─── Shared hooks & components ────────────────────────────────────────────────

function useData(path, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const reload = useCallback(() => {
    api(path).then(setData).catch(setError);
  }, [path]);
  useEffect(reload, deps.concat(reload));
  return { data, error, reload };
}

function StatusPill({ status }) {
  const color = STATUS_COLORS[status] || "#6B7280";
  return (
    <span style={{
      background: color + "22", color,
      padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap"
    }}>{status}</span>
  );
}

function Card({ title, children, style }) {
  return (
    <div style={{ background: "#fff", borderRadius: 10, padding: 16, marginBottom: 16, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", ...style }}>
      {title && <h3 style={{ margin: "0 0 12px", fontSize: 15 }}>{title}</h3>}
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <div style={{ width: 20, height: 20, borderRadius: "50%", border: "2px solid #E5E7EB", borderTopColor: PRIMARY, animation: "spin .6s linear infinite", display: "inline-block" }}>
      <style>{"@keyframes spin{to{transform:rotate(360deg)}}"}</style>
    </div>
  );
}

function ReasonCodes({ codes }) {
  if (!codes || codes.length === 0) return null;
  return (
    <div style={{ marginTop: 8 }}>
      {codes.map((c) => (
        <div key={c} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, fontSize: 13 }}>
          <span style={{ color: "#DC2626" }}>●</span>
          <span style={{ color: "#374151" }}>{REASON_LABELS[c] || c}</span>
          <code style={{ color: "#9CA3AF", fontSize: 11 }}>{c}</code>
        </div>
      ))}
    </div>
  );
}

// ─── Overview ─────────────────────────────────────────────────────────────────

function Overview() {
  const { data, error } = useData("/v1/dashboard/stats");
  if (error) return <p style={{ color: "#DC2626" }}>{error.message}</p>;
  if (!data) return <div style={{ color: "#6B7280", fontSize: 14 }}><Spinner /> Loading…</div>;

  const s = data.byStatus;
  const statCards = [
    { label: "Total", value: data.total, color: "#111827" },
    { label: "Approved", value: s.approved ?? 0, color: STATUS_COLORS.approved },
    { label: "Rejected", value: s.rejected ?? 0, color: STATUS_COLORS.rejected },
    { label: "In Review", value: s.manual_review ?? 0, color: STATUS_COLORS.manual_review },
    { label: "In Progress", value: (s.started ?? 0) + (s.created ?? 0), color: STATUS_COLORS.started }
  ];

  return (
    <>
      <h2 style={{ marginTop: 0 }}>Overview</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 16 }}>
        {statCards.map(({ label, value, color }) => (
          <div key={label} style={{ background: "#fff", borderRadius: 10, padding: "16px 12px", textAlign: "center", boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }}>
            <div style={{ fontSize: 28, fontWeight: 700, color }}>{value}</div>
            <div style={{ fontSize: 12, color: "#6B7280", marginTop: 4 }}>{label}</div>
          </div>
        ))}
      </div>
      <Card>
        <div style={{ fontSize: 14, color: "#374151" }}>
          Average completion time:{" "}
          <strong>{data.avgCompletionSeconds != null ? `${data.avgCompletionSeconds}s` : "—"}</strong>
        </div>
      </Card>
    </>
  );
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

function Sessions({ onSelectSession }) {
  const [status, setStatus] = useState("");
  const { data, error } = useData(
    `/v1/dashboard/sessions${status ? `?status=${status}` : ""}`,
    [status]
  );

  return (
    <>
      <h2 style={{ marginTop: 0 }}>Sessions</h2>
      <select value={status} onChange={(e) => setStatus(e.target.value)}
        style={{ padding: 8, marginBottom: 12, borderRadius: 6, border: "1px solid #D1D5DB" }}>
        <option value="">All statuses</option>
        {["approved","rejected","manual_review","started","created","expired"].map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>

      {error && <p style={{ color: "#DC2626" }}>{error.message}</p>}

      <Card>
        {!data && <div style={{ color: "#6B7280", fontSize: 14 }}><Spinner /> Loading sessions…</div>}
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#6B7280", borderBottom: "2px solid #F3F4F6" }}>
              <th style={{ padding: "6px 8px" }}>Session</th>
              <th style={{ padding: "6px 8px" }}>Customer ref</th>
              <th style={{ padding: "6px 8px" }}>Status</th>
              <th style={{ padding: "6px 8px" }}>Risk</th>
              <th style={{ padding: "6px 8px" }}>Created</th>
            </tr>
          </thead>
          <tbody>
            {(data?.sessions || []).map((s) => (
              <tr
                key={s.sessionId}
                onClick={() => onSelectSession(s.sessionId)}
                style={{
                  borderTop: "1px solid #F3F4F6", cursor: "pointer",
                  transition: "background .1s"
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = "#F9FAFB"}
                onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
              >
                <td style={{ padding: "8px 8px", fontFamily: "monospace", fontSize: 11, color: PRIMARY }}>
                  {s.sessionId}
                </td>
                <td style={{ padding: "8px 8px" }}>{s.customerReference || <span style={{ color: "#9CA3AF" }}>—</span>}</td>
                <td style={{ padding: "8px 8px" }}><StatusPill status={s.status} /></td>
                <td style={{ padding: "8px 8px" }}>{s.riskLevel ? <StatusPill status={s.riskLevel} /> : <span style={{ color: "#9CA3AF" }}>—</span>}</td>
                <td style={{ padding: "8px 8px", color: "#6B7280", fontSize: 12 }}>
                  {s.createdAt?.slice(0, 16).replace("T", " ")}
                </td>
              </tr>
            ))}
            {data && data.sessions.length === 0 && (
              <tr><td colSpan={5} style={{ padding: 16, textAlign: "center", color: "#9CA3AF" }}>No sessions found.</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}

// ─── Session Detail Panel ─────────────────────────────────────────────────────

function SessionDetail({ sessionId, onClose }) {
  const { data, error } = useData(`/v1/dashboard/sessions/${sessionId}`, [sessionId]);
  const panelRef = useRef(null);

  // Close on outside click
  useEffect(() => {
    function handler(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) onClose();
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const rowStyle = { display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #F3F4F6", fontSize: 13 };
  const labelStyle = { color: "#6B7280" };
  const valStyle = { fontWeight: 500, textAlign: "right", maxWidth: "55%" };

  function ScoreBar({ label, value }) {
    if (value == null) return null;
    const pct = Math.round(value * 100);
    const color = value >= 0.85 ? STATUS_COLORS.approved : value >= 0.7 ? STATUS_COLORS.manual_review : STATUS_COLORS.rejected;
    return (
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}>
          <span style={{ color: "#6B7280" }}>{label}</span>
          <span style={{ fontWeight: 600, color }}>{pct}%</span>
        </div>
        <div style={{ height: 6, background: "#F3F4F6", borderRadius: 3, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 3, transition: "width .4s" }} />
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Overlay backdrop */}
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", zIndex: 100 }} />

      {/* Slide-in panel */}
      <div ref={panelRef} style={{
        position: "fixed", top: 0, right: 0, bottom: 0, width: 440,
        background: "#fff", boxShadow: "-4px 0 24px rgba(0,0,0,0.15)",
        zIndex: 101, overflowY: "auto", padding: 24
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Session Detail</h3>
          <button onClick={onClose} style={{ background: "none", border: 0, cursor: "pointer", fontSize: 20, color: "#6B7280", lineHeight: 1 }}>✕</button>
        </div>

        {error && <p style={{ color: "#DC2626", fontSize: 14 }}>{error.message}</p>}
        {!data && !error && <div style={{ textAlign: "center", padding: 32 }}><Spinner /></div>}

        {data && (
          <>
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <StatusPill status={data.status} />
                {data.riskLevel && <StatusPill status={data.riskLevel} />}
              </div>
              <code style={{ fontSize: 11, color: "#6B7280", wordBreak: "break-all" }}>{data.sessionId}</code>
            </div>

            {/* Basic info */}
            <div style={{ marginBottom: 16 }}>
              <div style={rowStyle}>
                <span style={labelStyle}>Customer ref</span>
                <span style={valStyle}>{data.customerReference || "—"}</span>
              </div>
              <div style={rowStyle}>
                <span style={labelStyle}>Type</span>
                <span style={valStyle}>{data.verificationType || "—"}</span>
              </div>
              <div style={rowStyle}>
                <span style={labelStyle}>Environment</span>
                <span style={valStyle}>{data.isLive ? "🟢 Live" : "🧪 Test"}</span>
              </div>
              <div style={rowStyle}>
                <span style={labelStyle}>Created</span>
                <span style={valStyle}>{data.createdAt?.slice(0, 19).replace("T", " ")}</span>
              </div>
              <div style={rowStyle}>
                <span style={labelStyle}>Completed</span>
                <span style={valStyle}>{data.completedAt ? data.completedAt.slice(0, 19).replace("T", " ") : "—"}</span>
              </div>
              {data.expiresAt && !data.completedAt && (
                <div style={rowStyle}>
                  <span style={labelStyle}>Expires</span>
                  <span style={valStyle}>{data.expiresAt.slice(0, 19).replace("T", " ")}</span>
                </div>
              )}
            </div>

            {/* Scores */}
            {(data.liveness || data.faceMatch || data.document) && (
              <div style={{ marginBottom: 16 }}>
                <h4 style={{ margin: "0 0 10px", fontSize: 13, color: "#374151", textTransform: "uppercase", letterSpacing: 0.5 }}>Scores</h4>
                <ScoreBar label="Liveness" value={data.liveness?.score} />
                <ScoreBar label="Face Match" value={data.faceMatch?.similarityScore} />
                <ScoreBar label="OCR Confidence" value={data.document?.ocrConfidence} />

                {data.liveness && (
                  <div style={rowStyle}>
                    <span style={labelStyle}>Liveness status</span>
                    <span style={valStyle}>{data.liveness.status || "—"}</span>
                  </div>
                )}
                {data.faceMatch && (
                  <div style={rowStyle}>
                    <span style={labelStyle}>Face match status</span>
                    <span style={valStyle}>{data.faceMatch.status || "—"}</span>
                  </div>
                )}
                {data.document && (
                  <div style={rowStyle}>
                    <span style={labelStyle}>Document status</span>
                    <span style={valStyle}>{data.document.status || "—"}</span>
                  </div>
                )}
              </div>
            )}

            {/* Decision reason codes */}
            {data.decision?.reasonCodes?.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <h4 style={{ margin: "0 0 8px", fontSize: 13, color: "#374151", textTransform: "uppercase", letterSpacing: 0.5 }}>
                  Decision Reasons
                </h4>
                <ReasonCodes codes={data.decision.reasonCodes} />
              </div>
            )}

            {/* Extracted document data */}
            {data.document?.extractedData && (
              <div style={{ marginBottom: 16 }}>
                <h4 style={{ margin: "0 0 8px", fontSize: 13, color: "#374151", textTransform: "uppercase", letterSpacing: 0.5 }}>
                  Extracted Document Data
                </h4>
                <pre style={{ background: "#F9FAFB", padding: 10, borderRadius: 6, fontSize: 11, overflow: "auto", margin: 0 }}>
                  {JSON.stringify(data.document.extractedData, null, 2)}
                </pre>
              </div>
            )}

            {/* Evidence photos */}
            <EvidenceGallery sessionId={sessionId} />
          </>
        )}
      </div>
    </>
  );
}

// ─── Evidence Gallery ─────────────────────────────────────────────────────────

const FILE_TYPE_LABELS = {
  id_front: "ID Front",
  id_back: "ID Back",
  selfie: "Selfie",
  liveness_frame: "Liveness Frame"
};

/* __VP_API_BASE__ is injected by Vite at build time (same as in api.js) */
function EvidenceGallery({ sessionId }) {
  const { data, error } = useData(`/v1/dashboard/sessions/${sessionId}/evidence`, [sessionId]);
  const [lightbox, setLightbox] = useState(null); // full-size image URL

  if (error) return <p style={{ color: "#DC2626", fontSize: 13 }}>Could not load evidence: {error.message}</p>;
  if (!data) return <div style={{ color: "#6B7280", fontSize: 13, padding: "8px 0" }}><Spinner /> Loading photos…</div>;
  if (!data.evidence || data.evidence.length === 0) {
    return <p style={{ color: "#9CA3AF", fontSize: 13 }}>No evidence files captured for this session.</p>;
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <h4 style={{ margin: "0 0 10px", fontSize: 13, color: "#374151", textTransform: "uppercase", letterSpacing: 0.5 }}>
        Evidence Photos ({data.evidence.length})
      </h4>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
        {data.evidence.map((ev) => {
          const imgSrc = `${__VP_API_BASE__}${ev.serveUrl}`;
          const title = FILE_TYPE_LABELS[ev.fileType] || ev.fileType;
          const subtitle = ev.label ? ` — ${ev.label.replace(/_/g, " ")}` : "";
          return (
            <div key={ev.evidenceId}
              onClick={() => setLightbox(imgSrc)}
              style={{ cursor: "pointer", borderRadius: 8, overflow: "hidden", border: "1px solid #E5E7EB", background: "#F9FAFB" }}>
              <img
                src={imgSrc}
                alt={title + subtitle}
                style={{ width: "100%", height: 110, objectFit: "cover", display: "block" }}
                onError={(e) => { e.target.style.display = "none"; e.target.nextSibling.style.display = "flex"; }}
              />
              <div style={{ display: "none", height: 110, alignItems: "center", justifyContent: "center", color: "#9CA3AF", fontSize: 12 }}>
                ⚠️ Load failed
              </div>
              <div style={{ padding: "4px 8px", fontSize: 11, color: "#6B7280", fontWeight: 500 }}>
                {title}{subtitle}
              </div>
            </div>
          );
        })}
      </div>

      {/* Lightbox */}
      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)",
            zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center"
          }}>
          <img src={lightbox} alt="Evidence"
            style={{ maxWidth: "90vw", maxHeight: "90vh", borderRadius: 8, objectFit: "contain" }} />
          <button
            onClick={() => setLightbox(null)}
            style={{
              position: "absolute", top: 16, right: 16, background: "rgba(255,255,255,0.15)",
              border: 0, color: "#fff", fontSize: 24, cursor: "pointer", borderRadius: "50%",
              width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center"
            }}>✕</button>
        </div>
      )}
    </div>
  );
}


function ReviewQueue() {
  const { data, error, reload } = useData("/v1/manual-review");
  const [notes, setNotes] = useState({});
  const [busy, setBusy] = useState(null);

  async function decideCase(sessionId, decision) {
    setBusy(sessionId);
    try {
      await api(`/v1/manual-review/${sessionId}/decision`, { method: "POST", body: { decision, note: notes[sessionId] || "" } });
      setNotes((n) => ({ ...n, [sessionId]: "" }));
      reload();
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(null);
    }
  }

  if (error) return <p style={{ color: "#DC2626" }}>{error.message}</p>;
  return (
    <>
      <h2 style={{ marginTop: 0 }}>Manual Review</h2>
      {!data && <p><Spinner /> Loading…</p>}
      {(data?.cases || []).length === 0 && data && <Card>No cases waiting for review. 🎉</Card>}
      {(data?.cases || []).map((c) => (
        <Card key={c.sessionId} title={c.customerReference || c.sessionId}>
          <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            <StatusPill status={c.status} />
            {c.riskLevel && <StatusPill status={c.riskLevel} />}
          </div>
          <div style={{ display: "flex", gap: 24, marginBottom: 10, fontSize: 13, flexWrap: "wrap" }}>
            <div>Liveness: <strong>{c.scores?.liveness != null ? `${(c.scores.liveness * 100).toFixed(1)}%` : "—"}</strong></div>
            <div>Face match: <strong>{c.scores?.faceMatch != null ? `${(c.scores.faceMatch * 100).toFixed(1)}%` : "—"}</strong></div>
            <div>OCR: <strong>{c.scores?.ocrConfidence != null ? `${(c.scores.ocrConfidence * 100).toFixed(1)}%` : "—"}</strong></div>
          </div>

          <ReasonCodes codes={c.reasonCodes} />

          {c.extractedData && (
            <pre style={{ background: "#F9FAFB", padding: 8, borderRadius: 6, fontSize: 11, overflow: "auto", margin: "10px 0" }}>
              {JSON.stringify(c.extractedData, null, 2)}
            </pre>
          )}
          <input
            placeholder="Review note (recorded in audit log)"
            value={notes[c.sessionId] || ""}
            onChange={(e) => setNotes((n) => ({ ...n, [c.sessionId]: e.target.value }))}
            style={{ width: "100%", padding: 8, marginTop: 10, marginBottom: 8, borderRadius: 6, border: "1px solid #D1D5DB", boxSizing: "border-box" }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={busy === c.sessionId} onClick={() => decideCase(c.sessionId, "approved")}
              style={{ padding: "8px 16px", background: STATUS_COLORS.approved, color: "#fff", border: 0, borderRadius: 6, cursor: "pointer" }}>Approve</button>
            <button disabled={busy === c.sessionId} onClick={() => decideCase(c.sessionId, "rejected")}
              style={{ padding: "8px 16px", background: STATUS_COLORS.rejected, color: "#fff", border: 0, borderRadius: 6, cursor: "pointer" }}>Reject</button>
            <button disabled={busy === c.sessionId} onClick={() => decideCase(c.sessionId, "recapture")}
              style={{ padding: "8px 16px", background: "#fff", color: "#111827", border: "1px solid #D1D5DB", borderRadius: 6, cursor: "pointer" }}>
              Request recapture
            </button>
          </div>
        </Card>
      ))}
    </>
  );
}

// ─── Reports ──────────────────────────────────────────────────────────────────

function Reports() {
  const [days, setDays] = useState(30);
  const volume = useData(`/v1/reports/volume?days=${days}`, [days]);
  const reasons = useData(`/v1/reports/rejection-reasons?days=${days}`, [days]);
  const today = new Date().toISOString().slice(0, 10);

  const dl = (name) => () =>
    apiDownload(`/v1/reports/${name}?days=${days}&format=csv`, `verifypass-${name}-${today}.csv`)
      .catch((e) => alert(e.message));

  const maxTotal = Math.max(1, ...(volume.data?.days || []).map((d) => d.total));

  return (
    <>
      <h2 style={{ marginTop: 0 }}>Reports</h2>
      <div style={{ marginBottom: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ padding: 8, borderRadius: 6, border: "1px solid #D1D5DB" }}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
        {["volume", "rejection-reasons", "risk-events", "audit-log", "webhook-failures"].map((n) => (
          <button key={n} onClick={dl(n)}
            style={{ padding: "8px 12px", borderRadius: 6, border: "1px solid #D1D5DB", background: "#fff", fontSize: 13, cursor: "pointer" }}>
            ⬇ {n}.csv
          </button>
        ))}
      </div>

      <Card title="Daily volume">
        {(volume.data?.days || []).length === 0 && <p style={{ color: "#6B7280" }}>No sessions in this window.</p>}
        {(volume.data?.days || []).map((d) => (
          <div key={d.date} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, fontSize: 13 }}>
            <span style={{ width: 84, color: "#6B7280", fontSize: 12 }}>{d.date}</span>
            <div style={{ flex: 1, display: "flex", height: 16, borderRadius: 4, overflow: "hidden", background: "#F3F4F6" }}>
              <div style={{ width: `${(d.approved / maxTotal) * 100}%`, background: STATUS_COLORS.approved }} />
              <div style={{ width: `${(d.manual_review / maxTotal) * 100}%`, background: STATUS_COLORS.manual_review }} />
              <div style={{ width: `${(d.rejected / maxTotal) * 100}%`, background: STATUS_COLORS.rejected }} />
            </div>
            <span style={{ width: 36, textAlign: "right", fontWeight: 600 }}>{d.total}</span>
          </div>
        ))}
      </Card>

      <Card title="Top rejection / review reasons">
        {(reasons.data?.reasons || []).length === 0 && <p style={{ color: "#6B7280" }}>None in this window. 🎉</p>}
        {(reasons.data?.reasons || []).map((r) => (
          <div key={r.reasonCode} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid #F3F4F6", fontSize: 13 }}>
            <span>
              <code style={{ color: "#6B7280", fontSize: 11, marginRight: 6 }}>{r.reasonCode}</code>
              <span style={{ color: "#374151" }}>{REASON_LABELS[r.reasonCode] || ""}</span>
            </span>
            <strong>{r.count}</strong>
          </div>
        ))}
      </Card>
    </>
  );
}

// ─── Settings ─────────────────────────────────────────────────────────────────

function NumField({ label, value, onChange, step = 0.01, hint }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, fontSize: 14 }}>
      <span style={{ width: 260, color: "#374151" }}>{label}</span>
      <input
        type="number" step={step} value={value ?? ""} placeholder="default"
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        style={{ width: 110, padding: 6, borderRadius: 6, border: "1px solid #D1D5DB" }}
      />
      {hint && <span style={{ color: "#9CA3AF", fontSize: 12 }}>{hint}</span>}
    </label>
  );
}

function Settings() {
  const { data, error, reload } = useData("/v1/settings");
  const [draft, setDraft] = useState(null);
  const [retentionDraft, setRetentionDraft] = useState(null);
  const [msg, setMsg] = useState(null);
  const [newKey, setNewKey] = useState(null);
  const [confirmPending, setConfirmPending] = useState(null); // { id, action }
  const keys = useData("/v1/settings/api-keys");

  useEffect(() => {
    if (data && !draft) {
      const o = data.thresholds.overrides;
      setDraft({
        livenessReject: o.liveness?.reject ?? null, livenessPass: o.liveness?.pass ?? null,
        faceReject: o.faceMatch?.reject ?? null, facePass: o.faceMatch?.pass ?? null,
        maxFailedAttempts: o.maxFailedAttempts ?? null,
        maxIdentitiesPerDevice: o.risk?.maxIdentitiesPerDevice ?? null,
        maxSessionsPerIpPerHour: o.risk?.maxSessionsPerIpPerHour ?? null
      });
      setRetentionDraft({ ...data.retention.overrides });
    }
  }, [data, draft]);

  async function saveThresholds() {
    setMsg(null);
    const body = {};
    if (draft.livenessReject != null || draft.livenessPass != null) {
      body.liveness = {};
      if (draft.livenessReject != null) body.liveness.reject = draft.livenessReject;
      if (draft.livenessPass != null) body.liveness.pass = draft.livenessPass;
    }
    if (draft.faceReject != null || draft.facePass != null) {
      body.faceMatch = {};
      if (draft.faceReject != null) body.faceMatch.reject = draft.faceReject;
      if (draft.facePass != null) body.faceMatch.pass = draft.facePass;
    }
    if (draft.maxFailedAttempts != null) body.maxFailedAttempts = draft.maxFailedAttempts;
    if (draft.maxIdentitiesPerDevice != null || draft.maxSessionsPerIpPerHour != null) {
      body.risk = {};
      if (draft.maxIdentitiesPerDevice != null) body.risk.maxIdentitiesPerDevice = draft.maxIdentitiesPerDevice;
      if (draft.maxSessionsPerIpPerHour != null) body.risk.maxSessionsPerIpPerHour = draft.maxSessionsPerIpPerHour;
    }
    try {
      await api("/v1/settings/thresholds", { method: "PUT", body });
      setMsg("Thresholds saved — applied to the next verification.");
      reload();
    } catch (e) {
      setMsg(`Error: ${e.message}`);
    }
  }

  async function saveRetention() {
    setMsg(null);
    try {
      await api("/v1/settings/retention", { method: "PUT", body: retentionDraft });
      setMsg("Retention policy saved.");
      reload();
    } catch (e) {
      setMsg(`Error: ${e.message}`);
    }
  }

  async function keyAction(path) {
    setNewKey(null);
    try {
      const res = await api(path, { method: "POST", body: {} });
      if (res.key) setNewKey(res.key);
      keys.reload();
    } catch (e) {
      alert(e.message);
    }
  }

  if (error) return <p style={{ color: "#DC2626" }}>{error.message}</p>;
  if (!data || !draft) return <div style={{ color: "#6B7280", fontSize: 14 }}><Spinner /> Loading…</div>;
  const eff = data.thresholds.effective;

  return (
    <>
      <h2 style={{ marginTop: 0 }}>Settings</h2>
      {msg && <p style={{ color: msg.startsWith("Error") ? "#DC2626" : "#059669", fontSize: 14 }}>{msg}</p>}

      <Card title="Decision thresholds (risk rules)">
        <p style={{ color: "#6B7280", fontSize: 13, marginTop: 0 }}>
          Blank = platform default. Effective now: liveness {eff.liveness.reject}–{eff.liveness.pass},
          face match {eff.faceMatch.reject}–{eff.faceMatch.pass}. Scores below "reject" are rejected,
          between the two go to manual review.
        </p>
        <NumField label="Liveness: reject below" value={draft.livenessReject}
          onChange={(v) => setDraft({ ...draft, livenessReject: v })} hint={`min ${data.thresholds.bounds.liveness.rejectMin}`} />
        <NumField label="Liveness: pass at or above" value={draft.livenessPass}
          onChange={(v) => setDraft({ ...draft, livenessPass: v })} hint={`max ${data.thresholds.bounds.liveness.passMax}`} />
        <NumField label="Face match: reject below" value={draft.faceReject}
          onChange={(v) => setDraft({ ...draft, faceReject: v })} hint={`min ${data.thresholds.bounds.faceMatch.rejectMin}`} />
        <NumField label="Face match: pass at or above" value={draft.facePass}
          onChange={(v) => setDraft({ ...draft, facePass: v })} hint={`max ${data.thresholds.bounds.faceMatch.passMax}`} />
        <NumField label="Max failed attempts before flag" value={draft.maxFailedAttempts} step={1}
          onChange={(v) => setDraft({ ...draft, maxFailedAttempts: v })} />
        <NumField label="Max identities per device (7 days)" value={draft.maxIdentitiesPerDevice} step={1}
          onChange={(v) => setDraft({ ...draft, maxIdentitiesPerDevice: v })} />
        <NumField label="Max sessions per IP per hour" value={draft.maxSessionsPerIpPerHour} step={1}
          onChange={(v) => setDraft({ ...draft, maxSessionsPerIpPerHour: v })} />
        <button onClick={saveThresholds}
          style={{ marginTop: 8, padding: "8px 16px", background: PRIMARY, color: "#fff", border: 0, borderRadius: 6, cursor: "pointer" }}>
          Save thresholds
        </button>
      </Card>

      <Card title="Data retention">
        <NumField label="Raw evidence retention (days)" step={1}
          value={retentionDraft?.rawEvidenceDays ?? null}
          onChange={(v) => setRetentionDraft({ ...retentionDraft, rawEvidenceDays: v })}
          hint={`${data.retention.bounds.rawEvidenceDays.min}–${data.retention.bounds.rawEvidenceDays.max}; effective ${data.retention.effective.rawEvidenceDays}`} />
        <NumField label="Failed-session evidence (days)" step={1}
          value={retentionDraft?.failedSessionDays ?? null}
          onChange={(v) => setRetentionDraft({ ...retentionDraft, failedSessionDays: v })}
          hint={`${data.retention.bounds.failedSessionDays.min}–${data.retention.bounds.failedSessionDays.max}; effective ${data.retention.effective.failedSessionDays}`} />
        <button onClick={saveRetention}
          style={{ marginTop: 8, padding: "8px 16px", background: PRIMARY, color: "#fff", border: 0, borderRadius: 6, cursor: "pointer" }}>
          Save retention
        </button>
      </Card>

      <Card title="API keys">
        {newKey && (
          <div style={{ background: "#FEF3C7", border: "1px solid #FCD34D", padding: 12, borderRadius: 6, fontSize: 13, marginBottom: 12 }}>
            <strong>New key — copy now, it will not be shown again:</strong><br />
            <code style={{ wordBreak: "break-all", display: "block", marginTop: 6 }}>{newKey}</code>
          </div>
        )}

        {/* Create new key form */}
        <CreateKeyForm onCreated={(key) => { setNewKey(key); keys.reload(); }} />

        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 16 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#6B7280", borderBottom: "2px solid #F3F4F6" }}>
              <th style={{ padding: 6 }}>Prefix</th><th>Type</th><th>Env</th><th>Status</th><th>Created</th><th></th>
            </tr>
          </thead>
          <tbody>
            {(keys.data?.keys || []).map((k) => (
              <tr key={k.id} style={{ borderTop: "1px solid #F3F4F6" }}>
                <td style={{ padding: 6 }}><code>{k.prefix}…</code></td>
                <td>{k.keyType}</td>
                <td>{k.isLive ? "🟢 live" : "🧪 test"}</td>
                <td>
                  <span style={{
                    background: k.status === "active" ? "#D1FAE5" : "#FEE2E2",
                    color: k.status === "active" ? "#065F46" : "#991B1B",
                    padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600
                  }}>{k.status}</span>
                </td>
                <td style={{ color: "#6B7280" }}>{String(k.createdAt).slice(0, 10)}</td>
                <td style={{ display: "flex", gap: 6, padding: "6px 0", flexWrap: "wrap", alignItems: "center" }}>
                  {k.status === "active" && (
                    <>
                      <button onClick={() => keyAction(`/v1/settings/api-keys/${k.id}/rotate`)}
                        style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #D1D5DB", background: "#fff", cursor: "pointer", fontSize: 12 }}>
                        Rotate
                      </button>
                      {confirmPending?.id === k.id && confirmPending.action === "revoke" ? (
                        <>
                          <span style={{ fontSize: 12, color: "#DC2626" }}>Revoke?</span>
                          <button onClick={() => { setConfirmPending(null); keyAction(`/v1/settings/api-keys/${k.id}/revoke`); }}
                            style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #DC2626", background: "#DC2626", color: "#fff", cursor: "pointer", fontSize: 12 }}>
                            Yes, revoke
                          </button>
                          <button onClick={() => setConfirmPending(null)}
                            style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #D1D5DB", background: "#fff", cursor: "pointer", fontSize: 12 }}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button onClick={() => setConfirmPending({ id: k.id, action: "revoke" })}
                          style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #FCA5A5", background: "#fff", color: "#DC2626", cursor: "pointer", fontSize: 12 }}>
                          Revoke
                        </button>
                      )}
                    </>
                  )}
                  {k.status === "revoked" && (
                    confirmPending?.id === k.id && confirmPending.action === "delete" ? (
                      <>
                        <span style={{ fontSize: 12, color: "#991B1B" }}>Delete permanently?</span>
                        <button onClick={() => {
                          setConfirmPending(null);
                          api(`/v1/settings/api-keys/${k.id}`, { method: "DELETE" })
                            .then(() => keys.reload())
                            .catch((e) => alert(e.message));
                        }}
                          style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #991B1B", background: "#991B1B", color: "#fff", cursor: "pointer", fontSize: 12 }}>
                          Yes, delete
                        </button>
                        <button onClick={() => setConfirmPending(null)}
                          style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #D1D5DB", background: "#fff", cursor: "pointer", fontSize: 12 }}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button onClick={() => setConfirmPending({ id: k.id, action: "delete" })}
                        style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #FCA5A5", background: "#FEF2F2", color: "#991B1B", cursor: "pointer", fontSize: 12 }}>
                        🗑 Delete
                      </button>
                    )
                  )}
                </td>
              </tr>
            ))}
            {keys.data && keys.data.keys.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 16, textAlign: "center", color: "#9CA3AF" }}>No API keys yet.</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}

// ─── Create API Key Form ──────────────────────────────────────────────────────

function CreateKeyForm({ onCreated }) {
  const [keyType, setKeyType] = useState("secret");
  const [isLive, setIsLive] = useState(false);
  const [busy, setBusy] = useState(false);

  async function create(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api("/v1/settings/api-keys", { method: "POST", body: { keyType, isLive } });
      if (res.key) onCreated(res.key);
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={create} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "10px 0", borderBottom: "1px solid #F3F4F6" }}>
      <select value={keyType} onChange={(e) => setKeyType(e.target.value)}
        style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 13 }}>
        <option value="secret">secret key</option>
        <option value="public">public key</option>
      </select>
      <select value={String(isLive)} onChange={(e) => setIsLive(e.target.value === "true")}
        style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 13 }}>
        <option value="false">🧪 test</option>
        <option value="true">🟢 live</option>
      </select>
      <button type="submit" disabled={busy}
        style={{ padding: "6px 14px", background: PRIMARY, color: "#fff", border: 0, borderRadius: 6, fontSize: 13, cursor: "pointer", opacity: busy ? 0.6 : 1 }}>
        {busy ? "Creating…" : "+ Create key"}
      </button>
    </form>
  );
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

const DELIVERY_STATUS_COLORS = {
  delivered: STATUS_COLORS.approved,
  pending: STATUS_COLORS.manual_review,
  failed: STATUS_COLORS.rejected,
  exhausted: STATUS_COLORS.rejected
};

function Webhooks() {
  const { data, error, reload } = useData("/v1/dashboard/webhook-deliveries");
  const [configUrl, setConfigUrl] = useState("");
  const [configMsg, setConfigMsg] = useState(null);
  const [retrying, setRetrying] = useState(null);
  const [filterStatus, setFilterStatus] = useState("");

  async function saveWebhookUrl(e) {
    e.preventDefault();
    setConfigMsg(null);
    try {
      // Uses the secret key via a server-side call; dashboard shows result only
      const res = await api("/v1/webhooks/config", { method: "PUT", body: { url: configUrl } });
      setConfigMsg({ type: "success", text: `Webhook configured. Signing secret (save now): ${res.secret}` });
      reload();
    } catch (err) {
      setConfigMsg({ type: "error", text: err.message });
    }
  }

  async function retryDelivery(eventId) {
    setRetrying(eventId);
    try {
      await api(`/v1/webhooks/${eventId}/retry`, { method: "POST", body: {} });
      reload();
    } catch (err) {
      alert(err.message);
    } finally {
      setRetrying(null);
    }
  }

  const deliveries = (data?.deliveries || []).filter((d) => !filterStatus || d.status === filterStatus);

  return (
    <>
      <h2 style={{ marginTop: 0 }}>Webhooks</h2>

      {/* Current webhook URL */}
      <Card title="Webhook endpoint">
        {data?.webhookUrl ? (
          <div style={{ marginBottom: 12, fontSize: 13 }}>
            <span style={{ color: "#6B7280" }}>Current URL: </span>
            <code style={{ color: "#374151" }}>{data.webhookUrl}</code>
          </div>
        ) : (
          <p style={{ color: "#9CA3AF", fontSize: 13, marginTop: 0 }}>No webhook URL configured yet.</p>
        )}
        <form onSubmit={saveWebhookUrl} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            type="url"
            placeholder="https://your-server.com/webhook"
            value={configUrl}
            onChange={(e) => setConfigUrl(e.target.value)}
            style={{ flex: 1, minWidth: 240, padding: 8, borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 13 }}
          />
          <button type="submit" style={{ padding: "8px 16px", background: PRIMARY, color: "#fff", border: 0, borderRadius: 6, cursor: "pointer", fontSize: 13 }}>
            Save & rotate secret
          </button>
        </form>
        {configMsg && (
          <div style={{
            marginTop: 10, padding: 10, borderRadius: 6, fontSize: 13, wordBreak: "break-all",
            background: configMsg.type === "success" ? "#ECFDF5" : "#FEF2F2",
            color: configMsg.type === "success" ? "#065F46" : "#991B1B",
            border: `1px solid ${configMsg.type === "success" ? "#6EE7B7" : "#FECACA"}`
          }}>
            {configMsg.text}
          </div>
        )}
        <p style={{ color: "#9CA3AF", fontSize: 12, margin: "10px 0 0" }}>
          Saving rotates the signing secret. Store the new secret immediately — it is not shown again.
          Verify signatures using <code>HMAC-SHA256</code> on the raw request body with the <code>X-VP-Signature</code> header.
        </p>
      </Card>

      {/* Delivery log */}
      <Card title={`Delivery log ${data ? `(${data.deliveries.length} total)` : ""}`}>
        <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}
            style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 13 }}>
            <option value="">All statuses</option>
            <option value="delivered">Delivered</option>
            <option value="pending">Pending</option>
            <option value="failed">Failed</option>
            <option value="exhausted">Exhausted</option>
          </select>
          <button onClick={reload} style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #D1D5DB", background: "#fff", fontSize: 13, cursor: "pointer" }}>
            ↻ Refresh
          </button>
        </div>

        {error && <p style={{ color: "#DC2626", fontSize: 13 }}>{error.message}</p>}
        {!data && <div style={{ color: "#6B7280", fontSize: 14 }}><Spinner /> Loading…</div>}

        {data && deliveries.length === 0 && (
          <p style={{ color: "#9CA3AF", fontSize: 13, textAlign: "center", padding: "16px 0" }}>
            {filterStatus ? `No ${filterStatus} deliveries.` : "No webhook deliveries yet. Events will appear here after sessions complete."}
          </p>
        )}

        {deliveries.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6B7280", borderBottom: "2px solid #F3F4F6" }}>
                <th style={{ padding: "6px 8px" }}>Event</th>
                <th style={{ padding: "6px 8px" }}>Status</th>
                <th style={{ padding: "6px 8px" }}>Attempts</th>
                <th style={{ padding: "6px 8px" }}>HTTP</th>
                <th style={{ padding: "6px 8px" }}>Delivered / Next</th>
                <th style={{ padding: "6px 8px" }}></th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.eventId} style={{ borderTop: "1px solid #F3F4F6" }}>
                  <td style={{ padding: "8px 8px" }}>
                    <span style={{ fontWeight: 500 }}>{d.event}</span><br />
                    <code style={{ color: "#9CA3AF", fontSize: 10 }}>{d.eventId}</code>
                  </td>
                  <td style={{ padding: "8px 8px" }}>
                    <span style={{
                      background: (DELIVERY_STATUS_COLORS[d.status] || "#6B7280") + "22",
                      color: DELIVERY_STATUS_COLORS[d.status] || "#6B7280",
                      padding: "2px 7px", borderRadius: 999, fontSize: 11, fontWeight: 600
                    }}>{d.status}</span>
                  </td>
                  <td style={{ padding: "8px 8px", textAlign: "center" }}>{d.attempts}</td>
                  <td style={{ padding: "8px 8px" }}>
                    {d.lastStatusCode ? (
                      <span style={{ color: d.lastStatusCode >= 200 && d.lastStatusCode < 300 ? STATUS_COLORS.approved : STATUS_COLORS.rejected, fontWeight: 600 }}>
                        {d.lastStatusCode}
                      </span>
                    ) : "—"}
                  </td>
                  <td style={{ padding: "8px 8px", color: "#6B7280", fontSize: 11 }}>
                    {d.deliveredAt
                      ? d.deliveredAt.slice(0, 16).replace("T", " ")
                      : d.nextAttemptAt
                      ? `next: ${d.nextAttemptAt.slice(0, 16).replace("T", " ")}`
                      : "—"}
                    {d.lastError && (
                      <div style={{ color: "#DC2626", marginTop: 2, fontSize: 10 }} title={d.lastError}>
                        {d.lastError.slice(0, 40)}{d.lastError.length > 40 ? "…" : ""}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: "8px 8px" }}>
                    {["failed", "exhausted"].includes(d.status) && (
                      <button
                        disabled={retrying === d.eventId}
                        onClick={() => retryDelivery(d.eventId)}
                        style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #D1D5DB", background: "#fff", fontSize: 12, cursor: "pointer" }}>
                        {retrying === d.eventId ? "…" : "Retry"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
