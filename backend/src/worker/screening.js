"use strict";

// Sanctions/PEP screening readiness (CBN-aligned CDD; skill §4).
//
// Pluggable, DEFAULT OFF:
//   SCREENING_BACKEND=none      (default) — no screening, result recorded as
//                                {performed:false} so audits show it was off.
//   SCREENING_BACKEND=webhook   — POST {fullName, customerReference} to
//                                SCREENING_WEBHOOK_URL (Bearer
//                                SCREENING_WEBHOOK_TOKEN when set); expects
//                                {sanctions:bool, pep:bool, matches:[...]}.
//
// Fail-open BY DESIGN, but always recorded: a screening-provider outage must
// not block onboarding (the decision engine still runs); the rawResult keeps
// {performed:false, error} so compliance can re-screen the affected window.
// A HIT never auto-approves — the pipeline escalates to manual review (EDD).

const DEFAULT_TIMEOUT_MS = 8000;

async function screenCustomer(subject, opts = {}) {
  const env = opts.env || process.env;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const backend = String(env.SCREENING_BACKEND || "none").toLowerCase();

  if (backend === "none") return { performed: false, backend: "none", hit: false };

  if (backend !== "webhook") {
    return { performed: false, backend, hit: false, error: `unknown SCREENING_BACKEND '${backend}'` };
  }

  const url = env.SCREENING_WEBHOOK_URL;
  if (!url) return { performed: false, backend, hit: false, error: "SCREENING_WEBHOOK_URL not set" };
  const fullName = subject?.fullName || null;
  if (!fullName) {
    // Nothing to screen against (no OCR name, no metadata name) — recorded so
    // reviewers can see screening was SKIPPED, not passed.
    return { performed: false, backend, hit: false, error: "no name available to screen" };
  }

  try {
    const headers = { "content-type": "application/json" };
    if (env.SCREENING_WEBHOOK_TOKEN) headers.authorization = `Bearer ${env.SCREENING_WEBHOOK_TOKEN}`;
    const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout
      ? AbortSignal.timeout(opts.timeoutMs || DEFAULT_TIMEOUT_MS)
      : undefined;
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ fullName, customerReference: subject?.customerReference || null }),
      signal
    });
    if (!res.ok) return { performed: false, backend, hit: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    const matchCount = Array.isArray(data.matches) ? data.matches.length : 0;
    const hit = data.sanctions === true || data.pep === true || matchCount > 0;
    return {
      performed: true, backend, hit,
      sanctions: data.sanctions === true,
      pep: data.pep === true,
      matchCount
    };
  } catch (err) {
    return { performed: false, backend, hit: false, error: err.message };
  }
}

module.exports = { screenCustomer };
