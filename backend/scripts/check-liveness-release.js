"use strict";
require("../src/env");
const { assertGeneratedSchema, releaseIdentity, modelHashes } = require("../src/lib/release");
const { getDb } = require("../src/lib/db");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { resolveThresholds } = require("@verifypass/shared");
const { livenessValidation } = require("../src/lib/livenessValidation");
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
    const policies = (tenants.length ? tenants : [{ tenantUid: null, settings: {} }]).map(tenant => ({
      tenantUid: tenant.tenantUid,
      ...livenessValidation({ settings: tenant.settings || {}, thresholds: resolveThresholds(tenant.settings || {}, provider), provider })
    }));
    const policyValidated = policies.every(policy => policy.validated);
    console.log(JSON.stringify({ success: policyValidated, release: releaseIdentity(), transactions: true, modelChecksums: "verified", policyValidated, policies }, null, 2));
    if (!policyValidated) throw new Error("LIVENESS_RELEASE_UNVALIDATED: provide matching LIVENESS_VALIDATION_RECEIPTS with dataset and evaluation references for every effective tenant policy");
  } finally { await db.$disconnect(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
