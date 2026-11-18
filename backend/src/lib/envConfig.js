"use strict";

function isStrictEnv() {
  const env = process.env.NODE_ENV || "development";
  return env !== "development" && env !== "test";
}

function requireSecret(name, fallback) {
  const value = process.env[name] || fallback;
  if (isStrictEnv()) {
    if (!process.env[name] || value.startsWith("dev-only-") || value.startsWith("change-me-") || value.length < 32) {
      throw new Error(`${name} must be set to a random 32+ character value in ${process.env.NODE_ENV}`);
    }
  }
  return value;
}

function requireEvidenceKey() {
  const value = process.env.EVIDENCE_ENCRYPTION_KEY || null;
  if (isStrictEnv() && !/^[0-9a-fA-F]{64}$/.test(value || "")) {
    throw new Error(`EVIDENCE_ENCRYPTION_KEY must be 64 hex chars in ${process.env.NODE_ENV}`);
  }
  return value;
}

module.exports = { isStrictEnv, requireSecret, requireEvidenceKey };
