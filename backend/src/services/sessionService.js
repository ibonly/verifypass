"use strict";

const crypto = require("crypto");
const { AppError, DOCUMENT_TYPES, generateLivenessChallenge } = require("@verifypass/shared");
const { uid } = require("../lib/ids");
const config = require("../config");

const VERIFICATION_TYPES = ["ID_AND_FACE", "FACE_ONLY", "ID_ONLY"];

function validateCreatePayload(body) {
  const errors = [];
  if (body.verificationType && !VERIFICATION_TYPES.includes(body.verificationType)) {
    errors.push(`verificationType must be one of ${VERIFICATION_TYPES.join(", ")}`);
  }
  if (body.documentTypes) {
    if (!Array.isArray(body.documentTypes)) {
      errors.push("documentTypes must be an array");
    } else {
      const bad = body.documentTypes.filter((d) => !DOCUMENT_TYPES.includes(d));
      if (bad.length) errors.push(`unsupported documentTypes: ${bad.join(", ")}`);
    }
  }
  if (body.customerReference && String(body.customerReference).length > 128) {
    errors.push("customerReference too long (max 128)");
  }
  if (body.callbackUrl) {
    try {
      const u = new URL(body.callbackUrl);
      if (u.protocol !== "https:" && process.env.NODE_ENV === "production") {
        errors.push("callbackUrl must be https");
      }
    } catch (_) {
      errors.push("callbackUrl is not a valid URL");
    }
  }
  if (errors.length) throw new AppError("VALIDATION_ERROR", "Request validation failed", { errors });
}

function signSdkToken(sessionUid, publicApiUrl = config.apiPublicUrl) {
  // Self-locating v1 token: embeds this deployment's public API origin so the
  // browser SDK derives its endpoint from the token alone — the environment
  // (sandbox/production/self-hosted) travels with the credential, and the
  // consumer never configures a baseUrl. The HMAC covers the FULL token
  // string, so the embedded origin is tamper-evident.
  const raw = crypto.randomBytes(24).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ u: publicApiUrl, t: raw })).toString("base64url");
  const token = `sdk_v1_${payload}`;
  const tokenHash = crypto.createHmac("sha256", config.sdkTokenSecret).update(`${sessionUid}.${token}`).digest("hex");
  return { token, tokenHash };
}

function verifySdkToken(sessionUid, token, tokenHash) {
  if (!tokenHash) return false; // null/undefined hash → no valid token was ever issued
  const expected = crypto.createHmac("sha256", config.sdkTokenSecret).update(`${sessionUid}.${token}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(tokenHash);
  // timingSafeEqual throws on length mismatch — guard it for a clean 401
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Create a verification session for the authenticated tenant (PRD §9.3/§12.1). */
async function createSession(scopedDb, body, isLive, options = {}) {
  validateCreatePayload(body || {});
  const sessionUid = uid("vps");
  const { token, tokenHash } = signSdkToken(sessionUid, options.publicApiUrl);
  const expiresAt = new Date(Date.now() + config.sessionTtlMinutes * 60 * 1000);
  // ID_ONLY has NO liveness step — issuing a challenge it can never complete
  // guarantees LIVENESS_CHALLENGE_INCOMPLETE hard-rejects at verification.
  const verificationType = body.verificationType || "ID_AND_FACE";
  const livenessChallenge = verificationType === "ID_ONLY" ? null : generateLivenessChallenge();

  await scopedDb.sessions.create({
    sessionUid,
    status: "created",
    customerReference: body.customerReference || null,
    verificationType,
    documentTypes: body.documentTypes || null,
    callbackUrl: body.callbackUrl || null,
    metadata: body.metadata || null,
    sdkTokenHash: tokenHash,
    livenessChallenge,
    isLive,
    expiresAt
  });

  return {
    success: true,
    sessionId: sessionUid,
    status: "created",
    sdkToken: token,
    // Active-liveness actions the client SDK must guide the user through, in
    // order. Verified server-side on the uploaded frames (never client-trusted).
    // null for ID_ONLY — that flow has no liveness step.
    livenessChallenge: livenessChallenge
      ? { actions: livenessChallenge.actions, nonce: livenessChallenge.nonce }
      : null,
    // token travels in the URL FRAGMENT — browsers never send fragments to
    // servers, so it stays out of access logs and referrers
    hostedUrl: `${config.hostedBaseUrl}/session/${sessionUid}#t=${token}`,
    expiresAt: expiresAt.toISOString()
  };
}

