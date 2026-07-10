"use strict";

// Tenant settings (Phase 2: risk rules builder + retention policies).
// All writes are validated against platform bounds and merged into
// tenants.settings JSON — the same object resolveThresholds() reads, so
// changes take effect on the next verification with no restart.

const {
  AppError, DEFAULT_THRESHOLDS, THRESHOLD_BOUNDS,
  DEFAULT_RETENTION, RETENTION_BOUNDS, resolveThresholds
} = require("@verifypass/shared");
const { getDb } = require("../lib/db");

function bad(errors) {
  throw new AppError("VALIDATION_ERROR", "Invalid settings", { errors });
}

/** Validate tenant threshold overrides. Returns a clean object to store. */
function validateThresholds(input = {}) {
  const errors = [];
  const clean = {};

  for (const band of ["liveness", "faceMatch"]) {
    if (input[band] == null) continue;
    const b = THRESHOLD_BOUNDS[band];
    const cur = { ...DEFAULT_THRESHOLDS[band], ...input[band] };
    for (const k of ["reject", "pass"]) {
      const v = input[band][k];
      if (v == null) continue;
      if (typeof v !== "number" || Number.isNaN(v)) errors.push(`${band}.${k} must be a number`);
    }
    if (typeof cur.reject === "number" && cur.reject < b.rejectMin) errors.push(`${band}.reject must be >= ${b.rejectMin}`);
    if (typeof cur.pass === "number" && cur.pass > b.passMax) errors.push(`${band}.pass must be <= ${b.passMax}`);
    if (typeof cur.reject === "number" && typeof cur.pass === "number" && cur.reject > cur.pass) {
      errors.push(`${band}.reject must be <= ${band}.pass`);
    }
    clean[band] = {};
    if (input[band].reject != null) clean[band].reject = input[band].reject;
    if (input[band].pass != null) clean[band].pass = input[band].pass;
  }

  if (input.maxFailedAttempts != null) {
    const b = THRESHOLD_BOUNDS.risk.maxFailedAttempts;
    if (!Number.isInteger(input.maxFailedAttempts) || input.maxFailedAttempts < b.min || input.maxFailedAttempts > b.max) {
      errors.push(`maxFailedAttempts must be an integer ${b.min}-${b.max}`);
    } else {
      clean.maxFailedAttempts = input.maxFailedAttempts;
    }
  }

  if (input.risk != null) {
    clean.risk = {};
    for (const [k, bound] of Object.entries(THRESHOLD_BOUNDS.risk)) {
      if (k === "maxFailedAttempts" || input.risk[k] == null) continue;
      const v = input.risk[k];
      if (!Number.isInteger(v) || v < bound.min || v > bound.max) {
        errors.push(`risk.${k} must be an integer ${bound.min}-${bound.max}`);
      } else {
        clean.risk[k] = v;
      }
    }
    for (const k of Object.keys(input.risk)) {
      if (!(k in THRESHOLD_BOUNDS.risk) || k === "maxFailedAttempts") {
        if (k === "maxFailedAttempts") errors.push("risk.maxFailedAttempts belongs at the top level");
        else errors.push(`unknown risk setting '${k}'`);
      }
    }
  }

  if (errors.length) bad(errors);
  return clean;
}

/** Validate retention policy. Returns a clean object to store. */
function validateRetention(input = {}) {
  const errors = [];
  const clean = {};
  for (const [k, bound] of Object.entries(RETENTION_BOUNDS)) {
    if (input[k] == null) continue;
    if (!Number.isInteger(input[k]) || input[k] < bound.min || input[k] > bound.max) {
      errors.push(`${k} must be an integer ${bound.min}-${bound.max}`);
    } else {
      clean[k] = input[k];
    }
  }
  for (const k of Object.keys(input)) {
    if (!(k in RETENTION_BOUNDS)) errors.push(`unknown retention setting '${k}'`);
  }
  if (errors.length) bad(errors);
  return clean;
}

/** Effective (merged) settings for display. */
function effectiveSettings(tenant) {
  const settings = tenant.settings || {};
  return {
    thresholds: {
      effective: resolveThresholds(settings),
      overrides: settings.thresholds || {},
      defaults: DEFAULT_THRESHOLDS,
      bounds: THRESHOLD_BOUNDS
    },
    retention: {
      effective: { ...DEFAULT_RETENTION, ...(settings.retention || {}) },
      overrides: settings.retention || {},
      defaults: DEFAULT_RETENTION,
      bounds: RETENTION_BOUNDS
    }
  };
}

async function saveSettingsPatch(tenant, key, cleanValue) {
  const settings = { ...(tenant.settings || {}), [key]: cleanValue };
  await getDb().tenant.updateMany({ where: { id: tenant.id }, data: { settings } });
  return settings;
}

/** Effective retention for runtime use (uploads, cleanup). */
function retentionFor(tenant) {
  return { ...DEFAULT_RETENTION, ...((tenant?.settings || {}).retention || {}) };
}

/**
 * Maker-checker (dual approval) on manual review decisions — CBN-aligned
 * four-eyes control. Opt-in per tenant: settings.review.dualApproval.
 */
function dualApprovalFor(tenant) {
  return (tenant?.settings || {}).review?.dualApproval === true;
}

/** Validate the review-control settings patch. */
function validateReview(input = {}) {
  const errors = [];
  const clean = {};
  if (input.dualApproval != null) {
    if (typeof input.dualApproval !== "boolean") errors.push("dualApproval must be a boolean");
    else clean.dualApproval = input.dualApproval;
  }
  for (const k of Object.keys(input)) {
    if (k !== "dualApproval") errors.push(`unknown review setting '${k}'`);
  }
  if (errors.length) bad(errors);
  return clean;
}

module.exports = { validateThresholds, validateRetention, validateReview, effectiveSettings, saveSettingsPatch, retentionFor, dualApprovalFor };
