"use strict";
const crypto = require("crypto");
const modelHashes = require("../../scripts/model-manifest.json");
const policyVersion = "2026-09-07.1-release-validation";
let commit = process.env.BUILD_COMMIT || null;
if (!commit) {
  try { commit = require("child_process").execFileSync("git", ["rev-parse", "HEAD"], { cwd: __dirname, encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch (_) { /* release builds supply BUILD_COMMIT */ }
}
const modelSet = crypto.createHash("sha256").update(JSON.stringify(modelHashes)).digest("hex");
const fs = require("fs"), path = require("path");
const root = path.resolve(__dirname, "../..");
const sources = [];
function collect(dir) { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir,item.name); if (item.isDirectory()) collect(file); else if (item.name.endsWith(".js")) sources.push(file); } }
collect(path.join(root,"src")); collect(path.join(root,"shared/src"));
sources.push(path.join(root,"worker.js"),path.join(root,"worker.lambda.js"),path.join(root,"prisma/schema.prisma"));
const hasher = crypto.createHash("sha256");
for (const file of sources.sort()) hasher.update(path.relative(root,file)).update(fs.readFileSync(file));
const sourceDigest = hasher.digest("hex");
function releaseIdentity() { return { commit, sourceDigest, policyVersion, modelSet }; }
function assertGeneratedSchema() {
  const { Prisma } = require("@prisma/client");
  for (const [model, fields] of Object.entries({ VerificationSession: ["attemptId", "submittedAt", "revision"], EvidenceFile: ["attemptId", "captureMode", "meta"], Outbox: ["status", "payload"], AnalysisReceipt: ["key"], EvidenceStaging: ["storagePath", "status"] })) {
    const found = Prisma.dmmf.datamodel.models.find(m => m.name === model);
    if (!found || fields.some(name => !found.fields.some(f => f.name === name))) throw new Error("Generated Prisma client is stale; run npm run prisma:generate --prefix backend and apply the schema before starting");
  }
}
module.exports = { releaseIdentity, assertGeneratedSchema, policyVersion, modelHashes };
