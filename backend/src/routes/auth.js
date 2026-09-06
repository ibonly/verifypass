"use strict";

const { Router } = require("express");
const { AppError } = require("@verifypass/shared");
const { authenticate, hashPassword } = require("../services/userService");
const { signToken } = require("../services/authTokens");
const { generateTotpSecret, verifyTotp, otpauthUrl } = require("../services/totp");
const { requireUser } = require("../middleware/userAuth");
const { getDb } = require("../lib/db");
const { audit } = require("../services/auditLogger");

const router = Router();
router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

// Nested creation is atomic: a failed/duplicate user cannot leave an orphan tenant.
router.post("/register", async (req, res, next) => {
  try {
    const { companyName, email, password } = req.body || {};
    if (typeof companyName !== "string" || companyName.trim().length < 2 || companyName.trim().length > 120) {
      throw new AppError("VALIDATION_ERROR", "Business name must be 2–120 characters");
    }
    if (typeof email !== "string" || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      throw new AppError("VALIDATION_ERROR", "Enter a valid email address");
    }
    if (typeof password !== "string" || password.length < 12 || password.length > 128) {
      throw new AppError("VALIDATION_ERROR", "Password must be 12–128 characters");
    }
    const normalizedEmail = email.trim().toLowerCase();
    const tenant = await getDb().tenant.create({
      data: {
        tenantUid: require("../lib/ids").uid("tnt"), companyName: companyName.trim(), status: "sandbox",
        settings: {}, allowedDomains: [],
        users: { create: { email: normalizedEmail, passwordHash: hashPassword(password), role: "tenant_admin", status: "active" } }
      },
      select: { id: true, users: { select: { id: true, email: true, role: true } } }
    });
    const user = tenant.users[0];
    await audit({ tenantId: tenant.id, actorType: "tenant_user", actorId: `user:${user.id}`, action: "tenant.registered", req });
    res.status(201).json({ success: true, token: signToken({ userId: String(user.id), role: user.role }), email: user.email, role: user.role, mfaEnrolled: false });
  } catch (err) {
    if (err.code === "P2002") return next(new AppError("VALIDATION_ERROR", "Unable to create account with these details. Try signing in or contact your administrator."));
    next(err);
  }
});

router.get("/me", requireUser(), (req, res) => {
  res.json({ success: true, email: req.user.email, role: req.user.role, mfaEnrolled: Boolean(req.user.mfaSecret),
    tenant: req.tenant ? { tenantUid: req.tenant.tenantUid, companyName: req.tenant.companyName, status: req.tenant.status } : null });
});

// POST /v1/auth/login {email, password, totp?}
router.post("/login", async (req, res, next) => {
  try {
    const user = await authenticate(req.body || {});
    const token = signToken({ userId: String(user.id), role: user.role });
    await audit({
      tenantId: user.tenantId, actorType: user.role === "super_admin" ? "admin" : "tenant_user",
      actorId: `user:${user.id}`, action: "user.logged_in", req
    });
    res.json({
      success: true,
      token,
      role: user.role,
      email: user.email,
      mfaEnrolled: Boolean(user.mfaSecret)
    });
  } catch (err) {
    next(err);
  }
});

// POST /v1/auth/mfa/enroll — returns secret + otpauth URL; confirm with first code
router.post("/mfa/enroll", requireUser(), async (req, res, next) => {
  try {
    if (req.user.mfaSecret) throw new AppError("VALIDATION_ERROR", "MFA already enrolled");
    const secret = generateTotpSecret();
    // Stored only after confirmation; return for QR display
    res.json({ success: true, secret, otpauthUrl: otpauthUrl(secret, { email: req.user.email }) });
  } catch (err) {
    next(err);
  }
});

// POST /v1/auth/mfa/confirm {secret, totp}
router.post("/mfa/confirm", requireUser(), async (req, res, next) => {
  try {
    if (req.user.mfaSecret) throw new AppError("VALIDATION_ERROR", "MFA already enrolled");
    const { secret, totp } = req.body || {};
    if (typeof secret !== "string" || !/^[A-Z2-7]{32}$/.test(secret) || !verifyTotp(secret, totp)) {
      throw new AppError("VALIDATION_ERROR", "Invalid TOTP code");
    }
    await getDb().user.updateMany({ where: { id: req.user.id }, data: { mfaSecret: secret } });
    await audit({
      tenantId: req.user.tenantId, actorType: "tenant_user", actorId: `user:${req.user.id}`,
      action: "user.mfa_enrolled", req
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
