"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { setDb } = require("../src/lib/db");
const { createMockDb } = require("./helpers/mockDb");
const svc = require("../src/services/apiKeyService");

test("generateKey produces valid format and distinct hash/prefix", () => {
  const { key, keyHash, prefix } = svc.generateKey("secret", false);
  assert.match(key, /^vp_sec_test_[A-Za-z0-9]{32}$/);
  assert.equal(prefix, key.slice(0, 16));
  assert.equal(keyHash.length, 64); // sha256 hex
  assert.notEqual(keyHash, key);
});

test("parseKey accepts valid keys, rejects garbage", () => {
  const { key } = svc.generateKey("public", true);
  assert.deepEqual(svc.parseKey(key), { keyType: "public", isLive: true });
  assert.equal(svc.parseKey("vp_sec_live_short"), null);
  assert.equal(svc.parseKey("sk_live_stripe_style_key_000000000"), null);
  assert.equal(svc.parseKey(null), null);
});

test("hashKey is deterministic", () => {
  const { key } = svc.generateKey("secret", false);
  assert.equal(svc.hashKey(key), svc.hashKey(key));
});

test("resolveKey: happy path, revoked key, wrong type, suspended tenant", async () => {
  const db = createMockDb();
  setDb(db);
  try {
    const tenant = await db.tenant.create({ data: { tenantUid: "tnt_1", companyName: "A", status: "sandbox" } });
    const { key, keyHash, prefix } = svc.generateKey("secret", false);
    await db.apiKey.create({ data: { tenantId: tenant.id, keyType: "secret", isLive: false, keyHash, prefix, status: "active" } });

    // happy path
    const resolved = await svc.resolveKey(key, "secret");
    assert.equal(resolved.tenant.id, tenant.id);

    // wrong expected type → INVALID_API_KEY
    await assert.rejects(() => svc.resolveKey(key, "public"), (e) => e.code === "INVALID_API_KEY");

    // unknown key → INVALID_API_KEY
    const ghost = svc.generateKey("secret", false).key;
    await assert.rejects(() => svc.resolveKey(ghost, "secret"), (e) => e.code === "INVALID_API_KEY");

    // revoked → INVALID_API_KEY
    await db.apiKey.updateMany({ where: { prefix }, data: { status: "revoked" } });
    await assert.rejects(() => svc.resolveKey(key, "secret"), (e) => e.code === "INVALID_API_KEY");

    // suspended tenant → INVALID_API_KEY
    await db.apiKey.updateMany({ where: { prefix }, data: { status: "active" } });
    await db.tenant.updateMany({ where: { id: tenant.id }, data: { status: "suspended" } });
    await assert.rejects(() => svc.resolveKey(key, "secret"), (e) => e.code === "INVALID_API_KEY");
  } finally {
    setDb(null);
  }
});

test("rotateKey issues new key and revokes old", async () => {
  const db = createMockDb();
  setDb(db);
  try {
    const tenant = await db.tenant.create({ data: { tenantUid: "tnt_2", companyName: "B", status: "active" } });
    const issued = await svc.issueKey(tenant.id, "secret", true);
    const rotated = await svc.rotateKey(tenant.id, issued.id);

    assert.match(rotated.key, /^vp_sec_live_/);
    await assert.rejects(() => svc.resolveKey(issued.key, "secret"), (e) => e.code === "INVALID_API_KEY");
    const ok = await svc.resolveKey(rotated.key, "secret");
    assert.equal(ok.tenant.id, tenant.id);
  } finally {
    setDb(null);
  }
});

test("rotateKey refuses cross-tenant key id", async () => {
  const db = createMockDb();
  setDb(db);
  try {
    const a = await db.tenant.create({ data: { tenantUid: "tnt_a", companyName: "A", status: "active" } });
    const b = await db.tenant.create({ data: { tenantUid: "tnt_b", companyName: "B", status: "active" } });
    const keyOfA = await svc.issueKey(a.id, "secret", false);
    await assert.rejects(() => svc.rotateKey(b.id, keyOfA.id), (e) => e.code === "NOT_FOUND");
  } finally {
    setDb(null);
  }
});
