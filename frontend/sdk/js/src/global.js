"use strict";

// The CDN entry embeds the same hosted workflow as the React integration.
// Consent, camera capture, document backs, challenge guidance and retries
// therefore share one implementation.
const { VerifyPassClient, createFlow } = require("@verifypass/sdk-core");
const instances = new WeakMap();

// Copy for the mobile-handoff step. The desktop shows a QR and waits;
// the phone runs the hosted page in its own browser and performs the
// capture there. The desktop never acquires a camera in this mode.
const MOBILE_COPY = {
  title: "Verify on your phone",
  hint: "Scan the QR code with your phone camera to continue.",
  waiting: "Waiting for scan…",
  verifying: "Verifying…",
  finalising: "Finalising…",
  failed: "Verification failed — try again.",
  retry: "Try again"
};

// Self-contained inline styles (no external CSS) so the CDN bundle works
// when dropped into any page.
const MOBILE_STYLE = {
  wrap: { fontFamily: "system-ui, sans-serif", maxWidth: "360px", margin: "0 auto", textAlign: "center", color: "#111827" },
  title: { fontSize: "18px", fontWeight: "600", margin: "0 0 4px" },
  hint: { fontSize: "14px", color: "#6B7280", margin: "0 0 16px" },
  image: { display: "block", margin: "0 auto 16px", padding: "8px", background: "#fff", border: "1px solid #E5E7EB", borderRadius: "8px" },
  status: { fontSize: "14px", color: "#374151", minHeight: "20px", margin: "0 0 12px" },
  retry: { fontSize: "14px", padding: "8px 16px", border: "1px solid #D1D5DB", borderRadius: "6px", background: "#fff", cursor: "pointer" }
};

function init(opts = {}) {
  const {
    container, sessionId, sdkToken, publicKey, baseUrl,
    onComplete, onError,
    /** Mobile handoff: show a QR code the user scans with their phone,
     *  which opens the hosted verification page in its browser. The
     *  desktop widget never acquires a camera in this mode — it polls
     *  /status until the session reaches a terminal outcome. */
    mobileHandoff = false
  } = opts;
  const root = typeof container === "string" ? document.querySelector(container) : container;
  if (!root) throw new Error("VerifyPass.init: container not found");
  const client = new VerifyPassClient({ sessionId, sdkToken, publicKey, baseUrl });
  instances.get(root)?.destroy();
  let disposed = false;
  const instance = {
    destroy() {
      disposed = true;
      client.dispose();
      if (instances.get(root) === instance) {
        instances.delete(root);
        root.replaceChildren();
      }
    }
  };
  instances.set(root, instance);
  const loading = document.createElement("p");
  loading.setAttribute("role", "status");
  loading.textContent = "Loading verification…";
  root.replaceChildren(loading);

  const ready = (async () => {
    // `ready` resolves when the verification reaches a terminal outcome
    // the consumer must see — success, an init failure, or destroy().
    // In mobile mode a RECOVERABLE poll failure keeps it PENDING: the
    // in-widget Retry button is the recovery path, so `await instance.ready`
    // cannot fire before the verification is actually over.
    let settleReady;
    const readyGate = new Promise((resolve) => { settleReady = resolve; });
    const baseDestroy = instance.destroy.bind(instance);
    instance.destroy = () => { baseDestroy(); settleReady(); };

    try {
      const challenge = await client.getChallenge();
      if (disposed) return;

      if (mobileHandoff) {
        await runMobileHandoff(client, root, challenge, onComplete, onError, settleReady, () => disposed);
        await readyGate;
        return;
      }

      // ── Embedded (iframe) mode ─────────────────────────────
      const url = new URL(challenge.hostedBaseUrl);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Hosted verification requires HTTPS");
      if (url.username || url.password || url.search || url.hash || /[\s\\]/.test(challenge.hostedBaseUrl)) throw new Error("Invalid hosted verification URL");
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
      settleReady(); // init failed — don't leave `ready` hanging
      loading.textContent = error.message || "Unable to load verification";
      root.replaceChildren(loading);
      onError?.(error);
    }
  })();
  instance.ready = ready;
  return instance;
}

