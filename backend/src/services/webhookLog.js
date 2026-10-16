"use strict";

const crypto = require("node:crypto");

// Keep the log schema explicit: webhook URLs may contain secrets, and approved
// bodies contain a bearer-token selfie URL. Neither belongs in runtime logs.
const FIELDS = new Set([
  "eventUid", "deliveryId", "tenantId", "sessionId", "event", "attempt",
  "status", "httpStatus", "durationMs", "payloadFields", "bodyBytes",
  "bodySha256", "userSessionIdPresent", "selfieUrlPresent", "receiverOrigin",
  "reason", "nextAttemptAt", "trigger"
]);

function logWebhook(stage, details = {}, write = console.info) {
  const entry = { component: "webhook", stage, at: new Date().toISOString() };
  for (const [key, value] of Object.entries(details)) {
    if (FIELDS.has(key) && value !== undefined) entry[key] = value;
  }
  // Logging must never interrupt delivery or change retry behavior.
  try { write(JSON.stringify(entry)); } catch (_) { /* best effort */ }
}

function requestSummary(body) {
  const parsed = JSON.parse(body);
  return {
    payloadFields: Object.keys(parsed).sort(),
    bodyBytes: Buffer.byteLength(body),
    bodySha256: crypto.createHash("sha256").update(body).digest("hex"),
    userSessionIdPresent: parsed.userSessionId != null,
    selfieUrlPresent: typeof parsed.selfieUrl === "string" && parsed.selfieUrl.length > 0
  };
}

module.exports = { logWebhook, requestSummary };
