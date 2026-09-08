"use strict";

const { TERMINAL_STATUSES } = require("./flow");
const { validateApiBase, validatePublicKey } = require("./config");

class VerifyPassApiError extends Error {
  constructor(code, message, http) {
    super(message);
    this.code = code;
    this.http = http;
  }
}

function decodeBase64Url(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  if (typeof atob === "function") {
    return decodeURIComponent(Array.from(atob(b64), (c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join(""));
  }
  return Buffer.from(b64, "base64").toString("utf8");
}

/**
 * v1 SDK tokens are self-locating: they embed the API origin of the
 * environment that issued them (sandbox / production / self-hosted), so the
 * consumer never configures a baseUrl. Legacy `sdk_<random>` tokens return
 * baseUrl null and rely on an explicit option.
 */
function parseSdkToken(token) {
  if (typeof token !== "string" || token.length > 4096) return { baseUrl: null };
  const m = /^sdk_v1_([A-Za-z0-9_-]+)$/.exec(String(token || ""));
  if (!m) return { baseUrl: null };
  try {
    const json = JSON.parse(decodeBase64Url(m[1]));
    const u = validateApiBase(json.u);
    return { baseUrl: u };
  } catch (_) {
    return { baseUrl: null };
  }
}

/**
 * API client for SDK-facing endpoints. All requests use the tenant PUBLIC key;
 * the per-session sdkToken authorizes writes to one session only.
 */
class VerifyPassClient {
  /**
   * @param {object} opts
   * @param {string} opts.sessionId vps_...
   * @param {string} opts.sdkToken sdk_v1_... (from session creation; embeds
   *   the API origin, so no baseUrl is needed)
   * @param {string} [opts.publicKey] vp_pub_... (embedded SDK mode)
   * @param {string} [opts.baseUrl] explicit override — dev proxies / legacy
   *   `sdk_<random>` tokens only
   * @param {Function} [opts.fetchImpl] injected for tests / non-browser envs
   */
  constructor({ baseUrl, publicKey, sessionId, sdkToken, fetchImpl }) {
    // publicKey is optional: the hosted page authenticates with sdkToken only.
    if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(sessionId)
      || typeof sdkToken !== "string" || !sdkToken || sdkToken.length > 4096 || /[\s\x00-\x1f\x7f]/.test(sdkToken)) {
      throw new Error("VerifyPassClient requires sessionId and sdkToken");
    }
    const resolved = baseUrl || parseSdkToken(sdkToken).baseUrl;
    if (!resolved) {
      throw new Error("VerifyPassClient: token does not embed an API origin — pass baseUrl explicitly");
    }
    this.baseUrl = validateApiBase(resolved);
    this.controller = new AbortController();
    this.publicKey = validatePublicKey(publicKey);
    this.sessionId = sessionId;
    this.sdkToken = sdkToken;
    this.fetch = fetchImpl || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
    if (!this.fetch) throw new Error("No fetch available; pass fetchImpl");
  }

  _headers(extra = {}) {
    const h = { ...extra };
    if (this.publicKey) h.Authorization = `Bearer ${this.publicKey}`;
    // Session credential travels in a header, never the query string (logs).
    if (this.sdkToken) h["X-VP-SDK-Token"] = this.sdkToken;
    return h;
  }

  dispose() { this.controller.abort(); }
  async _request(path, body, timeoutMs = body ? 30000 : 15000) {
    if (this.controller.signal.aborted) throw new Error("Verification cancelled");
    const controller = new AbortController();
    const abort = () => controller.abort();
    const parent = this.controller.signal;
    if (parent.aborted) abort();
    parent.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const res = await this.fetch(`${this.baseUrl}${path}`, {
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
        headers: this._headers(body ? { "Content-Type": "application/json" } : {}),
        ...(body ? { method: "POST", body: JSON.stringify({ ...body, ...(this.attemptId ? { attemptId: this.attemptId } : {}) }) } : {})
      });
      const json = await res.json().catch(() => null);
      if (parent.aborted) throw new Error("Verification cancelled");
      if (controller.signal.aborted) throw new VerifyPassApiError("REQUEST_TIMEOUT", "Verification request timed out", 408);
      if (!res.ok || json?.success === false) {
        const err = json?.error || {};
        const error = new VerifyPassApiError(err.code || "INTERNAL_ERROR", err.message || `HTTP ${res.status}`, res.status);
        error.correlationId = json?.correlationId || null;
        throw error;
      }
      if (!json || typeof json !== "object" || Array.isArray(json) || json.success !== true) {
        throw new VerifyPassApiError("INVALID_RESPONSE", "Invalid verification API response", 502);
      }
      return json;
    } finally { clearTimeout(timer); parent.removeEventListener("abort", abort); }
  }
  _post(path, body) { return this._request(path, body); }
  _get(path) { return this._request(path); }

  uploadDocument(imageBase64, side = "front") {
    return this._post(`/v1/verification-sessions/${this.sessionId}/document`, {
      sdkToken: this.sdkToken, side, imageBase64
    });
  }

  uploadFace(imageBase64, side = "selfie") {
    return this._post(`/v1/verification-sessions/${this.sessionId}/face`, {
      sdkToken: this.sdkToken, side, imageBase64
    });
  }

  /** Upload one active-liveness challenge frame for a given action. */
  /**
   * @param {"auto"|"manual"|"fallback"} [captureMode] how the frame was taken:
   *   auto     — the action detector saw the instructed movement
   *   fallback — timer burst with no detector verdict
   *   manual   — the user tapped Capture (never auto-approved server-side)
   */
  uploadLivenessFrame(action, imageBase64, captureMode = "unknown") {
    return this._post(`/v1/verification-sessions/${this.sessionId}/liveness-frame`, {
      sdkToken: this.sdkToken, action, imageBase64, captureMode
    });
  }

  /**
   * Upload the screen-flash mosaic (baseline tile + one face tile per emitted
   * colour, left to right) with the colour sequence the widget showed.
   * Record-first liveness signal; failures are non-fatal for the flow.
   */
  uploadFlash(imageBase64, sequence, tile) {
    return this._post(`/v1/verification-sessions/${this.sessionId}/flash`, {
      sdkToken: this.sdkToken, imageBase64, meta: { sequence, tile }
    });
  }

  /** Fetch the server-issued active-liveness actions + verification type. */
  async getChallenge() {
    const data = await this._get(`/v1/verification-sessions/${this.sessionId}/challenge`);
    this.attemptId = data.attemptId; this.flashSequence = data.flashSequence;
    return data;
  }

  /**
   * Start the liveness clock: call when the liveness step is reached. The
   * challenge TTL and the first-frame window run from this moment rather than
   * from session creation. Idempotent once a frame has been uploaded. Returns
   * the deadlines (challengeExpiresAt, firstFrameDeadline, sessionExpiresAt).
   */
  async beginChallenge() {
    const data = await this._post(`/v1/verification-sessions/${this.sessionId}/challenge/begin`, { sdkToken: this.sdkToken });
    this.challengeDeadlines = { challengeExpiresAt: data.challengeExpiresAt, firstFrameDeadline: data.firstFrameDeadline, sessionExpiresAt: data.sessionExpiresAt };
    return data;
  }

  /**
   * Record the user's biometric-processing consent (set-once, idempotent,
   * audit-logged server-side). Production refuses uploads until recorded.
   */
  recordConsent(copyVersion = null) {
    return this._post(`/v1/verification-sessions/${this.sessionId}/consent`, {
      sdkToken: this.sdkToken, copyVersion
    });
  }

  /**
   * Reopen a rejected/review session for another attempt (server enforces the
   * attempt cap and audit-logs every retry).
   * @returns {{attempts:number, maxAttempts:number, manualUploadSuggested:boolean,
   *            livenessChallenge:{actions:string[]}|null}}
   */
  async retrySession() {
    const data = await this._post(`/v1/verification-sessions/${this.sessionId}/retry`, {
      sdkToken: this.sdkToken
    });
    this.attemptId = data.attemptId; this.flashSequence = data.livenessChallenge?.flashSequence;
    this._captureSignals = null;
    this._captureTelemetry = null;
    this.challengeDeadlines = null;
    return data;
  }

  /**
   * Record capture-integrity signals (camera label/track metadata, virtual
   * camera heuristics) collected after the camera started. Sent with submit.
   */
  setCaptureSignals(signals) {
    this._captureSignals = signals || null;
  }

  /** Capture telemetry (how each action was captured) — sent with submit. */
  setCaptureTelemetry(telemetry) {
    this._captureTelemetry = telemetry || null;
  }

  /**
   * Ask for a different liveness challenge because the user cannot perform an
   * action (capped + audited server-side). Returns the new action list.
   */
  async reissueChallenge(excludeActions = []) {
    const data = await this._post(`/v1/verification-sessions/${this.sessionId}/challenge/reissue`, {
      sdkToken: this.sdkToken, excludeActions
    });
    this.attemptId = data.attemptId; this.flashSequence = data.livenessChallenge?.flashSequence;
    return data;
  }

  submit() {
    const { collectDeviceSignals } = require("./device");
    return this._post(`/v1/verification-sessions/${this.sessionId}/verify`, {
      sdkToken: this.sdkToken,
      device: collectDeviceSignals(), // null outside browsers; server treats as optional
      capture: this._captureSignals || null,
      telemetry: this._captureTelemetry || null
    });
  }

  getStatus({ timeoutMs = 15000 } = {}) {
    return this._request(`/v1/verification-sessions/${this.sessionId}/status`, undefined, timeoutMs);
  }

  /**
   * Poll session status until terminal (PRD: SDK "session state polling").
   *
   * RESILIENT by design: a single failed poll must never abort a verification
   * that is completing server-side. Mobile networks blip, dev servers
   * restart, proxies drop sockets — "Failed to fetch" on one poll is noise.
   * Transient failures (network errors, 5xx, 429, timeouts) are retried
   * until the overall deadline; only definitive API answers (401/403/404 —
   * bad token, revoked key, unknown session) abort immediately.
   */
  async waitForResult({ intervalMs = 2500, timeoutMs = 120000, onTick } = {}) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Polling interval and timeout must be positive finite numbers");
    }
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    for (;;) {
      if (this.controller.signal.aborted) throw new Error("Verification cancelled");
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw lastError || new VerifyPassApiError("SESSION_EXPIRED", "Timed out waiting for result", 408);
      let status;
      try {
        status = await this.getStatus({ timeoutMs: Math.min(15000, remaining) });
        lastError = null;
      } catch (err) {
        const definitive = err instanceof VerifyPassApiError
          && typeof err.http === "number"
          && err.http >= 400 && err.http < 500
          && err.http !== 408 && err.http !== 429;
        if (definitive) throw err;
        lastError = err; // transient — keep polling until the deadline
      }
      if (status) {
        if (onTick) onTick(status);
        if (TERMINAL_STATUSES.includes(status.status)) return status;
      }
      if (Date.now() >= deadline) {
        throw lastError || new VerifyPassApiError("SESSION_EXPIRED", "Timed out waiting for result", 408);
      }
      await new Promise((resolve, reject) => {
        const signal = this.controller.signal;
        const abort = () => { clearTimeout(timer); reject(new Error("Verification cancelled")); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, Math.min(intervalMs, Math.max(0, deadline - Date.now())));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
}

module.exports = { VerifyPassClient, VerifyPassApiError, parseSdkToken };
