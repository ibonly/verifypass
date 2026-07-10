"use strict";

// Tenant settings + API key management for the dashboard (Phase 2).
// requireUser auth — tenant_admin (or super_admin via X-Tenant-Id).

const { Router } = require("express");
const { AppError } = require("@verifypass/shared");
const { requireUser } = require("../middleware/userAuth");
const { tenantScope } = require("../middleware/tenantScope");
const { audit } = require("../services/auditLogger");
const {
  validateThresholds, validateRetention, effectiveSettings, saveSettingsPatch
} = require("../services/settingsService");
const { issueKey, rotateKey, revokeKey, deleteKey } = require("../services/apiKeyService");

const router = Router();
const admins = requireUser("super_admin", "tenant_admin");

function requireTenant(req, _res, next) {
  if (!req.tenant) return next(new AppError("VALIDATION_ERROR", "X-Tenant-Id header required for super admin"));
  next();
}
router.use(admins, requireTenant, tenantScope);

// GET /v1/settings — effective + overrides + bounds (drives the rules builder UI)
router.get("/", async (req, res, next) => {
  try {
    res.json({ success: true, ...effectiveSettings(req.tenant) });
  } catch (err) { next(err); }
});

// PUT /v1/settings/thresholds
router.put("/thresholds", async (req, res, next) => {
  try {
    const clean = validateThresholds(req.body || {});
    const before = (req.tenant.settings || {}).thresholds || {};
    await saveSettingsPatch(req.tenant, "thresholds", clean);
    req.tenant.settings = { ...(req.tenant.settings || {}), thresholds: clean };
    await audit({
      tenantId: req.tenant.id, actorType: "tenant_user", actorId: `user:${req.user.id}`,
      action: "settings.thresholds_updated", req, metadata: { before, after: clean }
    });
    res.json({ success: true, ...effectiveSettings(req.tenant) });
  } catch (err) { next(err); }
});

// PUT /v1/settings/retention
router.put("/retention", async (req, res, next) => {
  try {
    const clean = validateRetention(req.body || {});
    const before = (req.tenant.settings || {}).retention || {};
    await saveSettingsPatch(req.tenant, "retention", clean);
    req.tenant.settings = { ...(req.tenant.settings || {}), retention: clean };
    await audit({
      tenantId: req.tenant.id, actorType: "tenant_user", actorId: `user:${req.user.id}`,
      action: "settings.retention_updated", req, metadata: { before, after: clean }
    });
    res.json({ success: true, ...effectiveSettings(req.tenant) });
  } catch (err) { next(err); }
});

// PUT /v1/settings/review — maker-checker (dual approval) toggle
router.put("/review", async (req, res, next) => {
  try {
    const { validateReview } = require("../services/settingsService");
    const clean = validateReview(req.body || {});
    const before = (req.tenant.settings || {}).review || {};
    await saveSettingsPatch(req.tenant, "review", clean);
    req.tenant.settings = { ...(req.tenant.settings || {}), review: clean };
    await audit({
      tenantId: req.tenant.id, actorType: "tenant_user", actorId: `user:${req.user.id}`,
      action: "settings.review_updated", req, metadata: { before, after: clean }
    });
    res.json({ success: true, review: clean });
  } catch (err) { next(err); }
});

// --- API key management (PRD §21: tenant admin manages keys) ---

// GET /v1/settings/api-keys
router.get("/api-keys", async (req, res, next) => {
  try {
    const keys = await req.scopedDb.apiKeys.list();
    res.json({ success: true, keys: keys.map((k) => ({ ...k, id: String(k.id) })) });
  } catch (err) { next(err); }
});

// POST /v1/settings/api-keys {keyType: public|secret, isLive: bool}
router.post("/api-keys", async (req, res, next) => {
  try {
    const { keyType, isLive } = req.body || {};
    if (!["public", "secret"].includes(keyType)) throw new AppError("VALIDATION_ERROR", "keyType must be public or secret");
    const issued = await issueKey(req.tenant.id, keyType, Boolean(isLive));
    await audit({
      tenantId: req.tenant.id, actorType: "tenant_user", actorId: `user:${req.user.id}`,
      action: "api_key.created", req, metadata: { keyType, isLive: Boolean(isLive), prefix: issued.prefix }
    });
    res.status(201).json({ success: true, key: issued.key, prefix: issued.prefix, id: String(issued.id) });
  } catch (err) { next(err); }
});

// POST /v1/settings/api-keys/:id/rotate
router.post("/api-keys/:id/rotate", async (req, res, next) => {
  try {
    const issued = await rotateKey(req.tenant.id, String(req.params.id));
    await audit({
      tenantId: req.tenant.id, actorType: "tenant_user", actorId: `user:${req.user.id}`,
      action: "api_key.rotated", req, metadata: { oldKeyId: req.params.id }
    });
    res.json({ success: true, key: issued.key, prefix: issued.prefix, id: String(issued.id) });
  } catch (err) { next(err); }
});

// POST /v1/settings/api-keys/:id/revoke
router.post("/api-keys/:id/revoke", async (req, res, next) => {
  try {
    await revokeKey(req.tenant.id, String(req.params.id));
    await audit({
      tenantId: req.tenant.id, actorType: "tenant_user", actorId: `user:${req.user.id}`,
      action: "api_key.revoked", req, metadata: { keyId: req.params.id }
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /v1/settings/api-keys/:id — permanently removes a revoked key
router.delete("/api-keys/:id", async (req, res, next) => {
  try {
    await deleteKey(req.tenant.id, String(req.params.id));
    await audit({
      tenantId: req.tenant.id, actorType: "tenant_user", actorId: `user:${req.user.id}`,
      action: "api_key.deleted", req, metadata: { keyId: req.params.id }
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