// Mobile handoff: build + render the QR, then poll /status on a CHILD
// controller until the phone-side verification reaches a terminal
// outcome. `settleReady` resolves `instance.ready` on success; a
// recoverable poll failure leaves it pending and surfaces a Retry button.
async function runMobileHandoff(client, root, challenge, onComplete, onError, settleReady, isDisposed) {
  const flow = createFlow(challenge.verificationType || "ID_AND_FACE", { mobileHandoff: true });
  // The sdkToken lives in the URL FRAGMENT, so browsers never send it to
  // any server — the QR is safe to display and screenshot.
  const mobileUrl = client.getHostedUrl();

  const wrap = document.createElement("div");
  Object.assign(wrap.style, MOBILE_STYLE.wrap);
  const title = document.createElement("h2");
  Object.assign(title.style, MOBILE_STYLE.title);
  title.textContent = MOBILE_COPY.title;
  const hint = document.createElement("p");
  Object.assign(hint.style, MOBILE_STYLE.hint);
  hint.textContent = MOBILE_COPY.hint;
  const image = document.createElement("img");
  Object.assign(image.style, MOBILE_STYLE.image);
  image.alt = "Verification QR code";
  image.width = 256;
  image.height = 256;
  const status = document.createElement("p");
  Object.assign(status.style, MOBILE_STYLE.status);
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = MOBILE_COPY.waiting;
  const retry = document.createElement("button");
  Object.assign(retry.style, MOBILE_STYLE.retry);
  retry.type = "button";
  retry.textContent = MOBILE_COPY.retry;
  retry.hidden = true;
  wrap.append(title, hint, image, status, retry);
  root.replaceChildren(wrap);

  // Render the QR lazily so the `qrcode` package is only pulled into the
  // page for handoff mode — the embedded iframe path never loads it.
  const QR = await import("qrcode");
  image.src = await QR.toDataURL(mobileUrl, { errorCorrectionLevel: "M", margin: 2, width: 256 });
  if (isDisposed()) return;

  // Polling runs on a CHILD AbortController linked to the parent:
  //   * destroy() (parent abort) cancels it, and
  //   * a failed poll's Retry restarts with a FRESH child — aborting the
  //     shared parent would kill the client and any later step.
  let stopPoll = () => {};
  let completed = false;

  const startPoll = () => {
    stopPoll();
    const pollController = new AbortController();
    const onParentAbort = () => pollController.abort();
    client.controller.signal.addEventListener("abort", onParentAbort, { once: true });
    stopPoll = () => {
      client.controller.signal.removeEventListener("abort", onParentAbort);
      pollController.abort();
    };
    status.textContent = MOBILE_COPY.waiting;
    retry.hidden = true;
    client.waitForResult({
      intervalMs: 2500,
      timeoutMs: 10 * 60 * 1000, // the session's own TTL is the real deadline
      onTick: (s) => {
        if (isDisposed()) return;
        // Surface real progress: `started` → the phone is uploading
        // captures, `submitted` → the worker is finalising.
        if (s.status === "started") status.textContent = MOBILE_COPY.verifying;
        else if (s.status === "submitted") status.textContent = MOBILE_COPY.finalising;
      },
      signal: pollController.signal
    }).then((result) => {
      if (isDisposed()) return;
      stopPoll();
      flow.finish(result);
      if (!completed) { completed = true; onComplete?.(result); }
      settleReady();
    }).catch((err) => {
      if (isDisposed()) return;
      stopPoll();
      flow.fail(err);
      status.textContent = err.message || MOBILE_COPY.failed;
      retry.hidden = false;
      onError?.(err);
      // `ready` stays pending — the in-widget Retry is the recovery path.
    });
  };

  retry.addEventListener("click", () => {
    if (isDisposed()) return;
    // Clear the error and re-arm polling — the same pattern the
    // React widget uses for its mobile-step Retry. Deliberately
    // NO server call: a transient poll failure must not burn a
    // retry attempt (retrySession is capped + audit-logged, and
    // is reserved for a rejected/failed OUTCOME, which the
    // consumer re-inits for via onComplete).
    flow.retry();
    startPoll();
  });

  startPoll();
}

module.exports = { init };
