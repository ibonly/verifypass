import { useCallback, useEffect, useState } from "react";
import { api, apiDownload, setAuth, getToken } from "./api";

const PRIMARY = "#6D28D9";
const STATUS_COLORS = {
  approved: "#059669", rejected: "#DC2626", manual_review: "#D97706",
  submitted: "#2563EB", started: "#6B7280", created: "#6B7280",
  expired: "#9CA3AF", failed: "#DC2626", abandoned: "#9CA3AF"
};

export default function App() {
  const [user, setUser] = useState(null);
  const [view, setView] = useState("overview");

  if (!getToken() || !user) return <Login onLogin={setUser} />;

  const views = {
    overview: <Overview />,
    sessions: <Sessions />,
    review: <ReviewQueue />,
    reports: <Reports />,
    settings: <Settings />,
    webhooks: <Webhooks />
  };

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <nav style={{ width: 200, background: "#111827", color: "#D1D5DB", padding: 16 }}>
        <h3 style={{ color: "#fff", margin: "0 0 20px" }}>VerifyPass</h3>
        {Object.keys(views).map((v) => (
          <div key={v}
            onClick={() => setView(v)}
            style={{
              padding: "8px 10px", borderRadius: 6, marginBottom: 4, cursor: "pointer",
              background: view === v ? PRIMARY : "transparent",
              color: view === v ? "#fff" : "#D1D5DB", textTransform: "capitalize"
            }}>
            {v === "review" ? "Manual review" : v}
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
      <main style={{ flex: 1, padding: 24, maxWidth: 1000 }}>{views[view]}</main>
    </div>
  );
}

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

  const input = { width: "100%", padding: 10, marginBottom: 10, borderRadius: 6, border: "1px solid #D1D5DB" };
  return (
    <div style={{ maxWidth: 360, margin: "12vh auto" }}>
      <h2>Sign in to VerifyPass</h2>
      <form onSubmit={submit}>
        <input style={input} placeholder="Email" value={form.email} onChange={set("email")} />
        <input style={input} type="password" placeholder="Password" value={form.password} onChange={set("password")} />
        <input style={input} placeholder="TOTP code (if enrolled)" value={form.totp} onChange={set("totp")} />
        <input style={input} placeholder="Tenant ID (super admin only)" value={form.tenant} onChange={set("tenant")} />
        {error && <p style={{ color: "#DC2626", fontSize: 14 }}>{error}</p>}
        <button type="submit" style={{ width: "100%", padding: 12, background: PRIMARY, color: "#fff", border: 0, borderRadius: 6, fontSize: 16 }}>
          Sign in
        </button>
      </form>
    </div>
  );
}

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
  return (
    <span style={{
      background: (STATUS_COLORS[status] || "#6B7280") + "22",
      color: STATUS_COLORS[status] || "#6B7280",
      padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600
    }}>{status}</span>
  );
}

