"use strict";

const crypto = require("crypto");
const { releaseIdentity } = require("./release");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function validationFingerprint({ settings = {}, thresholds = {}, provider = "onnx", environment = process.env, release = releaseIdentity() } = {}) {
  const runtime = Object.fromEntries(Object.entries(environment).filter(([key]) =>
    /^(CHALLENGE_|ENFORCE_POSE$|ONNX_|FACEPLUGIN_|PROVIDER_MODEL_VERSION$|VP_PROVIDER$|LIVENESS_)/.test(key) && !/^LIVENESS_VALIDAT/.test(key)
  ));
  return crypto.createHash("sha256").update(JSON.stringify(canonical({
    release: { sourceDigest: release.sourceDigest, modelSet: release.modelSet, policyVersion: release.policyVersion },
    settings, thresholds, provider, runtime
  }))).digest("hex");
}

function livenessValidation(options = {}) {
  const environment = options.environment || process.env;
  const fingerprint = validationFingerprint(options);
  let receipts;
  try { receipts = JSON.parse(environment.LIVENESS_VALIDATION_RECEIPTS || "[]"); } catch (_) { receipts = []; }
  const receipt = Array.isArray(receipts) ? receipts.find(entry => entry && entry.fingerprint === fingerprint
    && typeof entry.dataset === "string" && entry.dataset.trim()
    && typeof entry.evaluation === "string" && entry.evaluation.trim()) : null;
  return { fingerprint, validated: !!receipt, dataset: receipt?.dataset || null, evaluation: receipt?.evaluation || null };
}

module.exports = { validationFingerprint, livenessValidation };