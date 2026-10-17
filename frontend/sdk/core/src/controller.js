"use strict";

// Headless verification controller: owns the session lifecycle (challenge,
// consent, liveness frame budget, uploads, submit + polling, retry, reissue,
// mobile handoff) with no UI. The React widget, the useVerification hook and
// the <verifypass-liveness> element all render off this; custom UIs can too.
// Camera, frame analysis and auto-capture timing stay with the caller.

const { VerifyPassClient, pollingTimeoutForExpiry } = require("./client");
const { createFlow, needsDocumentBack } = require("./flow");
const { toVerifyPassError } = require("./errors");

// Client-side mirror of the server's per-action liveness frame budget (FV-3).
// Two full cycles (early shot + 3-frame burst). Uploading past it would be
// rejected server-side and dead-end the flow.
const LIVENESS_FRAME_BUDGET = 8;
const RESULT_TIMEOUT_MS = 300000; // 5 min — covers worker restarts + stale-job reclaim
const MAX_DOCUMENT_FILE_BYTES = 3 * 1024 * 1024;

function freshTelemetry() {
  return { actions: [], detectMs: null, landmarkMs: null, modelLoadMs: null, startedAt: 0 };
}

/**
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.sdkToken
 * @param {string|null} [opts.publicKey]
 * @param {string|null} [opts.baseUrl]
 * @param {boolean} [opts.mobileHandoff] true = QR only, false = this device, undefined = user chooses
 * @param {Function} [opts.onComplete] @param {Function} [opts.onError]
 * @param {Function} [opts.onStepChange] @param {Function} [opts.onTelemetry]
 * @param {Function} [opts.fetchImpl]
 */
