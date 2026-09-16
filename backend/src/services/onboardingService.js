"use strict";

const { AppError } = require("@verifypass/shared");
const { getDb } = require("../lib/db");
const { effectiveSettings } = require("./settingsService");

const TYPES = ["ID_AND_FACE", "FACE_ONLY", "ID_ONLY"];
function invalid(message) { throw new AppError("VALIDATION_ERROR", message); }
function validateProfile(body = {}) {
  const companyName = typeof body.companyName === "string" ? body.companyName.trim() : "";
  const contactEmail = typeof body.contactEmail === "string" ? body.contactEmail.trim().toLowerCase() : "";
  if (companyName.length < 2 || companyName.length > 120) invalid("Business name must be 2–120 characters");
  if (contactEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) invalid("Enter a valid contact email");
  if (!TYPES.includes(body.verificationType)) invalid("Choose a verification type");
  if (!["hosted", "react", "javascript"].includes(body.integration)) invalid("Choose an integration method");
  if (!Array.isArray(body.allowedDomains) || body.allowedDomains.length > 20) invalid("Provide up to 20 browser domains");
  const allowedDomains = [...new Set(body.allowedDomains.map(d => {
    if (typeof d !== "string") invalid("Domains must be hostnames");
    const host = d.trim().toLowerCase();
    if (host.length > 253 || !/^(localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/.test(host)) invalid("Use hostnames such as app.example.com, without paths, schemes or ports");
    return host;
  }))];
  if (body.integration !== "hosted" && !allowedDomains.length) invalid("Add at least one browser domain for an embedded SDK");
  return { companyName, contactEmail, verificationType: body.verificationType, integration: body.integration, allowedDomains };
}

function validateWebhookUrl(value) {
  try { return require("../lib/webhookTarget").parseWebhookUrl(value).href; }
  catch (err) { invalid(err.message); }
}

async function onboardingStatus(tenant, user) {
  const saved = tenant.settings?.onboarding || {};
  const keys = await getDb().apiKey.findMany({ where: { tenantId: tenant.id, status: "active", isLive: false } });
  const usable = keys.filter(k => !k.expiresAt || new Date(k.expiresAt) > new Date());
  const keyTypes = ["public", "secret"].filter(type => usable.some(k => k.keyType === type));
  const session = await getDb().verificationSession.findFirst({
    where: { tenantId: tenant.id, isLive: false, status: { in: ["approved", "rejected", "manual_review"] } },
    orderBy: { createdAt: "desc" }
  });
  const profile = saved.profile || null;
  const steps = {
    profile: Boolean(profile),
    security: Boolean(user.mfaSecret) || saved.securityChoice === "later",
    keys: keyTypes.includes("secret") && (profile?.integration === "hosted" || keyTypes.includes("public")),
    delivery: saved.deliveryMethod === "polling" || (saved.deliveryMethod === "webhook" && Boolean(tenant.webhookUrl && tenant.webhookSecret)),
    policies: Boolean(saved.policiesReviewedAt),
    verification: Boolean(session)
  };
  return {
    success: true,
    tenant: { tenantUid: tenant.tenantUid, companyName: tenant.companyName, status: tenant.status },
    profile, securityChoice: saved.securityChoice || null, mfaEnrolled: Boolean(user.mfaSecret),
    keyTypes, deliveryMethod: saved.deliveryMethod || null, webhookUrl: tenant.webhookUrl || "",
    policies: effectiveSettings(tenant), dualApproval: tenant.settings?.review?.dualApproval === true,
    steps, ready: Object.values(steps).every(Boolean), completedAt: saved.completedAt || null,
    verification: session ? { sessionId: session.sessionUid, status: session.status } : null
  };
}

async function saveOnboarding(tenant, patch, data = {}) {
  // Only validated, server-selected fields enter onboarding state. Tenant IDs
  // and completion evidence are never accepted from the browser.
  const settings = { ...(tenant.settings || {}), onboarding: { ...(tenant.settings?.onboarding || {}), ...patch } };
  await getDb().tenant.updateMany({ where: { id: tenant.id }, data: { ...data, settings } });
  Object.assign(tenant, data, { settings });
}
module.exports = { validateProfile, validateWebhookUrl, onboardingStatus, saveOnboarding };
