import { useState } from "react";
import { api, setAuth } from "./api";
import "./onboarding.css";

export default function Auth({ onLogin }) {
  const [signup, setSignup] = useState(false);
  const [form, setForm] = useState({ companyName: "", email: "", password: "", confirm: "", totp: "", tenant: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const field = name => ({ value: form[name], onChange: e => setForm({ ...form, [name]: e.target.value }) });
  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setError("");
    if (signup && form.password !== form.confirm) { setError("Passwords do not match."); return; }
    setBusy(true);
    try {
      const res = await api(`/v1/auth/${signup ? "register" : "login"}`, { method: "POST", body: {
        email: form.email.trim(), password: form.password,
        ...(signup ? { companyName: form.companyName } : { totp: form.totp })
      } });
      setAuth(res.token, !signup && res.role === "super_admin" ? form.tenant.trim() : null);
      onLogin({ email: res.email, role: res.role, mfaEnrolled: res.mfaEnrolled });
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return <main className="vp-auth vp-setup">
    <aside className="vp-auth-story"><div className="vp-brand">◈ VerifyPass</div><span className="vp-eyebrow">YOUR FIRST VERIFICATION STARTS HERE</span>
      <h1>Know who’s on the other side.</h1><p>Bring identity checks, liveness verification, and your review team into one workspace.</p>
      <ol><li>Create your business workspace</li><li>Connect your verification flow</li><li>Run a test and review the result</li></ol>
      <small>Start in sandbox. Activate production separately when your integration is ready.</small>
    </aside>
    <section className="vp-auth-form"><div className="vp-eyebrow">{signup ? "LET’S GET YOU SET UP" : "WELCOME BACK"}</div>
      <h1>{signup ? "Create your workspace" : "Sign in to VerifyPass"}</h1>
      <p className="vp-muted">{signup ? "You’ll be the administrator of your business workspace." : "Continue to your workspace and verification activity."}</p>
      <form onSubmit={submit}><fieldset disabled={busy}>
        {signup && <label>Business name<input required minLength={2} maxLength={120} autoComplete="organization" {...field("companyName")} /></label>}
        <label>Work email<input required type="email" maxLength={254} autoComplete="username" {...field("email")} /></label>
        <label>Password<input required type="password" minLength={signup ? 12 : undefined} maxLength={128} autoComplete={signup ? "new-password" : "current-password"} {...field("password")} />{signup && <small>Use 12–128 characters.</small>}</label>
        {signup ? <label>Confirm password<input required type="password" autoComplete="new-password" {...field("confirm")} /></label> : <>
          <label>Authenticator code <span className="vp-muted">(if enabled)</span><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} {...field("totp")} /></label>
          <details><summary>Platform administrator access</summary><label>Tenant ID<input {...field("tenant")} placeholder="tnt_…" /></label></details>
        </>}
        {error && <div className="vp-error" role="alert">{error}</div>}
        <button className="vp-primary vp-wide" type="submit">{busy ? "Please wait…" : signup ? "Create sandbox workspace" : "Sign in"}</button>
      </fieldset></form>
      <p>{signup ? "Already have an account?" : "New to VerifyPass?"} <button className="vp-link" disabled={busy} onClick={() => { setSignup(!signup); setError(""); setForm({ ...form, password: "", confirm: "", totp: "", tenant: "" }); }}>{signup ? "Sign in" : "Create a workspace"}</button></p>
      {!signup && <p className="vp-muted"><small>Need access or a password reset? Contact your workspace administrator.</small></p>}
    </section>
  </main>;
}