function Card({ title, children }) {
  return (
    <div style={{ background: "#fff", borderRadius: 10, padding: 16, marginBottom: 16, boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}>
      {title && <h3 style={{ margin: "0 0 12px" }}>{title}</h3>}
      {children}
    </div>
  );
}

function Overview() {
  const { data, error } = useData("/v1/dashboard/stats");
  if (error) return <p style={{ color: "#DC2626" }}>{error.message}</p>;
  if (!data) return <p>Loading…</p>;
  const stat = (label, value, color) => (
    <div style={{ flex: 1, background: "#fff", borderRadius: 10, padding: 16, textAlign: "center" }}>
      <div style={{ fontSize: 28, fontWeight: 700, color: color || "#111827" }}>{value ?? 0}</div>
      <div style={{ fontSize: 13, color: "#6B7280" }}>{label}</div>
    </div>
  );
  return (
    <>
      <h2>Overview</h2>
      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        {stat("Total", data.total)}
        {stat("Approved", data.byStatus.approved, STATUS_COLORS.approved)}
        {stat("Rejected", data.byStatus.rejected, STATUS_COLORS.rejected)}
        {stat("In review", data.byStatus.manual_review, STATUS_COLORS.manual_review)}
      </div>
      <Card>
        Average completion time: {data.avgCompletionSeconds != null ? `${data.avgCompletionSeconds}s` : "—"}
      </Card>
    </>
  );
}

function Sessions() {
  const [status, setStatus] = useState("");
  const { data, error } = useData(`/v1/dashboard/sessions${status ? `?status=${status}` : ""}`, [status]);
  return (
    <>
      <h2>Sessions</h2>
      <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ padding: 8, marginBottom: 12, borderRadius: 6 }}>
        <option value="">All statuses</option>
        {Object.keys(STATUS_COLORS).map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      {error && <p style={{ color: "#DC2626" }}>{error.message}</p>}
      <Card>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#6B7280" }}>
              <th style={{ padding: 8 }}>Session</th><th>Customer ref</th><th>Status</th><th>Risk</th><th>Created</th>
            </tr>
          </thead>
          <tbody>
            {(data?.sessions || []).map((s) => (
              <tr key={s.sessionId} style={{ borderTop: "1px solid #F3F4F6" }}>
                <td style={{ padding: 8, fontFamily: "monospace", fontSize: 12 }}>{s.sessionId}</td>
                <td>{s.customerReference || "—"}</td>
                <td><StatusPill status={s.status} /></td>
                <td>{s.riskLevel || "—"}</td>
                <td style={{ color: "#6B7280" }}>{s.createdAt?.slice(0, 16).replace("T", " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function ReviewQueue() {
  const { data, error, reload } = useData("/v1/manual-review");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(null);

  async function decideCase(sessionId, decision) {
    setBusy(sessionId);
    try {
      await api(`/v1/manual-review/${sessionId}/decision`, { method: "POST", body: { decision, note } });
      setNote("");
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
      <h2>Manual review</h2>
      {(data?.cases || []).length === 0 && <Card>No cases waiting for review. 🎉</Card>}
      {(data?.cases || []).map((c) => (
        <Card key={c.sessionId} title={c.customerReference || c.sessionId}>
          <div style={{ display: "flex", gap: 24, marginBottom: 12, fontSize: 14 }}>
            <div>Liveness: <b>{c.scores?.liveness ?? "—"}</b></div>
            <div>Face match: <b>{c.scores?.faceMatch ?? "—"}</b></div>
            <div>OCR: <b>{c.scores?.ocrConfidence ?? "—"}</b></div>
            <div>Reasons: <b>{c.reasonCodes.join(", ") || "—"}</b></div>
          </div>
          {c.extractedData && (
            <pre style={{ background: "#F9FAFB", padding: 8, borderRadius: 6, fontSize: 12, overflow: "auto" }}>
              {JSON.stringify(c.extractedData, null, 2)}
            </pre>
          )}
          <input
            placeholder="Review note (recorded in audit log)"
            value={note} onChange={(e) => setNote(e.target.value)}
            style={{ width: "100%", padding: 8, marginBottom: 8, borderRadius: 6, border: "1px solid #D1D5DB" }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={busy === c.sessionId} onClick={() => decideCase(c.sessionId, "approved")}
              style={{ padding: "8px 16px", background: STATUS_COLORS.approved, color: "#fff", border: 0, borderRadius: 6 }}>Approve</button>
            <button disabled={busy === c.sessionId} onClick={() => decideCase(c.sessionId, "rejected")}
              style={{ padding: "8px 16px", background: STATUS_COLORS.rejected, color: "#fff", border: 0, borderRadius: 6 }}>Reject</button>
            <button disabled={busy === c.sessionId} onClick={() => decideCase(c.sessionId, "recapture")}
              style={{ padding: "8px 16px", background: "#fff", color: "#111827", border: "1px solid #D1D5DB", borderRadius: 6 }}>Request recapture</button>
          </div>
        </Card>
      ))}
    </>
  );
}

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
      <h2>Reports</h2>
      <div style={{ marginBottom: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ padding: 8, borderRadius: 6 }}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
        {["volume", "rejection-reasons", "risk-events", "audit-log", "webhook-failures"].map((n) => (
          <button key={n} onClick={dl(n)}
            style={{ padding: "8px 12px", borderRadius: 6, border: "1px solid #D1D5DB", background: "#fff", fontSize: 13 }}>
            ⬇ {n}.csv
          </button>
        ))}
      </div>

      <Card title="Daily volume">
        {(volume.data?.days || []).length === 0 && <p style={{ color: "#6B7280" }}>No sessions in this window.</p>}
        {(volume.data?.days || []).map((d) => (
          <div key={d.date} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, fontSize: 13 }}>
            <span style={{ width: 84, color: "#6B7280" }}>{d.date}</span>
            <div style={{ flex: 1, display: "flex", height: 16, borderRadius: 4, overflow: "hidden", background: "#F3F4F6" }}>
              <div style={{ width: `${(d.approved / maxTotal) * 100}%`, background: STATUS_COLORS.approved }} />
              <div style={{ width: `${(d.manual_review / maxTotal) * 100}%`, background: STATUS_COLORS.manual_review }} />
              <div style={{ width: `${(d.rejected / maxTotal) * 100}%`, background: STATUS_COLORS.rejected }} />
            </div>
            <span style={{ width: 40, textAlign: "right" }}>{d.total}</span>
          </div>
        ))}
      </Card>

      <Card title="Top rejection / review reasons">
        {(reasons.data?.reasons || []).length === 0 && <p style={{ color: "#6B7280" }}>None in this window. 🎉</p>}
        {(reasons.data?.reasons || []).map((r) => (
          <div key={r.reasonCode} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #F3F4F6", fontSize: 14 }}>
            <code>{r.reasonCode}</code><b>{r.count}</b>
          </div>
        ))}
      </Card>
    </>
  );
}

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
  if (!data || !draft) return <p>Loading…</p>;
  const eff = data.thresholds.effective;

  return (
    <>
      <h2>Settings</h2>
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
          style={{ marginTop: 8, padding: "8px 16px", background: PRIMARY, color: "#fff", border: 0, borderRadius: 6 }}>
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
          style={{ marginTop: 8, padding: "8px 16px", background: PRIMARY, color: "#fff", border: 0, borderRadius: 6 }}>
          Save retention
        </button>
      </Card>

      <Card title="API keys">
        {newKey && (
          <p style={{ background: "#FEF3C7", padding: 10, borderRadius: 6, fontSize: 13 }}>
            New key (copy now — it will not be shown again):<br />
            <code style={{ wordBreak: "break-all" }}>{newKey}</code>
          </p>
        )}
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#6B7280" }}>
              <th style={{ padding: 6 }}>Prefix</th><th>Type</th><th>Env</th><th>Status</th><th>Created</th><th></th>
            </tr>
          </thead>
          <tbody>
            {(keys.data?.keys || []).map((k) => (
              <tr key={k.id} style={{ borderTop: "1px solid #F3F4F6" }}>
                <td style={{ padding: 6 }}><code>{k.prefix}…</code></td>
                <td>{k.keyType}</td>
                <td>{k.isLive ? "live" : "test"}</td>
                <td><StatusPill status={k.status === "active" ? "approved" : "rejected"} /> {k.status}</td>
                <td style={{ color: "#6B7280" }}>{String(k.createdAt).slice(0, 10)}</td>
                <td>
                  {k.status === "active" && (
                    <>
                      <button onClick={() => keyAction(`/v1/settings/api-keys/${k.id}/rotate`)}
                        style={{ marginRight: 6, padding: "4px 10px", borderRadius: 6, border: "1px solid #D1D5DB", background: "#fff" }}>
                        Rotate
                      </button>
                      <button onClick={() => window.confirm("Revoke this key? Integrations using it will stop working.") && keyAction(`/v1/settings/api-keys/${k.id}/revoke`)}
                        style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #FCA5A5", background: "#fff", color: "#DC2626" }}>
                        Revoke
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function Webhooks() {
  return (
    <>
      <h2>Webhooks</h2>
      <Card title="Delivery log">
        <p style={{ color: "#6B7280", fontSize: 14 }}>
          Webhook configuration and delivery history are managed via the server
          API with your secret key (<code>PUT /v1/webhooks/config</code>,{" "}
          <code>GET /v1/webhooks/deliveries</code>, <code>POST /v1/webhooks/:eventId/retry</code>) —
          see the developer docs. A dashboard view backed by user-session auth
          lands with the observability work in M5.
        </p>
      </Card>
    </>
  );
}
