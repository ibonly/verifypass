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

function signSdkToken(sessionUid) {
  const raw = crypto.randomBytes(24).toString("base64url");
  const token = `sdk_${raw}`;
  const tokenHash = crypto.createHmac("sha256", config.sdkTokenSecret).update(`${sessionUid}.${token}`).digest("hex");
  return { token, tokenHash };
}

function verifySdkToken(sessionUid, token, tokenHash) {
  const expected = crypto.createHmac("sha256", config.sdkTokenSecret).update(`${sessionUid}.${token}`).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(tokenHash || ""));
}

/** Create a verification session for the authenticated tenant (PRD §9.3/§12.1). */
async function createSession(scopedDb, body, isLive) {
  validateCreatePayload(body || {});
  const sessionUid = uid("vps");
  const { token, tokenHash } = signSdkToken(sessionUid);
  const expiresAt = new Date(Date.now() + config.sessionTtlMinutes * 60 * 1000);
  const livenessChallenge = generateLivenessChallenge();

  await scopedDb.sessions.create({
    sessionUid,
    status: "created",
    customerReference: body.customerReference || null,
    verificationType: body.verificationType || "ID_AND_FACE",
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
    livenessChallenge: { actions: livenessChallenge.actions, nonce: livenessChallenge.nonce },
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

module.exports = { createSession, getSession, signSdkToken, verifySdkToken, validateCreatePayload, attachDeviceInfo };
