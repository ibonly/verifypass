"use strict";

const crypto = require("crypto");
const { AppError } = require("@verifypass/shared");
const { getDb } = require("../lib/db");

const KEY_RE = /^vp_(pub|sec)_(live|test)_([A-Za-z0-9]{32})$/;

function hashKey(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

/** First 16 chars — enough for indexed lookup without storing the key. */
function keyPrefix(key) {
  return key.slice(0, 16);
}

/**
 * Generate a new API key. Returns the plaintext key ONCE; only hash+prefix
 * are stored.
 * @param {"public"|"secret"} keyType
 * @param {boolean} isLive
 */
function generateKey(keyType, isLive) {
  const kind = keyType === "public" ? "pub" : "sec";
  const env = isLive ? "live" : "test";
  const rand = crypto.randomBytes(24).toString("base64url").replace(/[-_]/g, "0").slice(0, 32);
  const key = `vp_${kind}_${env}_${rand}`;
  return { key, keyHash: hashKey(key), prefix: keyPrefix(key) };
}

function parseKey(key) {
  const m = typeof key === "string" && key.match(KEY_RE);
  if (!m) return null;
  return { keyType: m[1] === "pub" ? "public" : "secret", isLive: m[2] === "live" };
}

/** Create and persist a key for a tenant. Returns plaintext key once. */
async function issueKey(tenantId, keyType, isLive) {
  const { key, keyHash, prefix } = generateKey(keyType, isLive);
  const record = await getDb().apiKey.create({
    data: { tenantId, keyType, isLive, keyHash, prefix, status: "active" }
  });
  return { key, id: record.id, prefix };
}

/**
 * Resolve an API key to its tenant. Throws INVALID_API_KEY on any failure —
 * same error whether key is malformed, unknown, revoked, or expired
 * (no information leakage).
 */
async function resolveKey(key, expectedType) {
  const parsed = parseKey(key);
  if (!parsed || (expectedType && parsed.keyType !== expectedType)) {
    throw new AppError("INVALID_API_KEY");
  }
  const db = getDb();
  const record = await db.apiKey.findFirst({
    where: { prefix: keyPrefix(key), keyHash: hashKey(key), status: "active" },
    include: { tenant: true }
  });
  if (!record) throw new AppError("INVALID_API_KEY");
  if (record.expiresAt && record.expiresAt < new Date()) throw new AppError("INVALID_API_KEY");
  const t = record.tenant;
  if (!t || t.status === "suspended" || t.status === "disabled") {
    throw new AppError("INVALID_API_KEY");
  }
  return { tenant: t, apiKey: record, isLive: record.isLive, keyType: record.keyType };
}

/** Revoke a key (tenant-scoped: caller must pass the tenant id). */
async function revokeKey(tenantId, keyId) {
  const db = getDb();
  const res = await db.apiKey.updateMany({
    where: { id: keyId, tenantId, status: "active" },
    data: { status: "revoked", revokedAt: new Date() }
  });
  if (!res.count) throw new AppError("NOT_FOUND", "API key not found");
}

/** Rotate: issue replacement, then revoke old. Returns the new plaintext key. */
async function rotateKey(tenantId, keyId) {
  const db = getDb();
  const old = await db.apiKey.findFirst({ where: { id: keyId, tenantId, status: "active" } });
  if (!old) throw new AppError("NOT_FOUND", "API key not found");
  const issued = await issueKey(tenantId, old.keyType, old.isLive);
  await revokeKey(tenantId, keyId);
  return issued;
}

/** Delete a key permanently (only revoked keys may be deleted). */
async function deleteKey(tenantId, keyId) {
  const db = getDb();
  const key = await db.apiKey.findFirst({ where: { id: keyId, tenantId } });
  if (!key) throw new AppError("NOT_FOUND", "API key not found");
  if (key.status === "active") throw new AppError("VALIDATION_ERROR", "Revoke the key before deleting it");
  await db.apiKey.delete({ where: { id: keyId } });
}

module.exports = {
  generateKey, parseKey, hashKey, keyPrefix,
  issueKey, resolveKey, revokeKey, rotateKey, deleteKey
};
