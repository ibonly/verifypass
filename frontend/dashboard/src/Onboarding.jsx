import { useEffect, useState } from "react";
import { api } from "./api";
import "./onboarding.css";

const STEPS = [
  ["profile", "Your business", "Tell us what you’re building"],
  ["security", "Account security", "Protect your workspace"],
  ["keys", "Connect your app", "Create your test credentials"],
  ["delivery", "Receive results", "Choose how results reach you"],
  ["policies", "Review policies", "Set your evidence and review rules"],
  ["verification", "First verification", "Try the complete customer journey"],
  ["finish", "Ready to build", "Review your setup"]
];
const TYPE_LABELS = { ID_AND_FACE: "ID document + face", FACE_ONLY: "Face + liveness", ID_ONLY: "ID document only" };
export default function Onboarding({ onExit, onSelectSession }) {
  const [data, setData] = useState(null);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({ companyName: "", contactEmail: "", integration: "hosted", verificationType: "ID_AND_FACE", domains: "" });
  const [retention, setRetention] = useState({ rawEvidenceDays: 30, failedSessionDays: 7 });
  const [dual, setDual] = useState(false);
  const [method, setMethod] = useState("polling");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState(null);
  const [issued, setIssued] = useState({});
  const [mfa, setMfa] = useState(null);
  const [code, setCode] = useState("");
  const [session, setSession] = useState(null);
  const [loaded, setLoaded] = useState(false);
  async function reload() { const next = await api("/v1/onboarding"); setData(next); return next; }
  useEffect(() => {
    let active = true;
    Promise.all([api("/v1/onboarding"), api("/v1/auth/me")]).then(([d, me]) => {
      if (!active) return;
      setData(d); setForm({ companyName: d.profile?.companyName || d.tenant.companyName, contactEmail: d.profile?.contactEmail || me.email, integration: d.profile?.integration || "hosted", verificationType: d.profile?.verificationType || "ID_AND_FACE", domains: d.profile?.allowedDomains?.join("\n") || "" });
      setRetention(d.policies.retention.effective); setDual(d.dualApproval); setMethod(d.deliveryMethod || (d.webhookUrl ? "webhook" : "polling")); setUrl(d.webhookUrl);
      const first = STEPS.findIndex(([id]) => id !== "finish" && !d.steps[id]);
      setStep(d.completedAt && d.ready ? 6 : first < 0 ? 6 : first); setLoaded(true);
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);
  async function run(fn) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const save = (path, body) => api(`/v1/onboarding/${path}`, { method: "PUT", body });
  const advance = () => { setStep(s => Math.min(6, s + 1)); setError(""); setNotice(""); };
  const field = name => ({ value: form[name], onChange: e => setForm({ ...form, [name]: e.target.value }) });
  async function copy(value) { try { await navigator.clipboard.writeText(value); setNotice("Copied to clipboard."); } catch (_) { setError("Clipboard unavailable. Select and copy the value manually."); } }
  if (!loaded) return <section className="vp-setup"><h1>Set up your workspace</h1>{error ? <div role="alert" className="vp-error">{error}<button onClick={() => window.location.reload()}>Retry</button></div> : <p role="status">Loading your setup…</p>}</section>;
  const count = Object.values(data.steps).filter(Boolean).length;
  const current = STEPS[step][0];
  const serverExample = `// Run on your server. Keep your secret API key out of browser code.\nconst response = await fetch("${__VP_API_BASE__}/v1/verification-sessions", {\n  method: "POST",\n  headers: {\n    Authorization: "Bearer " + process.env.VERIFYPASS_SECRET_KEY,\n    "Content-Type": "application/json"\n  },\n  body: JSON.stringify({\n    customerReference: "customer-123",\n    verificationType: "${data.profile?.verificationType || "ID_AND_FACE"}"\n  })\n});\nif (!response.ok) throw new Error("Session creation failed");\nconst session = await response.json();\n// Send session.hostedUrl to the customer, or pass the session to your SDK.`;
  const browserExample = data.profile?.integration === "react"
    ? `import { VerifyPassProvider, VerificationWidget } from "@verifypass/react";\n\n// Get session from your server; never create it with a secret key here.\n<VerifyPassProvider publicKey="YOUR_PUBLIC_TEST_KEY"\n  faceModelUrl="/models/fr_detect.onnx">\n  <VerificationWidget sessionId={session.sessionId} sdkToken={session.sdkToken}\n    onComplete={(result) => console.log(result)} />\n</VerifyPassProvider>`
    : `// Load your built dist/verifypass.js bundle first.\nVerifyPass.init({\n  publicKey: "YOUR_PUBLIC_TEST_KEY",\n  sessionId: session.sessionId,\n  sdkToken: session.sdkToken,\n  container: "#verification",\n  onComplete: (result) => console.log(result)\n});`;
  return <section className="vp-setup">
    <header className="vp-setup-header"><div><span className="vp-eyebrow">WORKSPACE SETUP · {data.tenant.status.toUpperCase()}</span><h1>Let’s get your first verification running.</h1><p className="vp-muted">{data.tenant.companyName} · Saved steps follow your workspace. Save this step before leaving.</p></div><button className="vp-secondary" onClick={onExit} disabled={busy}>Continue later</button></header>
    <div className="vp-progress-label"><span>{count} of 6 setup tasks complete</span><span>{Math.round(count / 6 * 100)}%</span></div><progress max="6" value={count} aria-label="Setup progress" />
    <div className="vp-setup-layout"><nav className="vp-steps" aria-label="Onboarding steps">{STEPS.map(([id, title], i) => <button key={id} aria-current={step === i ? "step" : undefined} className={step === i ? "active" : ""} disabled={busy} onClick={() => { setStep(i); setError(""); setNotice(""); }}><span className={data.steps[id] || (id === "finish" && data.completedAt) ? "done" : ""}>{data.steps[id] || (id === "finish" && data.completedAt) ? "✓" : i + 1}</span>{title}</button>)}</nav>
      <article className="vp-panel"><span className="vp-eyebrow">STEP {step + 1} OF 7</span><h2>{STEPS[step][1]}</h2><p className="vp-muted">{STEPS[step][2]}</p>
        {error && <div className="vp-error" role="alert">{error}</div>}{notice && <div className="vp-success" role="status">{notice}</div>}
        <fieldset disabled={busy}>
        {current === "profile" && <form onSubmit={e => { e.preventDefault(); run(async () => { setData(await save("profile", { ...form, allowedDomains: form.domains.split(/[\n,]/).map(s => s.trim()).filter(Boolean) })); advance(); }); }}>
          <div className="vp-form-grid"><label>Business name<input required minLength={2} maxLength={120} autoComplete="organization" {...field("companyName")} /></label><label>Contact email<input required type="email" maxLength={254} autoComplete="email" {...field("contactEmail")} /></label></div>
          <label>What do you need to verify?<select {...field("verificationType")}>{Object.entries(TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label>How will customers verify?<select {...field("integration")}><option value="hosted">Hosted verification link</option><option value="react">React widget</option><option value="javascript">JavaScript SDK</option></select><small>A hosted link is the quickest way to try the complete flow.</small></label>
          <label>Browser domains {form.integration === "hosted" && "(optional)"}<textarea {...field("domains")} placeholder={"app.example.com\nlocalhost"} rows={3} /><small>One hostname per line, without https://, ports, or paths. These domains and their subdomains can use public SDK keys.</small></label>
          <button className="vp-primary">Save business details & continue</button>
        </form>}
        {current === "security" && <>
          <p>Use an authenticator app to add a second sign-in check for your account.</p>
          {data.mfaEnrolled ? <div className="vp-success">Two-factor authentication is enabled for your account.</div> : mfa ? <form onSubmit={e => { e.preventDefault(); run(async () => { await api("/v1/auth/mfa/confirm", { method: "POST", body: { secret: mfa.secret, totp: code } }); setMfa(null); setCode(""); await reload(); setNotice("Two-factor authentication enabled."); }); }}>
            <p>Add a new time-based account in your authenticator and enter this setup key.</p><label>Authenticator setup key<input readOnly value={mfa.secret} /></label><button type="button" className="vp-secondary" onClick={() => copy(mfa.secret)}>Copy setup key</button>
            <label>Six-digit code<input required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={e => setCode(e.target.value)} /></label><button className="vp-primary">Verify & enable</button>
          </form> : <button className="vp-primary" onClick={() => run(async () => setMfa(await api("/v1/auth/mfa/enroll", { method: "POST", body: {} })))}>Set up authenticator</button>}
          <div className="vp-actions">{data.mfaEnrolled ? <button className="vp-primary" onClick={advance}>Continue</button> : <button className="vp-secondary" onClick={() => run(async () => { setData(await save("security", { choice: "later" })); setMfa(null); advance(); })}>Set up later</button>}</div><p className="vp-muted"><small>You can return to this step to enable two-factor authentication.</small></p>
        </>}
        {current === "keys" && <>
          <p>Create test credentials for your integration. Secret keys belong on your server. Public keys identify your browser SDK.</p>
          {["secret", ...(data.profile?.integration === "hosted" ? [] : ["public"])].map(type => <div className="vp-key-card" key={type}><strong>{type === "secret" ? "Server secret key" : "Browser public key"}</strong><span className="vp-badge">TEST</span>
            {issued[type] ? <><label>Save this key now — shown only during this visit<input readOnly value={issued[type]} /></label><button className="vp-secondary" onClick={() => copy(issued[type])}>Copy key</button></> : data.keyTypes.includes(type) ? <p className="vp-success">An active test key is available. Use Settings to rotate it if you no longer have the value.</p> : <div className="vp-actions"><button className="vp-primary" onClick={() => run(async () => { const k = await api("/v1/settings/api-keys", { method: "POST", body: { keyType: type, isLive: false } }); setIssued(old => ({ ...old, [type]: k.key })); await reload(); })}>Create {type} test key</button></div>}</div>)}
          <details><summary>Server integration example</summary><pre>{serverExample}</pre><button className="vp-secondary" onClick={() => copy(serverExample)}>Copy example</button><p>For embedded integrations, pass the returned sessionId and sdkToken to the SDK, along with your public key. Credentials shown above are never inserted into this example.</p></details>
          {data.profile?.integration !== "hosted" && <details><summary>{data.profile?.integration === "react" ? "React widget example" : "JavaScript widget example"}</summary><pre>{browserExample}</pre><button className="vp-secondary" onClick={() => copy(browserExample)}>Copy widget example</button><p className="vp-muted">Use the SDK packages included in this repository. For React, serve fr_detect.onnx and fr_landmark.onnx from /models/ as the sample app does. Use HTTPS or localhost for camera access.</p></details>}
          <div className="vp-actions"><button className="vp-primary" disabled={!data.steps.keys} onClick={advance}>I’ve saved my credentials · Continue</button></div>
        </>}
        {current === "delivery" && <>
          <label>Result delivery<select value={method} onChange={e => setMethod(e.target.value)}><option value="polling">Poll results from my server</option><option value="webhook">Send results to a webhook</option></select></label>
          {method === "polling" ? <><p>Your server can request the result endpoint until the verification reaches approved, rejected, or manual_review.</p><pre>GET /v1/verification-sessions/:sessionId/result{"\n"}Authorization: Bearer YOUR_SECRET_KEY</pre><p className="vp-muted">Keep this request on your server and use a delay between checks.</p></> : <>
            <form onSubmit={e => { e.preventDefault(); run(async () => { const r = await save("webhook", { url }); setSecret(r.secret); await reload(); }); }}><label>HTTPS endpoint<input type="url" required value={url} onChange={e => setUrl(e.target.value)} placeholder="https://api.example.com/verifypass/webhook" /></label><button className="vp-secondary">{data.webhookUrl ? "Save & rotate signing secret" : "Save webhook endpoint"}</button></form>
            {secret && <div className="vp-key-card"><label>Signing secret — save now<input readOnly value={secret} /></label><button className="vp-secondary" onClick={() => copy(secret)}>Copy signing secret</button></div>}
            <p>Validate X-Verifypass-Signature (sha256=…) using HMAC-SHA256 over timestamp.rawBody with X-Verifypass-Timestamp. Reject timestamps older than five minutes. Use the first verification to check delivery in Webhooks.</p><p className="vp-muted">Saving a new endpoint rotates the signing secret. Update your receiver before testing. A saved URL does not confirm successful delivery.</p>
          </>}
          <div className="vp-actions"><button className="vp-primary" onClick={() => run(async () => { setData(await save("delivery", { method })); advance(); })}>Save delivery choice & continue</button></div>
        </>}
        {current === "policies" && <form onSubmit={e => { e.preventDefault(); run(async () => { setData(await save("policies", { retention, dualApproval: dual })); advance(); }); }}>
          <p>Choose how long verification evidence stays available to your team. These settings apply to your workspace.</p><div className="vp-form-grid">{[["rawEvidenceDays", "Evidence retention (days)"], ["failedSessionDays", "Failed-session retention (days)"]].map(([key, label]) => <label key={key}>{label}<input required type="number" min={data.policies.retention.bounds[key].min} max={data.policies.retention.bounds[key].max} value={retention[key]} onChange={e => setRetention({ ...retention, [key]: e.target.value === "" ? "" : Number(e.target.value) })} /></label>)}</div>
          <label className="vp-check"><input type="checkbox" checked={dual} onChange={e => setDual(e.target.checked)} />Require two different reviewers to approve a manual decision</label><p className="vp-muted">If enabled, arrange a second reviewer account with your administrator before processing reviews.</p>
          <div className="vp-note">Default verification thresholds remain active. You can tune them later in Settings. ID extraction provides review information; it does not verify an identity against a government database.</div><button className="vp-primary">Save policies & continue</button>
        </form>}
        {current === "verification" && <>
          <p>Open a hosted verification to experience {TYPE_LABELS[data.profile?.verificationType] || "your selected flow"}. Use a consenting tester: sandbox checks still process real submitted images.</p>
          <button className="vp-primary" disabled={!data.steps.profile} onClick={() => run(async () => setSession(await api("/v1/onboarding/verification", { method: "POST", body: {} })))}>{session ? "Create another test verification" : "Create test verification"}</button>
          {session && <div className="vp-key-card"><p>Session: <code>{session.sessionId}</code></p><p>Link expires {new Date(session.expiresAt).toLocaleString()}.</p><a className="vp-primary" href={session.hostedUrl} target="_blank" rel="noopener noreferrer">Open verification ↗</a><p className="vp-muted">Return here after submitting. Keep this session link private.</p></div>}
          {data.verification && <div className="vp-success">A test reached <strong>{data.verification.status.replaceAll("_", " ")}</strong>. <button className="vp-link" onClick={() => onSelectSession(data.verification.sessionId)}>Review result</button></div>}
          <div className="vp-actions"><button className="vp-secondary" onClick={() => run(async () => { const next = await reload(); setNotice(next.steps.verification ? "Your test result is ready." : "No completed test result yet. Finish capture and allow the worker to process it, then check again."); })}>Check for result</button><button className="vp-primary" disabled={!data.steps.verification} onClick={advance}>Continue to review</button></div>
          <p className="vp-muted">Approved, rejected, and manual-review results all demonstrate a completed processing cycle. A failed or expired session can be retried with a new link.</p>
        </>}
        {current === "finish" && <>
          {data.completedAt && data.ready ? <div className="vp-success"><strong>Your workspace setup is complete.</strong><p>You can revisit any step as your integration changes.</p></div> : <p>Check each item below before finishing your setup.</p>}
          <ul className="vp-readiness">{STEPS.slice(0, 6).map(([id, title], i) => <li key={id}><span>{data.steps[id] ? "✓" : "○"} {title}</span><button className="vp-link" onClick={() => setStep(i)}>{data.steps[id] ? "Review" : "Complete"}</button></li>)}</ul>
          <div className="vp-note">{data.tenant.status === "sandbox" ? "Your workspace remains in sandbox. Contact the platform administrator for production activation; then create live keys in Settings and validate your live domains and result delivery." : "This checklist validates your test setup. Review live keys, browser domains, result delivery, and reviewer access before sending production traffic."}{!data.mfaEnrolled && <p>Two-factor authentication has been deferred. Enable it in Account security when ready.</p>}</div>
          <div className="vp-actions"><button className="vp-secondary" onClick={() => run(reload)}>Refresh readiness</button><button className="vp-primary" disabled={!data.ready} onClick={() => run(async () => { const done = await api("/v1/onboarding/complete", { method: "POST", body: {} }); setData(done); setNotice("Workspace setup complete. You can now open your dashboard."); })}>{data.completedAt ? "Confirm setup" : "Finish workspace setup"}</button>{data.completedAt && <button className="vp-secondary" onClick={onExit}>Open dashboard</button>}</div>
        </>}
        </fieldset>
        {step > 0 && <div className="vp-back"><button className="vp-link" disabled={busy} onClick={() => { setStep(step - 1); setError(""); }}>← Back</button></div>}
        {busy && <p role="status" className="vp-muted">Saving your changes…</p>}
      </article>
    </div>
  </section>;
}
