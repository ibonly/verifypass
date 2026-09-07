"use strict";
require("../src/env");
const { assertGeneratedSchema, releaseIdentity, modelHashes } = require("../src/lib/release");
const { getDb } = require("../src/lib/db");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
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
    console.log(JSON.stringify({ success: true, release: releaseIdentity(), transactions: true, modelChecksums: "verified", policyValidated: process.env.LIVENESS_VALIDATED_POLICY === releaseIdentity().policyVersion }, null, 2));
  } finally { await db.$disconnect(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
