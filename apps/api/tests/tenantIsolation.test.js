"use strict";

// Tenant isolation suite (PRD §9.1, plan §4.1). Must stay green on every PR.
// Rule under test: any endpoint hit with tenant B's key against tenant A's
// resource returns 404 — never 200, never 403 (existence must not leak).

const test = require("node:test");
const assert = require("node:assert/strict");

// HTTP-level suite needs express + supertest. If deps aren't installed
// (e.g. restricted sandbox), skip — serviceIsolation.test.js covers the same
// invariants dependency-free.
let request = null;
let app = null;
try {
  request = require("supertest");
  app = require("../src/app");
} catch (_) { /* deps not installed */ }
// Both must load: supertest may install fine while the app fails to require
// (e.g. sharp's native binary on a different OS/arch than node_modules was
// built for). Skip unless the full HTTP stack is usable.
const httpOpts = { skip: request && app ? false : "express/supertest/app not loadable here" };

const { setDb } = require("../src/lib/db");
const { createMockDb } = require("./helpers/mockDb");
const { issueKey } = require("../src/services/apiKeyService");

async function seedTenantWithKey(db, name, status = "active") {
  const tenant = await db.tenant.create({
    data: { tenantUid: `tnt_${name}`, companyName: name, status, settings: {} }
  });
  const { key } = await issueKey(tenant.id, "secret", false);
  return { tenant, key };
}

test("tenant isolation via HTTP", httpOpts, async (t) => {
  const db = createMockDb();
  setDb(db);
  t.after(() => setDb(null));

  const a = await seedTenantWithKey(db, "alpha");
  const b = await seedTenantWithKey(db, "beta");

  // A creates a session
  const created = await request(app)
    .post("/v1/verification-sessions")
    .set("Authorization", `Bearer ${a.key}`)
    .send({ customerReference: "CUST-1", verificationType: "ID_AND_FACE" });
  assert.equal(created.status, 201);
  assert.equal(created.body.success, true);
  const sessionId = created.body.sessionId;
  assert.match(sessionId, /^vps_/);
  assert.match(created.body.sdkToken, /^sdk_/);

  await t.test("owner can read own session", async () => {
    const res = await request(app)
      .get(`/v1/verification-sessions/${sessionId}`)
      .set("Authorization", `Bearer ${a.key}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.sessionId, sessionId);
    assert.equal(res.body.customerReference, "CUST-1");
  });

  await t.test("other tenant gets 404 (not 403) for same session", async () => {
    const res = await request(app)
      .get(`/v1/verification-sessions/${sessionId}`)
      .set("Authorization", `Bearer ${b.key}`);
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "SESSION_NOT_FOUND");
  });

  await t.test("key list is tenant-scoped", async () => {
    const res = await request(app)
      .get("/v1/api-keys")
      .set("Authorization", `Bearer ${b.key}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.keys.length, 1); // only B's own key
  });

  await t.test("missing/invalid/malformed keys all get identical 401", async () => {
    for (const header of [undefined, "Bearer nonsense", "Bearer vp_sec_test_00000000000000000000000000000000"]) {
      const req = request(app).get(`/v1/verification-sessions/${sessionId}`);
      if (header) req.set("Authorization", header);
      const res = await req;
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, "INVALID_API_KEY");
    }
  });

  await t.test("suspended tenant's key stops working", async () => {
    await db.tenant.updateMany({ where: { id: a.tenant.id }, data: { status: "suspended" } });
    const res = await request(app)
      .get(`/v1/verification-sessions/${sessionId}`)
      .set("Authorization", `Bearer ${a.key}`);
    assert.equal(res.status, 401);
  });
});

test("session validation rejects bad payloads", httpOpts, async (t) => {
  const db = createMockDb();
  setDb(db);
  t.after(() => setDb(null));

  const a = await seedTenantWithKey(db, "gamma");

  const bad = await request(app)
    .post("/v1/verification-sessions")
    .set("Authorization", `Bearer ${a.key}`)
    .send({ verificationType: "SOMETHING_ELSE", documentTypes: ["NIN_SLIP", "ALIEN_CARD"] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "VALIDATION_ERROR");
  assert.equal(bad.body.error.details.errors.length, 2);
});

test("health endpoint is public", httpOpts, async () => {
  const res = await request(app).get("/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ok");
});