function createVerificationController(opts = {}) {
  const { sessionId, sdkToken, publicKey, baseUrl, fetchImpl } = opts;
  let callbacks = {};
  const setCallbacks = (o) => {
    callbacks = { onComplete: o.onComplete, onError: o.onError, onStepChange: o.onStepChange, onTelemetry: o.onTelemetry };
  };
  setCallbacks(opts);

  const allowsChoice = opts.mobileHandoff === undefined;
  let handoffSelected = false;
  const handoffEnabled = () => (allowsChoice ? handoffSelected : !!opts.mobileHandoff);

  let client = null;
  let flow = null;
  let offFlow = () => {};
  let pollController = null;
  let startToken = 0;
  let disposed = false;
  let capturing = false;
  let frameCounts = {};
  let telemetry = freshTelemetry();
  let begunEpoch = -1;
  const listeners = new Set();

  let state = {
    status: "idle", // idle | loading | ready | error
    initError: null,
    flow: null,
    verificationType: null,
    actions: [],
    actionIndex: 0,
    consented: false,
    busy: false,
    feedback: null,
    attempts: { attempts: 1, manualUpload: false, exhausted: false },
    challengeEpoch: 0, // bumps on every new challenge (retry / reissue)
    attemptEpoch: 0,   // bumps on retry only
    hostedBaseUrl: null,
    handoff: {
      allowsChoice, enabled: handoffEnabled(), url: null, expiresAt: null, handoffExpiresAt: null,
      phase: "waiting", polling: false, error: null, linkStatus: null
    }
  };

  function set(patch) {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const fn of listeners) fn(state);
    afterChange();
  }
  const setHandoff = (patch) => set({ handoff: { ...state.handoff, ...patch } });
  const aborted = () => !client || client.controller.signal.aborted;

  function emitError(err, code, errOpts) {
    if (callbacks.onError) callbacks.onError(toVerifyPassError(err, code, errOpts));
  }

  // Derived effects that used to live in widget effects.
  function afterChange() {
    const step = state.flow && state.flow.step;
    // No challenge actions → don't linger on the liveness step.
    if (flow && step === "liveness" && state.actions.length === 0 && flow.state().step === "liveness") {
      flow.advance();
      return;
    }
    // Start the challenge clock when the user REACHES liveness (not at session
    // creation). Best-effort; re-armed per challenge.
    if (client && state.consented && step === "liveness" && state.actions.length > 0 && begunEpoch !== state.challengeEpoch) {
      const epoch = state.challengeEpoch;
      begunEpoch = epoch;
      client.beginChallenge().catch(() => { if (begunEpoch === epoch) begunEpoch = -1; });
    }
  }

  async function start() {
    const token = ++startToken;
    stopPolling();
    if (client) client.dispose();
    offFlow();
    offFlow = () => {};
    flow = null;
    set({ status: "loading", initError: null, flow: null, handoff: { ...state.handoff, enabled: handoffEnabled(), url: null, error: null, polling: false, phase: "waiting" } });
    let c;
    try {
      client = new VerifyPassClient({ baseUrl, publicKey, sessionId, sdkToken, fetchImpl });
      c = await client.getChallenge({ mobileHandoff: handoffEnabled() });
    } catch (err) {
      if (token !== startToken || disposed) return;
      set({ status: "error", initError: (err && err.message) || String(err) });
      emitError(err, "INIT_FAILED");
      return;
    }
    if (token !== startToken || disposed) return;

    const verificationType = c.verificationType || "ID_AND_FACE";
    const documentTypes = Array.isArray(c.documentTypes) ? c.documentTypes : [];
    frameCounts = {};
    const patch = {
      verificationType,
      actions: Array.isArray(c.livenessActions) ? c.livenessActions : [],
      actionIndex: 0,
      hostedBaseUrl: c.hostedBaseUrl || null
    };
    // Rehydrate attempt state — a refresh mid-retry must not reset the
    // counter or hide the manual-upload option the server already granted.
    if (typeof c.attempts === "number") {
      patch.attempts = { attempts: c.attempts, manualUpload: !!c.manualUploadSuggested, exhausted: c.attempts >= (c.maxAttempts || 5) };
    }
    try {
      flow = createFlow(verificationType, { documentBack: needsDocumentBack(documentTypes), mobileHandoff: handoffEnabled() });
    } catch (err) {
      set({ ...patch, status: "error", initError: "Unsupported verification workflow" });
      emitError(err, "UNSUPPORTED_WORKFLOW");
      return;
    }
    const f = flow;
    offFlow = f.onChange((s) => {
      if (flow !== f) return;
      set({ flow: s });
      if (callbacks.onStepChange) callbacks.onStepChange(s.step);
    });
    // Hosted URL with the one-time handoff token (fragment, never sent in
    // HTTP requests). Failure here is a configuration problem.
    let url = null;
    let urlError = null;
    if (handoffEnabled()) {
      try { url = client.getHostedUrl(); } catch (err) { urlError = (err && err.message) || String(err); }
    }
    set({
      ...patch,
      status: "ready",
      flow: f.state(),
      handoff: { ...state.handoff, url, error: urlError, expiresAt: c.expiresAt || null, handoffExpiresAt: c.handoffExpiresAt || null }
    });
    if (url && f.state().step === "mobile") startPolling();
  }

  // Mobile handoff: poll /status on a CHILD controller linked to the client's,
  // so dispose cancels it but a Retry can restart polling without killing the
  // shared client.
  function startPolling() {
    stopPolling();
    const c = client;
    const f = flow;
    if (!c || !f) return;
    const pc = new AbortController();
    pollController = pc;
    const onParentAbort = () => pc.abort();
    c.controller.signal.addEventListener("abort", onParentAbort, { once: true });
    const live = () => !pc.signal.aborted && pollController === pc;
    setHandoff({ polling: true, phase: "waiting", error: null });
    c.waitForResult({
      intervalMs: 2500,
      timeoutMs: pollingTimeoutForExpiry(state.handoff.expiresAt),
      signal: pc.signal,
      // created → nothing yet, started → phone uploading, submitted → finalising
      onTick: (s) => {
        if (!live()) return;
        if (s.status === "started") setHandoff({ phase: "verifying" });
        else if (s.status === "submitted") setHandoff({ phase: "finalising" });
      }
    }).then((result) => {
      if (!live()) return;
      setHandoff({ polling: false });
      f.finish(result);
      if (callbacks.onComplete) callbacks.onComplete(result);
    }).catch((err) => {
      if (!live()) return;
      setHandoff({ polling: false });
      f.fail(err);
      emitError(err);
    }).finally(() => c.controller.signal.removeEventListener("abort", onParentAbort));
  }

  function stopPolling() {
    if (pollController) pollController.abort();
    pollController = null;
  }

  /** Switch between QR handoff and this device (only when mobileHandoff was omitted). */
  function selectHandoff(enabled) {
    if (!allowsChoice) return;
    handoffSelected = !!enabled;
    set({ feedback: null });
    start();
  }

  function retryHandoff() {
    if (!flow) return;
    setHandoff({ error: null });
    flow.retry();
    startPolling();
  }

  async function copyHandoffLink() {
    const url = state.handoff.url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setHandoff({ linkStatus: "copied" });
      emitTelemetry({ type: "mobile_handoff_link_copied" });
    } catch (err) {
      setHandoff({ linkStatus: "copy_failed" });
      emitTelemetry({ type: "mobile_handoff_copy_failed", errorName: (err && err.name) || "Error" });
    }
  }

  async function recordConsent(copyVersion = null) {
    if (!client || state.busy) return;
    set({ busy: true, feedback: null });
    try {
      await client.recordConsent(copyVersion);
      set({ consented: true });
    } catch (err) {
      set({ feedback: (err && err.message) || String(err) });
    } finally {
      set({ busy: false });
    }
  }

  const currentAction = () => state.actions[state.actionIndex] || null;
  const framesUsed = (action = currentAction()) => frameCounts[action] || 0;
  const livenessBudgetSpent = (action = currentAction()) => framesUsed(action) >= LIVENESS_FRAME_BUDGET;

  function advanceLiveness() {
    const action = currentAction();
    const tel = telemetry.actions.find((a) => a.action === action && !a.done);
    if (tel) { tel.frames = frameCounts[action] || 0; tel.done = true; }
    const next = state.actionIndex + 1;
    if (next >= state.actions.length) {
      set({ actionIndex: 0 });
      flow.advance(); // → face
    } else {
      set({ actionIndex: next });
    }
  }

  function buildTelemetry() {
    const t = telemetry;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    return {
      detectMs: t.detectMs, landmarkMs: t.landmarkMs, modelLoadMs: t.modelLoadMs,
      totalMs: t.startedAt ? Math.round(now - t.startedAt) : null,
      actions: t.actions.map((a) => ({ action: a.action, msToTrigger: a.msToTrigger, wrongWay: a.wrongWay, hints: a.hints, frames: a.frames, mode: a.mode || "unknown", reissued: a.reissued }))
    };
  }

  async function submitAndWait() {
    client.setCaptureTelemetry(buildTelemetry());
    await client.submit();
    const result = await client.waitForResult({ timeoutMs: RESULT_TIMEOUT_MS });
    if (aborted()) return false;
    flow.finish(result);
    if (callbacks.onComplete) callbacks.onComplete(result);
    return undefined;
  }

  // Upload helpers, used inside runCapture().
  const capture = {
    async document(base64) {
      const step = flow.state().step;
      await client.uploadDocument(base64, step === "document_back" ? "back" : "front");
      if (aborted()) return false;
      flow.advance();
      // ID_ONLY has no face step — the document is the last capture.
      if (flow.state().step === "processing") return submitAndWait();
      return undefined;
    },
    /** @param {"auto"|"manual"|"fallback"} mode @param {boolean} [advance] */
    async livenessFrame(base64, mode = "manual", advance = true) {
      const action = currentAction();
      const used = frameCounts[action] || 0;
      if (used < LIVENESS_FRAME_BUDGET) {
        try {
          await client.uploadLivenessFrame(action, base64, mode);
          frameCounts[action] = used + 1;
          if (mode === "manual") {
            const t = telemetry.actions.find((a) => a.action === action && !a.done);
            if (t) t.mode = "manual";
            else telemetry.actions.push({ action, msToTrigger: null, wrongWay: 0, hints: [], frames: 0, mode: "manual", reissued: false, done: false });
          }
        } catch (err) {
          // Server says the budget is spent (another tab / redo cycle): the
          // action already carries max evidence — completion, not failure.
          if (!/too many liveness frames/i.test((err && err.message) || "")) throw err;
          frameCounts[action] = LIVENESS_FRAME_BUDGET;
        }
      }
      if (advance) advanceLiveness();
      return true;
    },
    /**
     * @param {string} base64 selfie
     * @param {{flash?: (sequence: unknown, signal: AbortSignal) => Promise<{base64:string, sequence:unknown, tile:unknown}|null>}} [o]
     *   optional screen-flash runner; record-first, failures never block
     */
    async face(base64, o = {}) {
      await client.uploadFace(base64);
      if (aborted()) return false;
      if (o.flash) {
        try {
          const mosaic = await o.flash(client.flashSequence, client.controller.signal);
          if (mosaic) await client.uploadFlash(mosaic.base64, mosaic.sequence, mosaic.tile);
        } catch (_) { /* record-first: ignore */ }
      }
      if (aborted()) return false;
      flow.advance(); // → processing
      return submitAndWait();
    }
  };

  /**
   * Run one capture attempt. `fn(capture)` grabs the frame and calls a
   * capture.* helper. Busy/feedback, the single-flight guard and error
   * reporting are handled here. Skipped while a step error is latched.
   */
  async function runCapture(fn) {
    if (capturing) return undefined;
    if (!flow || flow.state().error) return undefined;
    capturing = true;
    set({ busy: true, feedback: null });
    try {
      return await fn(capture);
    } catch (err) {
      if (aborted()) return false;
      flow.fail(err);
      emitError(err, "CAPTURE_FAILED");
      return undefined;
    } finally {
      capturing = false;
      set({ busy: false });
    }
  }

  /** Manual document upload (offered after repeated camera failures). Document-only by design. */
  async function uploadDocumentFile(file) {
    if (!file || capturing || !flow || aborted()) return;
    const step = flow.state().step;
    if (step !== "document" && step !== "document_back") return;
    capturing = true;
    set({ busy: true, feedback: null });
    try {
      if (file.size > MAX_DOCUMENT_FILE_BYTES) throw new Error("Image is larger than 3MB — choose a smaller photo.");
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Could not read the selected file."));
        reader.readAsDataURL(file);
      });
      if (aborted()) return;
      if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(base64)) throw new Error("Choose a JPEG or PNG photo of your ID.");
      await capture.document(base64);
    } catch (err) {
      if (aborted()) return;
      set({ feedback: (err && err.message) || String(err) });
    } finally {
      capturing = false;
      set({ busy: false });
    }
  }

  /** Try again after a rejected / review / failed outcome (server caps + audits). */
  async function retry() {
    if (!client || !flow || state.busy || capturing) return;
    capturing = true;
    set({ busy: true, feedback: null });
    try {
      const r = await client.retrySession();
      if (aborted()) return;
      frameCounts = {};
      telemetry = freshTelemetry();
      set({
        challengeEpoch: state.challengeEpoch + 1,
        attemptEpoch: state.attemptEpoch + 1,
        actions: (r.livenessChallenge && r.livenessChallenge.actions) || [],
        actionIndex: 0,
        attempts: { attempts: r.attempts, manualUpload: !!r.manualUploadSuggested, exhausted: (r.attemptsRemaining ?? 1) <= 0 }
      });
      flow.reset();
    } catch (err) {
      if (aborted()) return;
      if (err && err.code === "RETRY_LIMIT_REACHED") set({ attempts: { ...state.attempts, exhausted: true } });
      set({ feedback: (err && err.message) || String(err) });
    } finally {
      capturing = false;
      set({ busy: false });
    }
  }

  /** The user cannot perform the current action: ask for a different challenge. */
  async function reissue() {
    if (!client || state.busy || capturing) return;
    capturing = true;
    const action = currentAction();
    set({ busy: true });
    try {
      const r = await client.reissueChallenge([action]);
      if (aborted()) return;
      const tel = telemetry.actions.find((a) => a.action === action && !a.done);
      if (tel) { tel.reissued = true; tel.done = true; }
      frameCounts = {};
      set({ actions: (r.livenessChallenge && r.livenessChallenge.actions) || [], actionIndex: 0, challengeEpoch: state.challengeEpoch + 1 });
    } catch (err) {
      set({ feedback: (err && err.message) || String(err) });
    } finally {
      capturing = false;
      set({ busy: false });
    }
  }

  /** Camera could not start: latch a retryable step error and report it. */
  function reportCameraError(err, userMessage) {
    if (flow) flow.fail({ code: "CAMERA_ERROR", message: userMessage || (err && err.message) || "Failed to access camera." });
    emitError(err, "CAMERA_ERROR", { camera: true });
  }

  function emitTelemetry(event) {
    if (callbacks.onTelemetry) callbacks.onTelemetry(event);
  }

  function dispose() {
    stopPolling();
    if (client) client.dispose();
    offFlow();
    disposed = true;
    listeners.clear();
  }

  return {
    start,
    dispose,
    getState: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Replace callbacks (e.g. new handler identities from a re-render). */
    update: setCallbacks,
    selectHandoff,
    retryHandoff,
    copyHandoffLink,
    recordConsent,
    runCapture,
    uploadDocumentFile,
    advanceLiveness,
    livenessBudgetSpent,
    framesUsed,
    currentAction,
    retry,
    reissue,
    retryStep() { if (flow) flow.retry(); },
    advanceStep() { if (flow) flow.advance(); },
    reportCameraError,
    emitTelemetry,
    setFeedback(message) { set({ feedback: message || null }); },
    /** Mutable capture telemetry (sent with submit). Re-read after retry(). */
    getTelemetry: () => telemetry,
    isCapturing: () => capturing,
    get client() { return client; }
  };
}

module.exports = { createVerificationController, LIVENESS_FRAME_BUDGET, MAX_DOCUMENT_FILE_BYTES };
