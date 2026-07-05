"use strict";

// Dashboard users: scrypt password hashing (OWASP-approved KDF, in node:crypto
// so no native build issues on cPanel) + login with optional TOTP MFA.

const crypto = require("crypto");
const { AppError } = require("@verifypass/shared");
const { getDb } = require("../lib/db");
const { verifyTotp } = require("./totp");

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString("hex");
  return `scrypt$${SCRYPT.N}$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [scheme, nStr, salt, hash] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const computed = crypto.scryptSync(password, salt, SCRYPT.keylen, { ...SCRYPT, N: Number(nStr) }).toString("hex");
  const a = Buffer.from(hash);
  const b = Buffer.from(computed);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const ROLES = ["super_admin", "tenant_admin", "compliance_reviewer", "developer", "auditor"];

async function createUser({ tenantId, email, password, role }) {
  if (!ROLES.includes(role)) throw new AppError("VALIDATION_ERROR", `role must be one of ${ROLES.join(", ")}`);
  if (!password || password.length < 12) throw new AppError("VALIDATION_ERROR", "password must be at least 12 characters");
  return getDb().user.create({
    data: {
      tenantId: role === "super_admin" ? null : tenantId,
      email: String(email).toLowerCase(),
      passwordHash: hashPassword(password),
      role,
      status: "active"
    }
  });
}

/**
 * Verify credentials (+ TOTP when enrolled). Identical error for every
 * failure mode — no user enumeration.
 */
async function authenticate({ email, password, totp }) {
  const fail = () => new AppError("FORBIDDEN", "Invalid credentials");
  const user = await getDb().user.findFirst({ where: { email: String(email || "").toLowerCase(), status: "active" } });
  if (!user || !verifyPassword(password || "", user.passwordHash)) throw fail();
  if (user.mfaSecret) {
    if (!verifyTotp(user.mfaSecret, totp)) throw fail();
  }
  return user;
}

module.exports = { hashPassword, verifyPassword, createUser, authenticate, ROLES };
