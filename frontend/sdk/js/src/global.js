"use strict";

// CDN bundle entry (PRD §9.14 "JavaScript SDK").
// Build: npm run build → dist/verifypass.js, host on sdk.verifypass.com.
// Usage:
//   VerifyPass.init({ publicKey, sessionId, sdkToken, container, baseUrl, onComplete, onError })

const {
  VerifyPassClient, createFlow, assessFrame,
  startCamera, stopCamera, captureFrame, collectCaptureSignals
} = require("@verifypass/sdk-core");

const COPY = {
  document: { title: "Scan your ID", hint: "Place your ID inside the frame. Avoid glare.", facing: "environment", btn: "Capture ID" },
  liveness: { title: "Liveness check", hint: "Follow the prompt.", facing: "user", btn: "Capture" },
  face: { title: "Take a selfie", hint: "Look straight at the camera in good lighting.", facing: "user", btn: "Capture selfie" }
};

const ACTION_COPY = {
  blink: "Blink your eyes",
  turn_left: "Slowly turn your head to the LEFT",
  turn_right: "Slowly turn your head to the RIGHT",
  look_up: "Tilt your head UP",
  look_down: "Tilt your head DOWN",
  smile: "Smile"
};

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) Object.assign(node.style, style);
  if (text) node.textContent = text;
  return node;
}

function init(opts = {}) {
  // baseUrl optional: v1 sdkTokens embed the API origin of the environment
  // that issued them (see VerifyPassClient/parseSdkToken).
  const { publicKey, sessionId, sdkToken, container, baseUrl = null, theme = {}, onComplete, onError } = opts;
  const root = typeof container === "string" ? document.querySelector(container) : container;
  if (!root) throw new Error("VerifyPass.init: container not found");
  if (!publicKey || !sessionId || !sdkToken) throw new Error("VerifyPass.init: publicKey, sessionId, sdkToken are required");

  const client = new VerifyPassClient({ baseUrl, publicKey, sessionId, sdkToken });
  const primary = theme.primaryColor || "#6D28D9";

  let flow = null;
  let actions = [];
  let actionIdx = 0;
  let camStep = null;

  root.innerHTML = "";
  const wrap = el("div", { maxWidth: "420px", margin: "0 auto", fontFamily: "system-ui, sans-serif" });
  const title = el("h2", { margin: "0 0 4px", fontSize: "20px" }, "Loading…");
  const hint = el("p", { margin: "0 0 12px", color: "#6B7280", fontSize: "14px" });
  const video = el("video", { width: "100%", borderRadius: "12px", background: "#111", objectFit: "cover", aspectRatio: "3/4", display: "none" });
  video.playsInline = true;
  video.muted = true;
  const msg = el("p", { fontSize: "14px", margin: "8px 0", minHeight: "18px" });
  const btn = el("button", {
    width: "100%", marginTop: "12px", padding: "12px 0", borderRadius: "8px",
    background: primary, color: "#fff", border: "0", fontSize: "16px", cursor: "pointer", display: "none"
  });
  wrap.append(title, hint, video, msg, btn);
  root.appendChild(wrap);

  function setCamera(step) {
    if (camStep === step) return;
    camStep = step;
    stopCamera(video);
    const facing = step === "document" ? "environment" : "user";
    startCamera(video, { facingMode: facing }).then((stream) => {
      // P0 capture integrity: report camera metadata with submit
      collectCaptureSignals(stream).then((sig) => { if (sig && client) client.setCaptureSignals(sig); }).catch(() => {});
      return stream;
    }).catch((err) => {
      msg.style.color = "#DC2626";
      msg.textContent = err.message;
      if (onError) onError(err);
    });
  }

  function render() {
    if (!flow) return;
    const step = flow.state().step;
    if (step === "document" || step === "face" || step === "liveness") {
      btn.style.display = "";
      video.style.display = "";
      video.style.aspectRatio = step === "document" ? "16/10" : "3/4";
      if (step === "liveness") {
        const action = actions[actionIdx];
        title.textContent = `Liveness check (${actionIdx + 1}/${actions.length})`;
        hint.textContent = ACTION_COPY[action] || action;
        btn.textContent = "Capture";
      } else {
        const c = COPY[step];
        title.textContent = c.title;
        hint.textContent = c.hint;
        btn.textContent = c.btn;
      }
      setCamera(step);
    } else if (step === "processing") {
      camStep = null;
      stopCamera(video);
      video.style.display = "none";
      btn.style.display = "none";
      title.textContent = "Verifying…";
      hint.textContent = "This usually takes a few seconds.";
    } else if (step === "complete") {
      camStep = null;
      stopCamera(video);
      video.style.display = "none";
      btn.style.display = "none";
      const result = flow.state().result || {};
      title.textContent = result.status === "approved" ? "Verification approved"
        : result.status === "manual_review" ? "Under review"
        : "Verification not successful";
      hint.textContent = result.status === "manual_review" ? "You'll be notified shortly." : "";
    }
  }

  function skipEmptyLiveness() {
    if (flow && flow.state().step === "liveness" && actions.length === 0) flow.advance();
  }

  btn.addEventListener("click", async () => {
    if (!flow) return;
    btn.disabled = true;
    msg.textContent = "";
    try {
      const { imageData, base64 } = captureFrame(video);
      const quality = assessFrame(imageData);
      if (!quality.ok) {
        msg.style.color = "#B45309";
        msg.textContent = "Image quality too low (" + quality.issues.join(", ") + "). Try again.";
        return;
      }
      const step = flow.state().step;
      if (step === "document") {
        await client.uploadDocument(base64, "front");
        flow.advance();
        skipEmptyLiveness();
        render();
      } else if (step === "liveness") {
        await client.uploadLivenessFrame(actions[actionIdx], base64);
        actionIdx += 1;
        if (actionIdx >= actions.length) { actionIdx = 0; flow.advance(); }
        render();
      } else if (step === "face") {
        await client.uploadFace(base64);
        flow.advance();
        render();
        await client.submit();
        const result = await client.waitForResult();
        flow.finish(result);
        render();
        if (onComplete) onComplete(result);
      }
    } catch (err) {
      msg.style.color = "#DC2626";
      msg.textContent = err.message;
      if (onError) onError(err);
    } finally {
      btn.disabled = false;
    }
  });

  // Fetch the server-issued challenge, then build the flow and start.
  (async () => {
    let verificationType = "ID_AND_FACE";
    try {
      const c = await client.getChallenge();
      verificationType = c.verificationType || "ID_AND_FACE";
      actions = Array.isArray(c.livenessActions) ? c.livenessActions : [];
    } catch (err) {
      if (onError) onError(err);
    }
    flow = createFlow(verificationType);
    skipEmptyLiveness();
    render();
  })();

  return { destroy: () => { stopCamera(video); root.innerHTML = ""; } };
}

module.exports = { init };
