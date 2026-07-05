"use strict";

const { TERMINAL_STATUSES } = require("./flow");

class VerifyPassApiError extends Error {
  constructor(code, message, http) {
    super(message);
    this.code = code;
    this.http = http;
  }
}

/**
 * API client for SDK-facing endpoints. All requests use the tenant PUBLIC key;
 * the per-session sdkToken authorizes writes to one session only.
 */
class VerifyPassClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl e.g. https://api.verifypass.com
   * @param {string} opts.publicKey vp_pub_...
   * @param {string} opts.sessionId vps_...
   * @param {string} opts.sdkToken sdk_... (from session creation)
   * @param {Function} [opts.fetchImpl] injected for tests / non-browser envs
   */
  constructor({ baseUrl, publicKey, sessionId, sdkToken, fetchImpl }) {
    // publicKey is optional: the hosted page authenticates with sdkToken only.
    if (!baseUrl || !sessionId || !sdkToken) {
      throw new Error("VerifyPassClient requires baseUrl, sessionId, sdkToken");
    }
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.publicKey = publicKey;
    this.sessionId = sessionId;
    this.sdkToken = sdkToken;
    this.fetch = fetchImpl || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
    if (!this.fetch) throw new Error("No fetch available; pass fetchImpl");
  }

  _headers(extra = {}) {
    const h = { ...extra };
    if (this.publicKey) h.Authorization = `Bearer ${this.publicKey}`;
    return h;
  }

  async _post(path, body) {
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this._headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body || {})
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) {
      const err = json.error || {};
      throw new VerifyPassApiError(err.code || "INTERNAL_ERROR", err.message || `HTTP ${res.status}`, res.status);
    }
    return json;
  }

  async _get(path) {
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      headers: this._headers()
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = json.error || {};
      throw new VerifyPassApiError(err.code || "INTERNAL_ERROR", err.message || `HTTP ${res.status}`, res.status);
    }
    return json;
  }

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
  uploadLivenessFrame(action, imageBase64) {
    return this._post(`/v1/verification-sessions/${this.sessionId}/liveness-frame`, {
      sdkToken: this.sdkToken, action, imageBase64
    });
  }

  /** Fetch the server-issued active-liveness actions + verification type. */
  getChallenge() {
    return this._get(`/v1/verification-sessions/${this.sessionId}/challenge?sdkToken=${encodeURIComponent(this.sdkToken)}`);
  }

  submit() {
    const { collectDeviceSignals } = require("./device");
    return this._post(`/v1/verification-sessions/${this.sessionId}/verify`, {
      sdkToken: this.sdkToken,
      device: collectDeviceSignals() // null outside browsers; server treats as optional
    });
  }

  getStatus() {
    return this._get(`/v1/verification-sessions/${this.sessionId}/status?sdkToken=${encodeURIComponent(this.sdkToken)}`);
  }

  /** Poll session status until terminal (PRD: SDK "session state polling"). */
  async waitForResult({ intervalMs = 2500, timeoutMs = 120000, onTick } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.getStatus();
      if (onTick) onTick(status);
      if (TERMINAL_STATUSES.includes(status.status)) return status;
      if (Date.now() > deadline) throw new VerifyPassApiError("SESSION_EXPIRED", "Timed out waiting for result", 408);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

module.exports = { VerifyPassClient, VerifyPassApiError };
