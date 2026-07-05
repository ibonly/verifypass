"use strict";

// Encrypted evidence storage (PRD §15.3, §16.3).
// - AES-256-GCM per file (random IV, auth tag) → tamper-evident
// - sha256 checksum of plaintext recorded for integrity/audit
// - files live OUTSIDE public_html under EVIDENCE_DIR/<tenantUid>/<sessionUid>/
// - access only via short-lived HMAC-signed URLs; every read is audited by callers

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const config = require("../config");
const { encryptBuffer, decryptBuffer, resolveEvidenceKey } = require("@verifypass/shared");

const SIGNED_URL_TTL_SECONDS = 15 * 60;

function resolveKey(explicitKey) {
  return resolveEvidenceKey({
    keyHex: explicitKey || config.evidenceEncryptionKey,
    fallbackSecret: config.sdkTokenSecret,
    production: config.env === "production"
  });
}

/**
 * Encrypt and persist an evidence file.
 * @returns {{storagePath: string, checksum: string, retentionExpiresAt: Date}}
 */
async function saveEvidence({ tenantUid, sessionUid, fileType, buffer, retentionDays = 30, baseDir, key }) {
  const dir = path.join(baseDir || config.evidenceDir, tenantUid, sessionUid);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const checksum = crypto.createHash("sha256").update(buffer).digest("hex");
  const fileName = `${fileType}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.enc`;
  const storagePath = path.join(dir, fileName);
  await fs.writeFile(storagePath, encryptBuffer(buffer, resolveKey(key)), { mode: 0o600 });

  const retentionExpiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);
  return { storagePath, checksum, retentionExpiresAt };
}

/** Read and decrypt an evidence file. Throws on tampering (GCM auth failure). */
async function readEvidence(storagePath, { key } = {}) {
  const raw = await fs.readFile(storagePath);
  return decryptBuffer(raw, resolveKey(key));
}

/** Delete evidence (retention job / §12.8 biometric deletion). */
async function deleteEvidence(storagePath) {
  try {
    await fs.unlink(storagePath);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

/** HMAC-signed, expiring access token for one evidence file id. */
function signEvidenceAccess(evidenceId, { ttlSeconds = SIGNED_URL_TTL_SECONDS, secret } = {}) {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${evidenceId}.${expires}`;
  const sig = crypto.createHmac("sha256", secret || config.sdkTokenSecret).update(payload).digest("base64url");
  return { token: `${expires}.${sig}`, expires };
}

function verifyEvidenceAccess(evidenceId, token, { secret } = {}) {
  const [expiresStr, sig] = String(token || "").split(".");
  const expires = Number(expiresStr);
  if (!expires || !sig || expires < Math.floor(Date.now() / 1000)) return false;
  const expected = crypto.createHmac("sha256", secret || config.sdkTokenSecret)
    .update(`${evidenceId}.${expires}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { saveEvidence, readEvidence, deleteEvidence, signEvidenceAccess, verifyEvidenceAccess };
