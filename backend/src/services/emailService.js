"use strict";

// Node-side client for the PHP mail API (email-api/ module, cPanel SMTP).
// Every transactional email the platform needs is a named helper here. The
// backend owns users/tokens/sessions; PHP only renders + delivers via SMTP.
//
// Env:
//   EMAIL_API_URL  e.g. https://mailer.yourdomain.com  (unset = email disabled)
//   EMAIL_API_KEY  shared secret matching email-api/config.php api_key
//   DASHBOARD_URL  absolute dashboard origin used to build action links

const crypto = require("crypto");

const BASE = () => (process.env.EMAIL_API_URL || "").replace(/\/$/, "");
const KEY = () => process.env.EMAIL_API_KEY || "";
const DASH = () => (process.env.DASHBOARD_URL || process.env.API_PUBLIC_URL || "").replace(/\/$/, "");

function enabled() {
  return Boolean(BASE() && KEY());
}

/** sha256-hashed 256-bit action token (returned plaintext once, stored hashed by caller). */
function newActionToken() {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, hash: crypto.createHash("sha256").update(token).digest("hex") };
}

function actionUrl(path, token) {
  return `${DASH()}${path}#token=${encodeURIComponent(token)}`;
}

async function send(to, template, vars = {}, { required = false } = {}) {
  if (!enabled()) {
    if (required) throw new Error("EMAIL_API_URL/EMAIL_API_KEY not configured");
    return { skipped: true, reason: "email api not configured" };
  }
  const base = BASE();
  const parsed = new URL(base);
  if (parsed.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && process.env.EMAIL_API_ALLOW_INSECURE === "true")) {
    throw new Error("EMAIL_API_URL must use HTTPS");
  }
  const body = JSON.stringify({ to, template, vars });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString("hex");
  const signature = crypto.createHmac("sha256", KEY()).update(`v1\n${timestamp}\n${nonce}\n${body}`).digest("hex");
  const res = await fetch(base + "/send.php", {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      "X-Email-Timestamp": timestamp,
      "X-Email-Nonce": nonce,
      "X-Email-Signature": signature
    },
    body,
    signal: AbortSignal.timeout(8000)
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(`email api HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (!json || json.success !== true) throw new Error("email api returned an invalid delivery acknowledgement");
  return json;
}

// ── Account lifecycle ────────────────────────────────────────────────────────

/** A1: signup / resend verification. Caller stores tokenHash on the user. */
async function sendVerifyEmail(user, { companyName }) {
  const { token, hash } = newActionToken();
  const out = await send(user.email, "verify_email", {
    companyName,
    actionUrl: actionUrl("/verify-email", token)
  });
  return { ...out, tokenHash: hash, expiresIn: 86400 };
}

/** A1 follow-up: welcome after verification. */
function sendWelcome(user, { companyName }) {
  return send(user.email, "welcome", { companyName });
}

/** A3: team invitation. Caller stores the Invitation + tokenHash. */
async function sendTeamInvite({ to, companyName, role, inviter }) {
  const { token, hash } = newActionToken();
  const out = await send(to, "team_invite", {
    companyName, role, inviter,
    actionUrl: actionUrl("/accept-invite", token)
  });
  return { ...out, tokenHash: hash, expiresIn: 259200 };
}

/** A2: password reset. Uniform-response caller; email only sent if user exists. */
async function sendPasswordReset(user, { ip }) {
  const { token, hash } = newActionToken();
  const out = await send(user.email, "password_reset", {
    requestedAt: new Date().toISOString(),
    ip,
    actionUrl: actionUrl("/reset-password", token)
  });
  return { ...out, tokenHash: hash, expiresIn: 1800 };
}

// ── Security notifications (non-suppressible) ───────────────────────────────

function sendPasswordChanged(user, { ip }) {
  return send(user.email, "password_changed", { changedAt: new Date().toISOString(), ip });
}

function sendEmailChangeNotice(user, { newEmail }) {
  const { token, hash } = newActionToken();
  const masked = newEmail.replace(/^(.{1,2}).*(@.*)$/, "$1***$2");
  return send(user.email, "email_change_notice", {
    newEmailMasked: masked,
    requestedAt: new Date().toISOString(),
    actionUrl: actionUrl("/cancel-email-change", token)
  }).then(out => ({ ...out, tokenHash: hash, expiresIn: 86400 }));
}

function sendMfaChanged(user, { changeKind, ip }) {
  return send(user.email, "mfa_changed", { changeKind, changedAt: new Date().toISOString(), ip });
}

function sendNewSignin(user, { ip, device }) {
  return send(user.email, "new_signin", { signedInAt: new Date().toISOString(), ip, device });
}

// ── Operational (tenant) ─────────────────────────────────────────────────────

function sendApiKeyEvent(user, { companyName, environment, keyAction, keyPrefix, actor }) {
  return send(user.email, "api_key_event", {
    companyName, environment, keyAction, keyPrefix, actor, changedAt: new Date().toISOString()
  });
}

function sendWebhookChanged(user, { companyName, endpointHost, secretRotated, actor }) {
  return send(user.email, "webhook_changed", {
    companyName, endpointHost, secretRotated: secretRotated ? "yes" : "no", actor, changedAt: new Date().toISOString()
  });
}

function sendWebhookFailing(user, { endpointHost, errorClass, attempts }) {
  return send(user.email, "webhook_failing", {
    endpointHost, errorClass, attempts: String(attempts), failedAt: new Date().toISOString()
  });
}

function sendReviewWaiting(user, { companyName, pendingCount, oldestWait }) {
  return send(user.email, "review_waiting", { companyName, pendingCount: String(pendingCount), oldestWait });
}

function sendReviewSecondConfirmation(user, { proposer, proposedDecision, caseAge }) {
  return send(user.email, "review_second_confirmation", { proposer, proposedDecision, caseAge });
}

function sendProductionRequestOps(opsAddress, { companyName, tenantUid, contactEmail, checklistSummary, testSessions }) {
  return send(opsAddress, "production_request_ops", {
    companyName, tenantUid, contactEmail, checklistSummary, testSessions: String(testSessions)
  });
}

function sendProductionDecision(user, { decision, reasonText }) {
  return send(user.email, "production_decision", { decision, reasonText, decidedAt: new Date().toISOString() });
}

function sendWorkspaceStatus(user, { companyName, statusChange, reasonCategory }) {
  return send(user.email, "workspace_status", {
    companyName, statusChange, effectiveAt: new Date().toISOString(), reasonCategory
  });
}

function sendEvidencePurgeNotice(user, { caseCount, purgeDate, policySummary }) {
  return send(user.email, "evidence_purge_notice", { caseCount: String(caseCount), purgeDate, policySummary });
}

// ── Compliance ───────────────────────────────────────────────────────────────

function sendDeletionCompleted(user, { auditRef, sessionsAffected, filesDeleted }) {
  return send(user.email, "deletion_completed", {
    auditRef, sessionsAffected: String(sessionsAffected), filesDeleted: String(filesDeleted),
    completedAt: new Date().toISOString()
  });
}

function sendIncidentNotice(user, { windowStart, windowEnd, dataCategories, actionsTaken, tenantActions, incidentRef }) {
  return send(user.email, "incident_notice", { windowStart, windowEnd, dataCategories, actionsTaken, tenantActions, incidentRef });
}

function sendWeeklyDigest(user, { companyName, totalVerifications, approvedCount, rejectedCount, reviewCount, topReasons, queueDepth, webhookHealth }) {
  return send(user.email, "weekly_digest", {
    companyName,
    totalVerifications: String(totalVerifications),
    approvedCount: String(approvedCount),
    rejectedCount: String(rejectedCount),
    reviewCount: String(reviewCount),
    topReasons,
    queueDepth: String(queueDepth),
    webhookHealth
  });
}

// ── Platform ops ─────────────────────────────────────────────────────────────

function sendOpsAlert(opsAddress, { signal, hostId, firstSeen, lastSeen, detail }) {
  return send(opsAddress, "ops_alert", { signal, hostId, firstSeen, lastSeen, detail });
}

module.exports = {
  enabled, send, newActionToken, actionUrl,
  sendVerifyEmail, sendWelcome, sendTeamInvite, sendPasswordReset,
  sendPasswordChanged, sendEmailChangeNotice, sendMfaChanged, sendNewSignin,
  sendApiKeyEvent, sendWebhookChanged, sendWebhookFailing,
  sendReviewWaiting, sendReviewSecondConfirmation,
  sendProductionRequestOps, sendProductionDecision, sendWorkspaceStatus, sendEvidencePurgeNotice,
  sendDeletionCompleted, sendIncidentNotice, sendWeeklyDigest, sendOpsAlert
};
