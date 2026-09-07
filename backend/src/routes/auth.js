"use strict";

const { Router } = require("express");
const { AppError } = require("@verifypass/shared");
const { authenticate, hashPassword, verifyPassword } = require("../services/userService");
const { signToken } = require("../services/authTokens");
const { generateTotpSecret, verifyTotp, otpauthUrl } = require("../services/totp");
const { requireUser } = require("../middleware/userAuth");
const { getDb } = require("../lib/db");
const { audit } = require("../services/auditLogger");
// Lazy: emailService is required inside handlers to avoid any load-order
// cycle with the route graph (mail must never block or break auth).
const mailer = () => require("../services/emailService");

const router = Router();
router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

// Fire-and-forget: mail failures never break the request path. Delivery
// problems surface in the mail API's own logs/health, not to the end user.
function notify(promise) {
  Promise.resolve(promise).catch(err => console.error("email trigger failed:", err.message));
}

// Single-use email action tokens stored on the user record (sha256 only).
function setEmailToken(userId, field, hash, ttlSeconds) {
  return getDb().user.updateMany({
    where: { id: userId },
    data: { [field]: { hash, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() } }
  });
}
async function consumeEmailToken(userId, field, token) {
  const user = await getDb().user.findFirst({ where: { id: String(userId) } });
  const stored = user?.[field];
  if (!stored?.hash || !stored?.expiresAt) return null;
  const crypto = require("crypto");
  const hash = crypto.createHash("sha256").update(String(token || "")).digest("hex");
  const expected = Buffer.from(String(stored.hash), "hex");
  const actual = Buffer.from(hash, "hex");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual) || new Date(stored.expiresAt) < new Date()) return null;
  const consumed = await getDb().user.updateMany({
    where: { id: String(userId), [field]: { equals: stored } },
    data: { [field]: null }
  });
  if (consumed.count !== 1) return null;
  return user;
}

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
      select: { id: true, companyName: true, users: { select: { id: true, email: true, role: true } } }
    });
    const user = tenant.users[0];
    await audit({ tenantId: tenant.id, actorType: "tenant_user", actorId: `user:${user.id}`, action: "tenant.registered", req });
    // A1: email ownership verification — best-effort; account works in sandbox
    // while unverified, production keys require verification.
    if (mailer().enabled()) {
      notify((async () => {
        const out = await mailer().sendVerifyEmail(user, { companyName: tenant.companyName });
        if (out.tokenHash) await setEmailToken(user.id, "emailVerificationToken", out.tokenHash, out.expiresIn);
      })());
    }
    res.status(201).json({ success: true, token: signToken({ userId: String(user.id), role: user.role }), email: user.email, role: user.role, mfaEnrolled: false, emailVerified: false });
  } catch (err) {
    if (err.code === "P2002") return next(new AppError("VALIDATION_ERROR", "Unable to create account with these details. Try signing in or contact your administrator."));
    next(err);
  }
});

