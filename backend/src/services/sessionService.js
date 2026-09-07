"use strict";

const crypto = require("crypto");
const { AppError, DOCUMENT_TYPES, generateLivenessChallenge } = require("@verifypass/shared");
const { uid } = require("../lib/ids");
const config = require("../config");

const { addOutbox, flushOutbox } = require("./outbox");
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
  const livenessChallenge = verificationType === "ID_ONLY" ? null : generateLivenessChallenge({ supportsExpressions: config.challengeExpressions });

  const created = await scopedDb.sessions.create({
    sessionUid,
    status: "created",
    customerReference: body.customerReference || null,
    verificationType,
    documentTypes: body.documentTypes || null,
    callbackUrl: body.callbackUrl || null,
    metadata: body.metadata || null,
    sdkTokenHash: tokenHash,
    livenessChallenge,
    attemptId: crypto.randomUUID(), attemptNumber: 1, reissueCount: 0, revision: 0,
    isLive,
    expiresAt
  });

  return {
    success: true,
    sessionId: sessionUid,
    attemptId: created.attemptId,
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
async function attachDeviceInfo(scopedDb, tenantUid, sessionUid, device, clientIp, capture, telemetry) {
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
  // P0 capture integrity: camera/track metadata reported by the SDK at
  // submit. Whitelisted + size-bounded; the worker re-checks the label
  // server-side, so the client-computed flag alone is never trusted.
  if (capture && typeof capture === "object") {
    const cap = {};
    if (typeof capture.cameraLabel === "string") cap.cameraLabel = capture.cameraLabel.slice(0, 120);
    if (typeof capture.facingMode === "string") cap.facingMode = capture.facingMode.slice(0, 20);
    if (typeof capture.frameRate === "number") cap.frameRate = capture.frameRate;
    if (typeof capture.resolution === "string") cap.resolution = capture.resolution.slice(0, 20);
    if (typeof capture.videoInputCount === "number") cap.videoInputCount = capture.videoInputCount;
    if (typeof capture.hasCapabilities === "boolean") cap.hasCapabilities = capture.hasCapabilities;
    if (typeof capture.virtualCameraSuspected === "boolean") cap.virtualCameraSuspected = capture.virtualCameraSuspected;
    if (Object.keys(cap).length) {
      meta = meta || {};
      meta.capture = cap;
    }
  }
  // v5 E1: capture telemetry from the widget (how frames were taken). Bounded
  // and whitelisted; feeds risk signals (instant triggers, manual use) and
  // the developer/review views. Never trusted for the decision itself.
  if (telemetry && typeof telemetry === "object") {
    const tel = {};
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
    for (const k of ["detectMs", "landmarkMs", "modelLoadMs", "totalMs"]) if (num(telemetry[k]) !== null) tel[k] = num(telemetry[k]);
    if (Array.isArray(telemetry.actions)) {
      tel.actions = telemetry.actions.slice(0, 8).map((a) => ({
        action: typeof a.action === "string" ? a.action.slice(0, 20) : null,
        msToTrigger: num(a.msToTrigger),
        wrongWay: num(a.wrongWay) ?? 0,
        hints: Array.isArray(a.hints) ? a.hints.slice(0, 6).map((h) => String(h).slice(0, 16)) : [],
        frames: num(a.frames) ?? 0,
        mode: ["auto", "manual", "fallback"].includes(a.mode) ? a.mode : "unknown",
        reissued: a.reissued === true
      }));
    }
    if (Object.keys(tel).length) { meta = meta || {}; meta.telemetry = tel; }
  }
  if (!fingerprint && !meta && !clientIp) return false;

  await scopedDb.sessions.update(sessionUid, {
    ...(fingerprint || meta ? { ...(fingerprint ? { deviceFingerprint: fingerprint } : {}), deviceMeta: meta } : {}),
    ...(clientIp ? { clientIp: String(clientIp).slice(0, 64) } : {})
  });
  return true;
}

// --- Retry flow (end-user "try again" after rejected/review/failed) --------

const RETRY_MAX_ATTEMPTS = 5;        // total attempts (1 initial + 4 retries)
const REISSUE_MAX_PER_SESSION = 2;   // "I can't do this movement" swaps per session

/**
 * Reissue the liveness challenge mid-capture, excluding actions the user
 * cannot perform (v5 D3). New nonce → frames for the old challenge are
 * superseded (the worker's nonce fence). Audited; capped per session; the
 * decision engine routes reissued sessions to review only when other signals
 * are borderline (the reissue count travels in rawResult via the audit log).
 */
async function reissueChallenge(scopedDb, sessionUid, sdkToken, { excludeActions = [], tenantId, actorId = null, req = null, attemptId } = {}) {
  return scopedDb.transaction(async scope => {
    const session = await scope.sessions.findByUid(sessionUid);
    validateAttempt(session, sdkToken, attemptId);
    if (!["created", "started"].includes(session.status) || session.verificationType === "ID_ONLY") throw new AppError("VALIDATION_ERROR", "Cannot reissue this challenge");
    if (session.expiresAt && new Date(session.expiresAt) < new Date()) throw new AppError("SESSION_EXPIRED");
    const prior = Math.max(session.reissueCount || 0, (await scope.auditLogs.list({ sessionId: session.id, action: "challenge.reissued" })).length);
    if (prior >= REISSUE_MAX_PER_SESSION) throw new AppError("VALIDATION_ERROR", "Challenge reissue limit reached");
    if (!Array.isArray(excludeActions) || excludeActions.length !== 1 || !session.livenessChallenge?.actions?.includes(excludeActions[0])) throw new AppError("VALIDATION_ERROR", "Select one movement from the current challenge");
    let challenge;
    try { challenge = generateLivenessChallenge({ excludeActions, supportsExpressions: config.challengeExpressions }); }
    catch (err) { throw new AppError("VALIDATION_ERROR", err.message); }
    challenge.assisted = true;
    const nextAttempt = crypto.randomUUID();
    // Preserve document captures when only the movement challenge is replaced.
    const documents = await scope.db.evidenceFile.findMany({ where: { sessionId: session.id, ...(session.attemptId ? { attemptId: session.attemptId } : {}), fileType: { in: ["id_front", "id_back"] } } });
    for (const file of documents) {
      if (session.attemptId && !require("@verifypass/shared").verifyFrameBinding(config.sdkTokenSecret, { challengeNonce: file.challengeNonce, action: file.label || file.fileType, checksum: file.checksum, bindingHmac: file.bindingHmac, context: [session.tenantId, session.id, session.attemptId, file.fileType, file.captureMode || null, file.meta || null] })) throw new AppError("VALIDATION_ERROR", "Document integrity could not be verified; start a new attempt");
      const bindingHmac = require("@verifypass/shared").computeFrameBinding(config.sdkTokenSecret, challenge.nonce, file.label || file.fileType, file.checksum, [session.tenantId, session.id, nextAttempt, file.fileType, file.captureMode || null, file.meta || null]);
      await scope.db.evidenceFile.update({ where: { id: file.id }, data: { attemptId: nextAttempt, challengeNonce: challenge.nonce, bindingHmac } });
    }
    await scope.sessions.update(sessionUid, { livenessChallenge: challenge, attemptId: nextAttempt, reissueCount: prior + 1, revision: { increment: 1 } });
    await scope.db.auditLog.create({ data: { tenantId: scope.tenantId, sessionId: session.id, actorType: "api", actorId, action: "challenge.reissued", metadata: { reissue: prior + 1, excludeActions } } });
    return { success: true, sessionId: sessionUid, attemptId: nextAttempt, reissue: prior + 1, reissuesRemaining: REISSUE_MAX_PER_SESSION - prior - 1, livenessChallenge: challenge };
  });
}
function validateAttempt(session, sdkToken, attemptId) {
  if (!session) throw new AppError("SESSION_NOT_FOUND");
  if (!sdkToken || !verifySdkToken(session.sessionUid, sdkToken, session.sdkTokenHash)) throw new AppError("INVALID_API_KEY");
  if (session.attemptId && attemptId !== session.attemptId) {
    throw new AppError("VALIDATION_ERROR", attemptId
      ? "Attempt changed; reload the verification"
      : "attemptId is required for this session — send the value returned by POST /verification-sessions or GET /challenge");
  }
}

/**
 * Start the liveness clock when the user actually reaches the liveness step.
 * The challenge is issued at session creation, but consent, camera permission
 * and document capture can take minutes, and an integrator may create the
 * session long before the user opens the link. Refreshing issuedAt here
 * anchors the challenge TTL and the issue→first-frame window to the moment
 * capture can begin. Only allowed while NO frame exists for the current
 * challenge, so it can never extend a challenge that already carries
 * evidence; the nonce is unchanged so document bindings survive. Idempotent.
 */
async function beginChallenge(scopedDb, sessionUid, sdkToken, { attemptId } = {}) {
  const { DEFAULT_TTL_MS, SEQUENCE_LIMITS } = require("@verifypass/shared");
  return scopedDb.transaction(async scope => {
    const session = await scope.sessions.findByUid(sessionUid);
    validateAttempt(session, sdkToken, attemptId);
    if (!["created", "started"].includes(session.status)) throw new AppError("VALIDATION_ERROR", `cannot begin a challenge in status '${session.status}'`);
    if (session.expiresAt && new Date(session.expiresAt) < new Date()) throw new AppError("SESSION_EXPIRED");
    const current = session.livenessChallenge;
    if (!current || !Array.isArray(current.actions) || !current.actions.length) throw new AppError("VALIDATION_ERROR", "This session has no liveness challenge");
    const frames = await scope.db.evidenceFile.findMany({ where: { sessionId: session.id, fileType: "liveness_frame", challengeNonce: current.nonce } });
    let challenge = current;
    let refreshed = false;
    if (frames.length === 0) {
      const now = new Date();
      challenge = { ...current, issuedAt: now.toISOString(), begunAt: now.toISOString() };
      await scope.sessions.update(sessionUid, { livenessChallenge: challenge, revision: { increment: 1 } });
      await scope.db.auditLog.create({ data: { tenantId: scope.tenantId, sessionId: session.id, actorType: "api", action: "challenge.begun", metadata: { previousIssuedAt: current.issuedAt || null } } });
      refreshed = true;
    }
    const issued = challenge.issuedAt ? new Date(challenge.issuedAt).getTime() : NaN;
    const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
    return {
      success: true, sessionId: sessionUid, attemptId: session.attemptId || null, refreshed,
      challengeIssuedAt: challenge.issuedAt || null,
      challengeExpiresAt: iso(issued + DEFAULT_TTL_MS),
      firstFrameDeadline: iso(issued + SEQUENCE_LIMITS.maxIssueToFirstMs),
      sessionExpiresAt: session.expiresAt ? new Date(session.expiresAt).toISOString() : null
    };
  });
}
async function submitSession(scope, sessionUid, sdkToken, attemptId, metadata = {}) {
  const result = await scope.transaction(async tx => {
    const session = await tx.sessions.findByUid(sessionUid);
    validateAttempt(session, sdkToken, attemptId);
    if (session.status === "submitted") return { success: true, sessionId: sessionUid, status: "submitted" };
    if (session.status !== "started") throw new AppError("VALIDATION_ERROR", "Upload captures before submitting");
    if (session.expiresAt && new Date(session.expiresAt) < new Date()) throw new AppError("SESSION_EXPIRED");
    if (session.livenessChallenge && !require("@verifypass/shared").isChallengeFresh(session.livenessChallenge)) throw new AppError("SESSION_EXPIRED", "Challenge expired; start a new verification");
    if (config.requireConsent && !session.consentAt) throw new AppError("VALIDATION_ERROR", "Consent is required");
    await attachDeviceInfo(tx, metadata.tenantUid, sessionUid, metadata.device, metadata.clientIp, metadata.capture, metadata.telemetry);
    await tx.sessions.update(sessionUid, { status: "submitted", submittedAt: new Date(), revision: { increment: 1 } });
    await addOutbox(tx.db, "run_verification", { sessionUid, tenantId: tx.tenantId, attemptId: session.attemptId || null, policyVersion: require("../lib/release").policyVersion });
    await tx.db.auditLog.create({ data: { tenantId: tx.tenantId, sessionId: session.id, actorType: "api", action: "session.submitted" } });
    return { success: true, sessionId: sessionUid, status: "submitted" };
  });
  await flushOutbox(scope.db, require("./jobService").enqueue, 1).catch(() => {});
  return result;
}
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
async function retrySession(scopedDb, sessionUid, sdkToken, { tenantId, actorId = null, req = null, attemptId } = {}) {
  return scopedDb.transaction(async scope => {
    const session = await scope.sessions.findByUid(sessionUid);
    validateAttempt(session, sdkToken, attemptId);
    if (!["rejected", "manual_review", "failed"].includes(session.status)) throw new AppError("VALIDATION_ERROR", `cannot retry a session in status '${session.status}'`);
    const attemptsUsed = Math.max(session.attemptNumber || 1, (await scope.auditLogs.list({ sessionId: session.id, action: "session.retry" })).length + 1);
    if (attemptsUsed >= RETRY_MAX_ATTEMPTS) throw new AppError("RETRY_LIMIT_REACHED");
    const previousStatus = session.status;
    const previousReasonCodes = session.decisionReason?.reasonCodes || [];
    const challenge = session.verificationType === "ID_ONLY" ? null : generateLivenessChallenge({ supportsExpressions: config.challengeExpressions });
    const nextAttempt = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + config.sessionTtlMinutes * 60 * 1000);
    await scope.sessions.update(sessionUid, { status: "started", completedAt: null, submittedAt: null, decisionReason: null, livenessChallenge: challenge, attemptId: nextAttempt, attemptNumber: attemptsUsed + 1, revision: { increment: 1 }, expiresAt, deviceFingerprint: null, deviceMeta: null });
    await scope.db.auditLog.create({ data: { tenantId: scope.tenantId, sessionId: session.id, actorType: "api", actorId, action: "session.retry", metadata: { attempt: attemptsUsed + 1, previousStatus, previousReasonCodes } } });
    return { success: true, sessionId: sessionUid, status: "started", attemptId: nextAttempt, attempts: attemptsUsed + 1, maxAttempts: RETRY_MAX_ATTEMPTS, attemptsRemaining: RETRY_MAX_ATTEMPTS - attemptsUsed - 1, manualUploadSuggested: attemptsUsed + 1 > RETRY_MANUAL_UPLOAD_AFTER, livenessChallenge: challenge, expiresAt: expiresAt.toISOString() };
  });
}

