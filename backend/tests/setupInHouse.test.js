"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMockDb } = require("./helpers/mockDb");
const { setDb } = require("../src/lib/db");
const { setupInHouse } = require("../../scripts/setup-inhouse");
const { resolveKey, issueKey } = require("../src/services/apiKeyService");

function setup(t) {
  const db = createMockDb(); setDb(db);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vp-demo-"));
  t.after(() => { setDb(null); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, credentialFile: path.join(dir, "credentials.json") };
}
async function assertAligned(db, creds) {
  const admin = await db.user.findFirst({ where: { email: "admin@demo.local" } });
  const reviewer = await db.user.findFirst({ where: { email: "reviewer@demo.local" } });
  const pub = await resolveKey(creds.publicKey, "public");
  const sec = await resolveKey(creds.secretKey, "secret");
  assert.equal(pub.tenant.id, admin.tenantId);
  assert.equal(sec.tenant.id, admin.tenantId);
  assert.equal(reviewer.tenantId, admin.tenantId);
  assert.equal(sec.tenant.tenantUid, creds.tenantUid);
}

test("fresh demo setup keeps dashboard login and API keys in one tenant and reuses valid keys", async t => {
  const { db, credentialFile } = setup(t);
  const creds = await setupInHouse({ credentialFile });
  await assertAligned(db, creds);
  assert.deepEqual(await setupInHouse({ credentialFile }), creds);
  assert.equal(db.apiKey.rows.length, 2);
});

test("lost credential file reuses the existing demo admin tenant and its webhook", async t => {
  const { db, credentialFile } = setup(t);
  const first = await setupInHouse({ credentialFile });
  db.tenant.rows[0].webhookUrl = "https://receiver.example/hook";
  fs.unlinkSync(credentialFile);
  const repaired = await setupInHouse({ credentialFile });
  assert.equal(repaired.tenantUid, first.tenantUid);
  assert.equal(db.tenant.rows.length, 1);
  assert.equal(db.tenant.rows[0].webhookUrl, "https://receiver.example/hook");
  await assertAligned(db, repaired);
});

test("cached credentials for another tenant are repaired without moving users or webhooks", async t => {
  const { db, credentialFile } = setup(t);
  const original = await setupInHouse({ credentialFile });
  const other = await db.tenant.create({ data: { tenantUid: "tnt_wrong", companyName: "Other", status: "active" } });
  const pub = await issueKey(other.id, "public", false);
  const sec = await issueKey(other.id, "secret", false);
  fs.writeFileSync(credentialFile, JSON.stringify({ ...original, tenantUid: other.tenantUid, publicKey: pub.key, secretKey: sec.key }));
  const repaired = await setupInHouse({ credentialFile });
  assert.equal(repaired.tenantUid, original.tenantUid);
  await assertAligned(db, repaired);
  assert.equal(other.webhookUrl, undefined);
});

test("cached tenant label cannot hide API keys issued for a different tenant", async t => {
  const { db, credentialFile } = setup(t);
  const original = await setupInHouse({ credentialFile });
  const other = await db.tenant.create({ data: { tenantUid: "tnt_wrong", status: "active" } });
  const sec = await issueKey(other.id, "secret", false);
  fs.writeFileSync(credentialFile, JSON.stringify({ ...original, secretKey: sec.key }));
  await assertAligned(db, await setupInHouse({ credentialFile }));
});

test("conflicting reviewer account is not silently moved to a different tenant", async t => {
  const { db, credentialFile } = setup(t);
  await setupInHouse({ credentialFile });
  db.user.rows.find(u => u.email === "reviewer@demo.local").tenantId = "another-tenant";
  await assert.rejects(setupInHouse({ credentialFile }), /refusing to move/);
  assert.equal(db.apiKey.rows.length, 2);
});