/** Fetch a session; 404 for unknown OR other-tenant sessions (isolation). */
async function getSession(scopedDb, sessionUid) {
  const s = await scopedDb.sessions.findByUid(sessionUid);
  if (!s) throw new AppError("SESSION_NOT_FOUND");
  // Lazy expiry on read (worker sweep also runs; this covers the gap)
  if (["created", "started"].includes(s.status) && s.expiresAt && new Date(s.expiresAt) < new Date()) {
    await scopedDb.sessions.update(sessionUid, { status: "expired" });
    s.status = "expired";
  }
  return {
    success: true,
    sessionId: s.sessionUid,
    status: s.status,
    customerReference: s.customerReference,
    verificationType: s.verificationType,
    riskLevel: s.riskLevel || null,
    decisionReason: s.decisionReason || null,
    expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null,
    completedAt: s.completedAt ? s.completedAt.toISOString() : null,
    createdAt: s.createdAt ? s.createdAt.toISOString() : null
  };
}

/**
 * Persist device signals + client IP on a session (set once — first write
 * wins so later requests can't overwrite the fingerprint that risk checks
 * will use). The fingerprint hash is computed SERVER-side from the raw
 * signals, salted per tenant so it can't be correlated across tenants.
 */
async function attachDeviceInfo(scopedDb, tenantUid, sessionUid, device, clientIp) {
  const session = await scopedDb.sessions.findByUid(sessionUid);
  if (!session || session.deviceFingerprint) return false;

  let fingerprint = null;
  let meta = null;
  if (device && typeof device === "object") {
    const keys = ["userAgent", "language", "languages", "platform", "timezone", "screen", "pixelRatio", "touch", "cores", "memoryGb"];
    meta = {};
    for (const k of keys) if (device[k] !== undefined) meta[k] = device[k];
    const canonical = JSON.stringify(keys.map((k) => [k, meta[k] ?? null]));
    fingerprint = crypto.createHash("sha256").update(`${tenantUid}:${canonical}`).digest("hex");
  }
  if (!fingerprint && !clientIp) return false;

  await scopedDb.sessions.update(sessionUid, {
    ...(fingerprint ? { deviceFingerprint: fingerprint, deviceMeta: meta } : {}),
    ...(clientIp ? { clientIp: String(clientIp).slice(0, 64) } : {})
  });
  return true;
}

// --- Retry flow (end-user "try again" after rejected/review/failed) --------

const RETRY_MAX_ATTEMPTS = 5;        // total attempts (1 initial + 4 retries)
const RETRY_MANUAL_UPLOAD_AFTER = 3; // camera attempts before offering file upload

/**
 * Reopen a terminal-but-retryable session for another attempt.
 * - New captures supersede old ones; prior results + evidence remain as the
 *   attempt log (verificationResult rows accumulate per run).
 * - Attempt count derives from `session.retry` audit rows — the log IS the
 *   counter, and every retry is audit-logged here.
 * - The liveness challenge is REISSUED (a retry must not replay frames
 *   recorded against the previous action sequence); ID_ONLY has none.
 * @returns response payload for the SDK
 */
