"use strict";

const crypto = require("crypto");
const { Router } = require("express");
const { AppError } = require("@verifypass/shared");
const { requireUser } = require("../middleware/userAuth");
const { tenantScope } = require("../middleware/tenantScope");
const { audit } = require("../services/auditLogger");
const { createSession } = require("../services/sessionService");
const { enqueue } = require("../services/jobService");
const { validateRetention, validateReview } = require("../services/settingsService");
const { validateProfile, validateWebhookUrl, onboardingStatus, saveOnboarding } = require("../services/onboardingService");

const router = Router();
router.use(requireUser("tenant_admin", "super_admin"), (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (!req.tenant) return next(new AppError("VALIDATION_ERROR", "Select a tenant to begin onboarding"));
  if (["suspended", "disabled"].includes(req.tenant.status)) return next(new AppError("FORBIDDEN", "Tenant unavailable"));
  next();
}, tenantScope);
const log = (req, action, metadata) => audit({ tenantId: req.tenant.id, actorType: "tenant_user", actorId: `user:${req.user.id}`, action, metadata, req });
const route = fn => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };
router.get("/", route(async (req, res) => res.json(await onboardingStatus(req.tenant, req.user))));
router.put("/profile", route(async (req, res) => {
  const profile = validateProfile(req.body);
  await saveOnboarding(req.tenant, { profile }, { companyName: profile.companyName, allowedDomains: profile.allowedDomains });
  await log(req, "onboarding.profile_saved");
  res.json(await onboardingStatus(req.tenant, req.user));
}));
router.put("/security", route(async (req, res) => {
  if (req.body?.choice !== "later") throw new AppError("VALIDATION_ERROR", "MFA enrollment is confirmed through account security");
  await saveOnboarding(req.tenant, { securityChoice: "later" });
  await log(req, "onboarding.security_deferred");
  res.json(await onboardingStatus(req.tenant, req.user));
}));
router.put("/delivery", route(async (req, res) => {
  if (!["polling", "webhook"].includes(req.body?.method)) throw new AppError("VALIDATION_ERROR", "Choose webhook or polling delivery");
  if (req.body.method === "webhook" && !req.tenant.webhookUrl) throw new AppError("VALIDATION_ERROR", "Configure a webhook first");
  if (req.body.method === "polling" && req.tenant.webhookUrl) throw new AppError("VALIDATION_ERROR", "An existing webhook is configured. Use webhook delivery or remove it through your administrator before switching to polling.");
  await saveOnboarding(req.tenant, { deliveryMethod: req.body.method });
  await log(req, "onboarding.delivery_saved");
  res.json(await onboardingStatus(req.tenant, req.user));
}));
router.put("/webhook", route(async (req, res) => {
  const url = validateWebhookUrl(req.body?.url);
  const secret = `whsec_${crypto.randomBytes(24).toString("base64url")}`;
  await saveOnboarding(req.tenant, { deliveryMethod: "webhook" }, { webhookUrl: url, webhookSecret: secret });
  await log(req, "webhook.config_updated", { url });
  res.json({ success: true, url, secret });
}));
router.post("/webhooks/:eventId/retry", route(async (req, res) => {
  const delivery = await req.scopedDb.webhookDeliveries.findByUid(req.params.eventId);
  if (!delivery) throw new AppError("NOT_FOUND", "Delivery not found");
  if (delivery.status === "delivered") throw new AppError("VALIDATION_ERROR", "Already delivered");
  await enqueue("send_webhook", { deliveryId: String(delivery.id) });
  await log(req, "webhook.manual_retry", { eventId: req.params.eventId });
  res.status(202).json({ success: true });
}));
router.put("/policies", route(async (req, res) => {
  const retention = validateRetention(req.body?.retention || {});
  const review = validateReview({ dualApproval: req.body?.dualApproval });
  if (!Object.hasOwn(retention, "rawEvidenceDays") || !Object.hasOwn(retention, "failedSessionDays") || typeof review.dualApproval !== "boolean") {
    throw new AppError("VALIDATION_ERROR", "Review both retention periods and the approval policy");
  }
  req.tenant.settings = { ...(req.tenant.settings || {}), retention, review };
  await saveOnboarding(req.tenant, { policiesReviewedAt: new Date().toISOString() });
  await log(req, "onboarding.policies_saved", { retention, review });
  res.json(await onboardingStatus(req.tenant, req.user));
}));
router.post("/verification", route(async (req, res) => {
  const profile = req.tenant.settings?.onboarding?.profile;
  if (!profile) throw new AppError("VALIDATION_ERROR", "Save your business profile first");
  const result = await createSession(req.scopedDb, {
    verificationType: profile.verificationType,
    customerReference: `onboarding-${crypto.randomBytes(8).toString("hex")}`,
    metadata: { source: "dashboard_onboarding" }
  }, false);
  await log(req, "onboarding.verification_created", { sessionId: result.sessionId });
  res.status(201).json(result);
}));
router.post("/complete", route(async (req, res) => {
  const status = await onboardingStatus(req.tenant, req.user);
  if (!status.ready) throw new AppError("VALIDATION_ERROR", "Complete the setup checklist before finishing", { errors: Object.entries(status.steps).filter(([, done]) => !done).map(([name]) => `${name} is incomplete`) });
  if (!status.completedAt) {
    await saveOnboarding(req.tenant, { completedAt: new Date().toISOString() });
    await log(req, "onboarding.completed");
  }
  res.json(await onboardingStatus(req.tenant, req.user));
}));
module.exports = router;
