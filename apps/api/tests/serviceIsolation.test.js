"use strict";

// Dependency-free tenant isolation suite (no express/supertest/DB).
// Exercises tenantScope + sessionService + apiKeyService directly —
// the same invariants as the HTTP suite, runnable anywhere node runs.

const test = require("node:test");
const assert = require("node:assert/strict");

const { setDb } = require("../src/lib/db");
const { createMockDb } = require("./helpers/mockDb");
const { issueKey, resolveKey } = require("../src/services/apiKeyService");
const { tenantScope } = require("../src/middleware/tenantScope");
const { createSession, getSession, verifySdkToken, signSdkToken } = require("../src/services/sessionService");

/** Run the tenantScope middleware against a fake request; return scopedDb. */
function scopeFor(tenant) {
  const req = { tenant };
  let err = null;
  tenantScope(req, {}, (e) => { err = e || null; });
  assert.equal(err, null);
  return req.scopedDb;
}

test("sessions are invisible across tenants at the service layer", async (t) => {
  const db = createMockDb();
  setDb(db);
  t.after(() => setDb(null));

  const tenantA = await db.tenant.create({ data: { tenantUid: "tnt_a", companyName: "A", status: "active" } });
  const tenantB = await db.tenant.create({ data: { tenantUid: "tnt_b", companyName: "B", status: "active" } });
  const scopeA = scopeFor(tenantA);
  const scopeB = scopeFor(tenantB);

  const created = await createSession(scopeA, { customerReference: "CUST-A-1" }, false);
  assert.match(created.sessionId, /^vps_/);

  // Owner reads it
  const own = await getSession(scopeA, created.sessionId);
  assert.equal(own.customerReference, "CUST-A-1");

  // Other tenant gets SESSION_NOT_FOUND (404-equivalent), not a leak
  await assert.rejects(
    () => getSession(scopeB, created.sessionId),
    (e) => e.code === "SESSION_NOT_FOUND" && e.http === 404
  );

  // Listing is scoped
  const listA = await scopeA.sessions.list();
  const listB = await scopeB.sessions.list();
  assert.equal(listA.length, 1);
  assert.equal(listB.length, 0);
});

test("scopedDb.update cannot touch another tenant's session", async (t) => {
  const db = createMockDb();
  setDb(db);
  t.after(() => setDb(null));

  const tenantA = await db.tenant.create({ data: { tenantUid: "tnt_a2", companyName: "A", status: "active" } });
  const tenantB = await db.tenant.create({ data: { tenantUid: "tnt_b2", companyName: "B", status: "active" } });
  const created = await createSession(scopeFor(tenantA), {}, false);

  const res = await scopeFor(tenantB).sessions.update(created.sessionId, { status: "approved" });
  assert.equal(res.count, 0); // no rows touched

  const still = await getSession(scopeFor(tenantA), created.sessionId);
  assert.equal(still.status, "created");
});

test("api key list is tenant-scoped", async (t) => {
  const db = createMockDb();
  setDb(db);
  t.after(() => setDb(null));

  const tenantA = await db.tenant.create({ data: { tenantUid: "tnt_a3", companyName: "A", status: "active" } });
  const tenantB = await db.tenant.create({ data: { tenantUid: "tnt_b3", companyName: "B", status: "active" } });
  await issueKey(tenantA.id, "secret", false);
  await issueKey(tenantA.id, "public", false);
  await issueKey(tenantB.id, "secret", false);

  assert.equal((await scopeFor(tenantA).apiKeys.list()).length, 2);
  assert.equal((await scopeFor(tenantB).apiKeys.list()).length, 1);
});

test("resolveKey maps each key to exactly its own tenant", async (t) => {
  const db = createMockDb();
  setDb(db);
  t.after(() => setDb(null));

  const tenantA = await db.tenant.create({ data: { tenantUid: "tnt_a4", companyName: "A", status: "active" } });
  const tenantB = await db.tenant.create({ data: { tenantUid: "tnt_b4", companyName: "B", status: "active" } });
  const keyA = await issueKey(tenantA.id, "secret", false);
  const keyB = await issueKey(tenantB.id, "secret", false);

  assert.equal((await resolveKey(keyA.key, "secret")).tenant.id, tenantA.id);
  assert.equal((await resolveKey(keyB.key, "secret")).tenant.id, tenantB.id);
});

test("sdk token binds to its session uid", () => {
  const { token, tokenHash } = signSdkToken("vps_X1");
  assert.equal(verifySdkToken("vps_X1", token, tokenHash), true);
  assert.equal(verifySdkToken("vps_X2", token, tokenHash), false); // token stolen for other session
});

test("session validation rejects bad payloads (service layer)", async (t) => {
  const db = createMockDb();
  setDb(db);
  t.after(() => setDb(null));

  const tenant = await db.tenant.create({ data: { tenantUid: "tnt_v", companyName: "V", status: "active" } });
  await assert.rejects(
    () => createSession(scopeFor(tenant), { verificationType: "NOPE", documentTypes: ["ALIEN_CARD"] }, false),
    (e) => e.code === "VALIDATION_ERROR" && e.details.errors.length === 2
  );
});
