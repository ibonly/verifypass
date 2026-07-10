"use strict";

// Shared evidence encryption primitives (AES-256-GCM) used by both the API
// (writes evidence) and the worker (reads it for verification).
// File layout: [12B iv][16B auth tag][ciphertext]

const crypto = require("crypto");

function encryptBuffer(buffer, keyBuf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBuf, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

function decryptBuffer(raw, keyBuf) {
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBuf, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** 64-hex-char key → Buffer; dev fallback derives a stable key from a secret. */
function resolveEvidenceKey({ keyHex, fallbackSecret, production = false }) {
  if (keyHex && /^[0-9a-fA-F]{64}$/.test(keyHex)) return Buffer.from(keyHex, "hex");
  if (production) throw new Error("EVIDENCE_ENCRYPTION_KEY must be 64 hex chars in production");
  return crypto.createHash("sha256").update(`evidence:${fallbackSecret}`).digest();
}

module.exports = { encryptBuffer, decryptBuffer, resolveEvidenceKey };
