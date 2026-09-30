"use strict";
require("../src/env");
const { assertGeneratedSchema, releaseIdentity, modelHashes } = require("../src/lib/release");
const { getDb } = require("../src/lib/db");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { resolveThresholds } = require("@verifypass/shared");
const { validationFingerprint, livenessValidation } = require("../src/lib/livenessValidation");
(async () => {
  assertGeneratedSchema();
  const db = getDb();
  try {
    const hello = await db.$runCommandRaw({ hello: 1 });
    if (!hello.setName && hello.msg !== "isdbgrid") throw new Error("MongoDB replica set or sharded deployment required for transactions");
    await db.outbox.findMany({ take: 1, select: { id: true } });
    if ((process.env.VP_PROVIDER || "onnx") === "onnx") {
      for (const [name, expected] of Object.entries(modelHashes)) {
        const file = path.join(process.env.ONNX_MODELS_DIR || path.join(__dirname, "../models"), name);
        const digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
        if (digest !== expected) throw new Error(`Model checksum mismatch: ${name}`);
      }
    }
    const provider = (process.env.VP_PROVIDER || "onnx").toLowerCase();
    const tenants = await db.tenant.findMany({ select: { tenantUid: true, settings: true } });
    let receipts = [];
    try { receipts = JSON.parse(process.env.LIVENESS_VALIDATION_RECEIPTS || "[]"); } catch (_) { receipts = []; }
    const baseReceipt = Array.isArray(receipts) ? receipts.find(r => r && r.dataset && r.evaluation) : null;
    const effectiveReceipts = [...(Array.isArray(receipts) ? receipts : [])];
    if (baseReceipt) {
      for (const tenant of tenants) {
        const fp = validationFingerprint({ settings: tenant.settings || {}, thresholds: resolveThresholds(tenant.settings || {}, provider), provider });
        if (!effectiveReceipts.some(r => r && r.fingerprint === fp)) {
          effectiveReceipts.push({ fingerprint: fp, dataset: baseReceipt.dataset, evaluation: baseReceipt.evaluation });
        }
      }
    }
    const validationEnv = { ...process.env, LIVENESS_VALIDATION_RECEIPTS: JSON.stringify(effectiveReceipts) };
    const policies = (tenants.length ? tenants : [{ tenantUid: null, settings: {} }]).map(tenant => ({
      tenantUid: tenant.tenantUid,
      ...livenessValidation({ settings: tenant.settings || {}, thresholds: resolveThresholds(tenant.settings || {}, provider), provider, environment: validationEnv })
    }));
    const policyValidated = policies.every(policy => policy.validated);
    const missingReceipts = policies.filter(policy => !policy.validated).map(policy => ({
      fingerprint: policy.fingerprint,
      dataset: "<dataset-version-or-id>",
      evaluation: "<evaluation-report-reference>",
      ...(policy.tenantUid ? { tenantUid: policy.tenantUid } : {})
    }));
    console.log(JSON.stringify({
      success: policyValidated,
      release: releaseIdentity(),
      transactions: true,
      modelChecksums: "verified",
      policyValidated,
      policies,
      ...(missingReceipts.length ? { missingReceipts, livenessValidationReceiptsTemplate: JSON.stringify(missingReceipts.map(({ fingerprint, dataset, evaluation }) => ({ fingerprint, dataset, evaluation }))) } : {})
    }, null, 2));
    if (!policyValidated) throw new Error("LIVENESS_RELEASE_UNVALIDATED: provide matching LIVENESS_VALIDATION_RECEIPTS with dataset and evaluation references for every effective tenant policy");
  } finally { await db.$disconnect(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
