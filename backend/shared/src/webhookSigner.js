"use strict";

// Webhook HMAC signing (PRD §9.11). Signature covers `${timestamp}.${body}`
// so a captured payload can't be replayed later (receivers must reject
// stale timestamps).

const crypto = require("crypto");

const DEFAULT_TOLERANCE_SECONDS = 300;

function signWebhook(body, timestamp, secret) {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

function webhookHeaders(body, secret, { timestamp = Math.floor(Date.now() / 1000), event } = {}) {
  return {
    "Content-Type": "application/json",
    "X-Verifypass-Signature": `sha256=${signWebhook(body, timestamp, secret)}`,
    "X-Verifypass-Timestamp": String(timestamp),
    ...(event ? { "X-Verifypass-Event": event } : {})
  };
}

/** For receivers (documented in dev docs; also used in our tests). */
function verifyWebhookSignature(body, headers, secret, { toleranceSeconds = DEFAULT_TOLERANCE_SECONDS, now = Math.floor(Date.now() / 1000) } = {}) {
  const ts = Number(headers["x-verifypass-timestamp"] || headers["X-Verifypass-Timestamp"]);
  const sigHeader = headers["x-verifypass-signature"] || headers["X-Verifypass-Signature"] || "";
  if (!ts || Math.abs(now - ts) > toleranceSeconds) return false;
  const expected = `sha256=${signWebhook(body, ts, secret)}`;
  const a = Buffer.from(sigHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { signWebhook, webhookHeaders, verifyWebhookSignature };
