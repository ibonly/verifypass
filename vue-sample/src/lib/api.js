// Browser → YOUR backend. The browser never talks to VerifyPass with a secret
// key; it asks this app's server (server/verifypassApi.mjs) to do so.

async function request(path, init) {
  const res = await fetch(path, {
    ...init,
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}) }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || `Request failed (HTTP ${res.status})`);
  return body;
}

export function getServerConfig() {
  return request("/api/config");
}

/** @returns {Promise<{ sessionId: string, sdkToken: string, expiresAt?: string, verificationType: string }>} */
export function createVerificationSession({ customerReference, verificationType }) {
  return request("/api/verification-sessions", {
    method: "POST",
    body: JSON.stringify({ customerReference, verificationType })
  });
}

/** Server-verified outcome. Trust this, not the browser widget callback. */
export function getVerificationResult(sessionId) {
  return request(`/api/verification-sessions/${encodeURIComponent(sessionId)}/result`);
}