async function retrySession(scopedDb, sessionUid, sdkToken, { tenantId, actorId = null, req = null } = {}) {
  const { audit } = require("./auditLogger");
  const session = await scopedDb.sessions.findByUid(sessionUid);
  if (!session) throw new AppError("SESSION_NOT_FOUND");
  if (!sdkToken || !verifySdkToken(session.sessionUid, sdkToken, session.sdkTokenHash)) {
    throw new AppError("INVALID_API_KEY", "invalid SDK token for this session");
  }
  if (!["rejected", "manual_review", "failed"].includes(session.status)) {
    throw new AppError("VALIDATION_ERROR", `cannot retry a session in status '${session.status}'`);
  }

  const priorRetries = (await scopedDb.auditLogs.list({
    sessionId: session.id, action: "session.retry"
  })).length;
  const attemptsUsed = priorRetries + 1; // the initial attempt + prior retries
  if (attemptsUsed >= RETRY_MAX_ATTEMPTS) {
    throw new AppError("RETRY_LIMIT_REACHED", `all ${RETRY_MAX_ATTEMPTS} verification attempts used`);
  }

  // Capture BEFORE the update — the fetched row may be a live reference.
  const previousStatus = session.status;
  const previousReasonCodes = session.decisionReason?.reasonCodes || [];

  const livenessChallenge = session.verificationType === "ID_ONLY" ? null : generateLivenessChallenge();
  const expiresAt = new Date(Date.now() + config.sessionTtlMinutes * 60 * 1000);

  await scopedDb.sessions.update(session.sessionUid, {
    status: "started",
    completedAt: null,
    decisionReason: null,
    livenessChallenge,
    expiresAt
  });

  await audit({
    tenantId, sessionId: session.id, actorType: "api", actorId,
    action: "session.retry", req,
    metadata: {
      attempt: attemptsUsed + 1,
      previousStatus,
      previousReasonCodes
    }
  });

  return {
    success: true,
    sessionId: session.sessionUid,
    status: "started",
    attempts: attemptsUsed + 1,
    maxAttempts: RETRY_MAX_ATTEMPTS,
    attemptsRemaining: RETRY_MAX_ATTEMPTS - attemptsUsed - 1,
    // 3 camera attempts exhausted → client should offer document file upload
    manualUploadSuggested: attemptsUsed + 1 > RETRY_MANUAL_UPLOAD_AFTER,
    livenessChallenge: livenessChallenge
      ? { actions: livenessChallenge.actions, nonce: livenessChallenge.nonce }
      : null,
    expiresAt: expiresAt.toISOString()
  };
}

/**
 * Record the end user's biometric-processing consent (NDPA lawful basis;
 * CBN-aligned CDD proof). Set-once and idempotent: the FIRST acceptance is
 * the legal record — later calls return it unchanged. Audit-logged with
 * IP/user-agent so "prove this customer consented" has a real answer.
 */
async function recordConsent(scopedDb, sessionUid, sdkToken, { copyVersion = null, tenantId, req = null } = {}) {
  const { audit } = require("./auditLogger");
  const session = await scopedDb.sessions.findByUid(sessionUid);
  if (!session) throw new AppError("SESSION_NOT_FOUND");
  if (!sdkToken || !verifySdkToken(session.sessionUid, sdkToken, session.sdkTokenHash)) {
    throw new AppError("INVALID_API_KEY", "invalid SDK token for this session");
  }
  if (session.consentAt) {
    return { success: true, sessionId: session.sessionUid, consentAt: new Date(session.consentAt).toISOString(), alreadyRecorded: true };
  }

  const consentAt = new Date();
  // x-forwarded-for is a comma-separated proxy chain — record the CLIENT ip
  // (first hop), same normalization attachDeviceInfo uses.
  const rawIp = req ? String(req.ip || (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "") : "";
  const consentMeta = {
    copyVersion,
    ip: rawIp || null,
    userAgent: req ? (req.headers["user-agent"] || null) : null
  };
  await scopedDb.sessions.update(session.sessionUid, { consentAt, consentMeta });
  await audit({
    tenantId, sessionId: session.id, actorType: "api", action: "session.consent", req,
    metadata: { copyVersion }
  });
  return { success: true, sessionId: session.sessionUid, consentAt: consentAt.toISOString(), alreadyRecorded: false };
}

module.exports = {
  createSession, getSession, signSdkToken, verifySdkToken, validateCreatePayload, attachDeviceInfo,
  retrySession, RETRY_MAX_ATTEMPTS, RETRY_MANUAL_UPLOAD_AFTER,
  recordConsent
};
