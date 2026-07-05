"use strict";

const { Router } = require("express");
const { AppError } = require("@verifypass/shared");
const { authenticate } = require("../services/userService");
const { signToken } = require("../services/authTokens");
const { generateTotpSecret, verifyTotp, otpauthUrl } = require("../services/totp");
const { requireUser } = require("../middleware/userAuth");
const { getDb } = require("../lib/db");
const { audit } = require("../services/auditLogger");

const router = Router();

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
    const { secret, totp } = req.body || {};
    if (!secret || !verifyTotp(secret, totp)) {
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
