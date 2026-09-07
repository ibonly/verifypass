"use strict";

// The CDN entry embeds the same hosted workflow as the React integration.
// Consent, camera capture, document backs, challenge guidance and retries
// therefore share one implementation.
const { VerifyPassClient } = require("@verifypass/sdk-core");
function init(opts = {}) {
  const { container, sessionId, sdkToken, publicKey, baseUrl, onComplete, onError } = opts;
  const root = typeof container === "string" ? document.querySelector(container) : container;
  if (!root) throw new Error("VerifyPass.init: container not found");
  const client = new VerifyPassClient({ sessionId, sdkToken, publicKey, baseUrl });
  let disposed = false;
  const loading = document.createElement("p");
  loading.setAttribute("role", "status");
  loading.textContent = "Loading verification…";
  root.replaceChildren(loading);
  const ready = (async () => {
    try {
      const challenge = await client.getChallenge();
      if (disposed) return;
      const url = new URL(challenge.hostedBaseUrl);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Hosted verification requires HTTPS");
      url.pathname = `${url.pathname.replace(/\/$/, "")}/session/${encodeURIComponent(sessionId)}`;
      url.hash = `t=${encodeURIComponent(sdkToken)}`;
      const frame = document.createElement("iframe");
      frame.src = url.href;
      frame.title = "Identity verification";
      frame.allow = "camera";
      frame.referrerPolicy = "no-referrer";
      Object.assign(frame.style, { width: "100%", height: "780px", border: "0" });
      root.replaceChildren(frame);
      const result = await client.waitForResult({ timeoutMs: 30 * 60 * 1000 });
      if (!disposed) onComplete?.(result);
    } catch (error) {
      if (disposed) return;
      loading.textContent = error.message || "Unable to load verification";
      root.replaceChildren(loading);
      onError?.(error);
    }
  })();
  return { ready, destroy() { disposed = true; client.dispose(); root.replaceChildren(); } };
}
module.exports = { init };