// POST /v1/auth/verify-email/request — resend the confirmation link
router.post("/verify-email/request", requireUser(), async (req, res, next) => {
  try {
    if (req.user.emailVerifiedAt) return res.json({ success: true, alreadyVerified: true });
    if (mailer().enabled()) {
      const out = await mailer().sendVerifyEmail(req.user, { companyName: req.tenant?.companyName || "your" });
      if (out.tokenHash) await setEmailToken(req.user.id, "emailVerificationToken", out.tokenHash, out.expiresIn);
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /v1/auth/verify-email/confirm {token}
router.post("/verify-email/confirm", requireUser(), async (req, res, next) => {
  try {
    const user = await consumeEmailToken(req.user.id, "emailVerificationToken", req.body?.token);
    if (!user) throw new AppError("VALIDATION_ERROR", "Invalid or expired confirmation link");
    await getDb().user.updateMany({ where: { id: req.user.id }, data: { emailVerifiedAt: new Date() } });
    await audit({ tenantId: req.user.tenantId, actorType: "tenant_user", actorId: `user:${req.user.id}`, action: "user.email_verified", req });
    if (mailer().enabled()) notify(mailer().sendWelcome(user, { companyName: req.tenant?.companyName || "your" }));
    res.json({ success: true, emailVerified: true });
  } catch (err) { next(err); }
});

// POST /v1/auth/password/forgot {email} — UNIFORM response (no enumeration)
router.post("/password/forgot", async (req, res, next) => {
  try {
    const addr = String(req.body?.email || "").trim().toLowerCase();
    if (addr && mailer().enabled()) {
      const user = await getDb().user.findFirst({ where: { email: addr, status: "active" } });
      if (user) {
        notify((async () => {
          const out = await mailer().sendPasswordReset(user, { ip: req.ip });
          if (out.tokenHash) await setEmailToken(user.id, "passwordResetToken", out.tokenHash, out.expiresIn);
        })());
      }
    }
    res.json({ success: true }); // identical whether or not the address exists
  } catch (err) { next(err); }
});

// POST /v1/auth/password/reset {email, token, password}
router.post("/password/reset", async (req, res, next) => {
  try {
    const { token, password } = req.body || {};
    const addr = String(req.body?.email || "").trim().toLowerCase();
    if (typeof password !== "string" || password.length < 12 || password.length > 128) {
      throw new AppError("VALIDATION_ERROR", "Password must be 12–128 characters");
    }
    const candidate = await getDb().user.findFirst({ where: { email: addr, status: "active" } });
    const user = candidate ? await consumeEmailToken(candidate.id, "passwordResetToken", token) : null;
    if (!user) throw new AppError("VALIDATION_ERROR", "Invalid or expired reset link");
    await getDb().user.updateMany({ where: { id: user.id }, data: { passwordHash: hashPassword(password) } });
    await audit({ tenantId: user.tenantId, actorType: "tenant_user", actorId: `user:${user.id}`, action: "user.password_reset", req });
    if (mailer().enabled()) notify(mailer().sendPasswordChanged(user, { ip: req.ip }));
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /v1/auth/password/change {currentPassword, password} — authenticated
router.post("/password/change", requireUser(), async (req, res, next) => {
  try {
    const { currentPassword, password } = req.body || {};
    if (!verifyPassword(currentPassword || "", req.user.passwordHash)) {
      throw new AppError("FORBIDDEN", "Current password is incorrect");
    }
    if (typeof password !== "string" || password.length < 12 || password.length > 128) {
      throw new AppError("VALIDATION_ERROR", "Password must be 12–128 characters");
    }
    await getDb().user.updateMany({ where: { id: req.user.id }, data: { passwordHash: hashPassword(password) } });
    await audit({ tenantId: req.user.tenantId, actorType: "tenant_user", actorId: `user:${req.user.id}`, action: "user.password_changed", req });
    if (mailer().enabled()) notify(mailer().sendPasswordChanged(req.user, { ip: req.ip }));
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /v1/auth/email/change {newEmail, currentPassword} — notifies BOTH addresses
router.post("/email/change", requireUser(), async (req, res, next) => {
  try {
    const { newEmail, currentPassword } = req.body || {};
    if (!verifyPassword(currentPassword || "", req.user.passwordHash)) {
      throw new AppError("FORBIDDEN", "Current password is incorrect");
    }
    const normalized = String(newEmail || "").trim().toLowerCase();
    if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new AppError("VALIDATION_ERROR", "Enter a valid email address");
    }
    if (normalized === req.user.email) throw new AppError("VALIDATION_ERROR", "That is already your email");
    await getDb().user.updateMany({
      where: { id: req.user.id },
      data: { pendingEmail: normalized }
    });
    await audit({ tenantId: req.user.tenantId, actorType: "tenant_user", actorId: `user:${req.user.id}`, action: "user.email_change_requested", req });
    if (mailer().enabled()) {
      notify((async () => {
        // Old address: cancel notice. New address: confirm link (reuses verify flow).
        const notice = await mailer().sendEmailChangeNotice(req.user, { newEmail: normalized, ip: req.ip });
        if (notice.tokenHash) await setEmailToken(req.user.id, "emailChangeCancelToken", notice.tokenHash, notice.expiresIn);
        const confirm = await mailer().sendVerifyEmail({ email: normalized }, { companyName: req.tenant?.companyName || "your" });
        if (confirm.tokenHash) await setEmailToken(req.user.id, "pendingEmailToken", confirm.tokenHash, confirm.expiresIn);
      })());
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /v1/auth/email/change/cancel {token} — aborts a pending change (old address)
router.post("/email/change/cancel", requireUser(), async (req, res, next) => {
  try {
    const user = await consumeEmailToken(req.user.id, "emailChangeCancelToken", req.body?.token);
    if (!user) throw new AppError("VALIDATION_ERROR", "Invalid or expired link");
    await getDb().user.updateMany({ where: { id: req.user.id }, data: { pendingEmail: null, pendingEmailToken: null } });
    await audit({ tenantId: req.user.tenantId, actorType: "tenant_user", actorId: `user:${req.user.id}`, action: "user.email_change_cancelled", req });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /v1/auth/email/change/confirm {token} — completes the change (new address)
router.post("/email/change/confirm", requireUser(), async (req, res, next) => {
  try {
    const user = await consumeEmailToken(req.user.id, "pendingEmailToken", req.body?.token);
    if (!user?.pendingEmail) throw new AppError("VALIDATION_ERROR", "Invalid or expired confirmation link");
    await getDb().user.updateMany({
      where: { id: req.user.id },
      data: { email: user.pendingEmail, pendingEmail: null, emailVerifiedAt: new Date() }
    });
    await audit({ tenantId: req.user.tenantId, actorType: "tenant_user", actorId: `user:${req.user.id}`, action: "user.email_changed", req });
    res.json({ success: true, email: user.pendingEmail });
  } catch (err) {
    if (err.code === "P2002") return next(new AppError("VALIDATION_ERROR", "That address is already in use"));
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
    // B3: new-context sign-in alert — fire when this IP hasn't been seen on
    // this account before, then record it.
    const seenIps = Array.isArray(user.knownLoginIps) ? user.knownLoginIps : [];
    if (req.ip && !seenIps.includes(req.ip)) {
      if (mailer().enabled()) notify(mailer().sendNewSignin(user, { ip: req.ip, device: req.headers["user-agent"] || "unknown" }));
      const updated = [...seenIps, req.ip].slice(-20); // cap stored history
      getDb().user.updateMany({ where: { id: user.id }, data: { knownLoginIps: updated } })
        .catch(err => console.error("knownLoginIps update failed:", err.message));
    }
    res.json({
      success: true,
      token,
      role: user.role,
      email: user.email,
      mfaEnrolled: Boolean(user.mfaSecret),
      emailVerified: Boolean(user.emailVerifiedAt)
    });
  } catch (err) {
    next(err);
  }
});

// POST /v1/auth/users/invite {email, role} — tenant_admin invites a teammate
router.post("/users/invite", requireUser("tenant_admin", "super_admin"), async (req, res, next) => {
  try {
    if (!req.tenant) throw new AppError("VALIDATION_ERROR", "Tenant context required");
    const { email: inviteEmail, role } = req.body || {};
    const normalized = String(inviteEmail || "").trim().toLowerCase();
    if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new AppError("VALIDATION_ERROR", "Enter a valid email address");
    }
    if (!["compliance_reviewer", "developer", "auditor"].includes(role)) {
      throw new AppError("VALIDATION_ERROR", "Invite role must be compliance_reviewer, developer or auditor");
    }
    if (!mailer().enabled()) throw new AppError("INTERNAL_ERROR", "Email service is not configured");
    const existing = await getDb().user.findFirst({ where: { email: normalized } });
    if (existing) throw new AppError("VALIDATION_ERROR", "Unable to invite with these details");
    const out = await mailer().sendTeamInvite({
      to: normalized,
      companyName: req.tenant.companyName,
      role,
      inviter: req.user.email,
      invitationId: `inv_${req.tenant.id}_${Date.now()}`
    });
    if (!out.tokenHash) throw new Error("invite token not issued");
    await getDb().user.create({
      data: {
        tenantId: req.tenant.id, email: normalized, passwordHash: "invited",
        role, status: "invited",
        inviteToken: { hash: out.tokenHash, expiresAt: new Date(Date.now() + out.expiresIn * 1000).toISOString() }
      }
    });
    await audit({ tenantId: req.tenant.id, actorType: "tenant_user", actorId: `user:${req.user.id}`, action: "user.invited", req, metadata: { email: normalized, role } });
    res.status(201).json({ success: true, email: normalized, role });
  } catch (err) {
    if (err.code === "P2002") return next(new AppError("VALIDATION_ERROR", "Unable to invite with these details"));
    next(err);
  }
});

// POST /v1/auth/invite/accept {email, token, password} — invited user sets their own password
router.post("/invite/accept", async (req, res, next) => {
  try {
    const { token, password } = req.body || {};
    const addr = String(req.body?.email || "").trim().toLowerCase();
    if (typeof password !== "string" || password.length < 12 || password.length > 128) {
      throw new AppError("VALIDATION_ERROR", "Password must be 12–128 characters");
    }
    const candidate = await getDb().user.findFirst({ where: { email: addr, status: "invited" } });
    const user = candidate ? await consumeEmailToken(candidate.id, "inviteToken", token) : null;
    if (!user) throw new AppError("VALIDATION_ERROR", "Invalid or expired invitation link");
    await getDb().user.updateMany({
      where: { id: user.id },
      data: { passwordHash: hashPassword(password), status: "active", emailVerifiedAt: new Date() }
    });
    await audit({ tenantId: user.tenantId, actorType: "tenant_user", actorId: `user:${user.id}`, action: "user.invite_accepted", req });
    res.json({ success: true });
  } catch (err) { next(err); }
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
    if (mailer().enabled()) notify(mailer().sendMfaChanged(req.user, { changeKind: "enabled", ip: req.ip }));
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
