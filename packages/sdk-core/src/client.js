"use strict";

const { TERMINAL_STATUSES } = require("./flow");

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
  const m = /^sdk_v1_([A-Za-z0-9_-]+)$/.exec(String(token || ""));
  if (!m) return { baseUrl: null };
  try {
    const json = JSON.parse(decodeBase64Url(m[1]));
    const u = typeof json.u === "string" && /^https?:\/\//.test(json.u) ? json.u.replace(/\/$/, "") : null;
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
    if (!sessionId || !sdkToken) {
      throw new Error("VerifyPassClient requires sessionId and sdkToken");
    }
    const resolved = baseUrl || parseSdkToken(sdkToken).baseUrl;
    if (!resolved) {
      throw new Error("VerifyPassClient: token does not embed an API origin — pass baseUrl explicitly");
    }
    this.baseUrl = resolved.replace(/\/$/, "");
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

module.exports = { VerifyPassClient, VerifyPassApiError, parseSdkToken };
