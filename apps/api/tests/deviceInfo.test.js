"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { setDb } = require("../src/lib/db");
const { createMockDb } = require("./helpers/mockDb");
const { tenantScope } = require("../src/middleware/tenantScope");
const { createSession, attachDeviceInfo } = require("../src/services/sessionService");

function scopeFor(tenant) {
  const req = { tenant };
  tenantScope(req, {}, () => {});
  return req.scopedDb;
}

const DEVICE = {
  userAgent: "Mozilla/5.0 (Linux; Android 13)", language: "en-NG",
  languages: ["en-NG", "en"], platform: "Linux armv8l", timezone: "Africa/Lagos",
  screen: "412x915", pixelRatio: 2.6, touch: true, cores: 8, memoryGb: 4
};

async function setup(uid = "tnt_dev") {
  const db = createMockDb();
  setDb(db);
  const tenant = await db.tenant.create({ data: { tenantUid: uid, companyName: "D", status: "active" } });
  const scope = scopeFor(tenant);
  const created = await createSession(scope, {}, false);
  return { db, tenant, scope, created };
}

test("attachDeviceInfo: stores meta + server-computed fingerprint + ip", async (t) => {
  const { tenant, scope, created } = await setup();
  t.after(() => setDb(null));

  const ok = await attachDeviceInfo(scope, tenant.tenantUid, created.sessionId, DEVICE, "197.210.55.10");
  assert.equal(ok, true);

  const s = await scope.sessions.findByUid(created.sessionId);
  assert.match(s.deviceFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(s.deviceMeta.timezone, "Africa/Lagos");
  assert.equal(s.clientIp, "197.210.55.10");
});

test("attachDeviceInfo: set-once — second write cannot overwrite", async (t) => {
  const { tenant, scope, created } = await setup();
  t.after(() => setDb(null));

  await attachDeviceInfo(scope, tenant.tenantUid, created.sessionId, DEVICE, "1.1.1.1");
  const first = (await scope.sessions.findByUid(created.sessionId)).deviceFingerprint;

  const second = await attachDeviceInfo(scope, tenant.tenantUid, created.sessionId, { ...DEVICE, userAgent: "spoofed" }, "9.9.9.9");
  assert.equal(second, false);

  const s = await scope.sessions.findByUid(created.sessionId);
  assert.equal(s.deviceFingerprint, first);
  assert.equal(s.clientIp, "1.1.1.1");
});

test("fingerprint is deterministic per device but salted per tenant", async (t) => {
  const a = await setup("tnt_salt_a");
  await attachDeviceInfo(a.scope, "tnt_salt_a", a.created.sessionId, DEVICE, null);
  const fpA = (await a.scope.sessions.findByUid(a.created.sessionId)).deviceFingerprint;

  const a2 = await createSession(a.scope, {}, false);
  await attachDeviceInfo(a.scope, "tnt_salt_a", a2.sessionId, { ...DEVICE }, null);
  const fpA2 = (await a.scope.sessions.findByUid(a2.sessionId)).deviceFingerprint;
  assert.equal(fpA, fpA2); // same device + tenant → same fingerprint

  const b = await setup("tnt_salt_b");
  t.after(() => setDb(null));
  await attachDeviceInfo(b.scope, "tnt_salt_b", b.created.sessionId, DEVICE, null);
  const fpB = (await b.scope.sessions.findByUid(b.created.sessionId)).deviceFingerprint;
  assert.notEqual(fpA, fpB); // same device, different tenant → uncorrelatable
});

test("attachDeviceInfo: no device + no ip is a no-op; unknown fields dropped", async (t) => {
  const { tenant, scope, created } = await setup();
  t.after(() => setDb(null));

  assert.equal(await attachDeviceInfo(scope, tenant.tenantUid, created.sessionId, null, null), false);

  await attachDeviceInfo(scope, tenant.tenantUid, created.sessionId, { ...DEVICE, __proto__pollution: "x", extra: "ignored" }, null);
  const s = await scope.sessions.findByUid(created.sessionId);
  assert.equal(s.deviceMeta.extra, undefined);
});