/**
 * Record the end user's biometric-processing consent (NDPA lawful basis;
 * CBN-aligned CDD proof). Set-once and idempotent: the FIRST acceptance is
 * the legal record — later calls return it unchanged. Audit-logged with
 * IP/user-agent so "prove this customer consented" has a real answer.
 */
async function recordConsent(scopedDb, sessionUid, sdkToken, { copyVersion = null, req = null } = {}) {
  return scopedDb.transaction(async scope => {
    const session = await scope.sessions.findByUid(sessionUid);
    if (!session) throw new AppError("SESSION_NOT_FOUND");
    if (!sdkToken || !verifySdkToken(sessionUid, sdkToken, session.sdkTokenHash)) throw new AppError("INVALID_API_KEY");
    if (session.consentAt) return { success: true, sessionId: sessionUid, consentAt: new Date(session.consentAt).toISOString(), alreadyRecorded: true };
    const consentAt = new Date();
    const consentMeta = { copyVersion: typeof copyVersion === "string" ? copyVersion.slice(0,128) : null, ip: req ? String(req.ip || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "").slice(0,64) : null, userAgent: req ? String(req.headers["user-agent"] || "").slice(0,512) : null };
    await scope.sessions.update(sessionUid, { consentAt, consentMeta });
    await scope.db.auditLog.create({ data: { tenantId: scope.tenantId, sessionId: session.id, actorType: "api", action: "session.consent", metadata: { copyVersion: consentMeta.copyVersion } } });
    return { success: true, sessionId: sessionUid, consentAt: consentAt.toISOString(), alreadyRecorded: false };
  });
}

module.exports = {
  createSession, getSession, signSdkToken, verifySdkToken, validateCreatePayload, attachDeviceInfo,
  submitSession, validateAttempt, retrySession, RETRY_MAX_ATTEMPTS, RETRY_MANUAL_UPLOAD_AFTER,
  reissueChallenge, REISSUE_MAX_PER_SESSION, beginChallenge,
  recordConsent
};
