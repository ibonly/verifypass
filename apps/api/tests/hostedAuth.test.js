"use strict";

// sdkOrHostedAuth middleware: hosted (token-only) mode must resolve exactly
// the session's own tenant, and fail closed everywhere else.

const test = require("node:test");
const assert = require("node:assert/strict");

const { setDb } = require("../src/lib/db");
const { createMockDb } = require("./helpers/mockDb");
const { tenantScope } = require("../src/middleware/tenantScope");
const { createSession } = require("../src/services/sessionService");
const { sdkOrHostedAuth } = require("../src/middleware/auth");
const { issueKey } = require("../src/services/apiKeyService");

function scopeFor(tenant) {
  const req = { tenant };
  tenantScope(req, {}, () => {});
  return req.scopedDb;
}

function runMiddleware(req) {
  return new Promise((resolve) => {
    sdkOrHostedAuth(req, {}, (err) => resolve({ err: err || null, req }));
  });
}

async function setup(status = "active") {
  const db = createMockDb();
  setDb(db);
  const tenant = await db.tenant.create({ data: { tenantUid: "tnt_h", companyName: "H", status } });
  const created = await createSession(scopeFor(tenant), {}, false);
  return { db, tenant, created };
}

test("hosted mode: valid token resolves the session's tenant", async (t) => {
  const { tenant, created } = await setup();
  t.after(() => setDb(null));

  const { err, req } = await runMiddleware({
    headers: {},
    params: { sessionId: created.sessionId },
    body: { sdkToken: created.sdkToken }
  });
  assert.equal(err, null);
  assert.equal(req.tenant.id, tenant.id);
  assert.equal(req.apiKey.prefix, "hosted");
});

test("hosted mode: token accepted via query (status polling)", async (t) => {
  const { created } = await setup();
  t.after(() => setDb(null));
  const { err } = await runMiddleware({
    headers: {},
    params: { sessionId: created.sessionId },
    query: { sdkToken: created.sdkToken }
  });
  assert.equal(err, null);
});

test("hosted mode: wrong token, wrong session, missing token all 401", async (t) => {
  const { created } = await setup();
  t.after(() => setDb(null));

  const cases = [
    { params: { sessionId: created.sessionId }, body: { sdkToken: "sdk_wrong" } },
    { params: { sessionId: "vps_GHOST" }, body: { sdkToken: created.sdkToken } },
    { params: { sessionId: created.sessionId }, body: {} }
  ];
  for (const c of cases) {
    const { err } = await runMiddleware({ headers: {}, ...c });
    assert.equal(err?.code, "INVALID_API_KEY");
  }
});

test("hosted mode: token from tenant A cannot be replayed on tenant B's session", async (t) => {
  const { db, created } = await setup();
  t.after(() => setDb(null));

  const tenantB = await db.tenant.create({ data: { tenantUid: "tnt_h2", companyName: "H2", status: "active" } });
  const sessionB = await createSession(scopeFor(tenantB), {}, false);

  // A's token against B's session uid
  const { err } = await runMiddleware({
    headers: {},
    params: { sessionId: sessionB.sessionId },
    body: { sdkToken: created.sdkToken }
  });
  assert.equal(err?.code, "INVALID_API_KEY");
});

test("hosted mode: suspended tenant fails closed", async (t) => {
  const { created } = await setup("suspended");
  t.after(() => setDb(null));
  const { err } = await runMiddleware({
    headers: {},
    params: { sessionId: created.sessionId },
    body: { sdkToken: created.sdkToken }
  });
  assert.equal(err?.code, "INVALID_API_KEY");
});

test("public SDK auth: live keys require an allowed domain", async (t) => {
  const db = createMockDb();
  setDb(db);
  t.after(() => setDb(null));

  const sandboxTenant = await db.tenant.create({ data: { tenantUid: "tnt_pub_test", companyName: "T", status: "active" } });
  const liveTenant = await db.tenant.create({ data: { tenantUid: "tnt_pub_live", companyName: "L", status: "active" } });
  const sandboxKey = await issueKey(sandboxTenant.id, "public", false);
  const liveKey = await issueKey(liveTenant.id, "public", true);

  const sandbox = await runMiddleware({
    headers: { authorization: `Bearer ${sandboxKey.key}` },
    params: { sessionId: "vps_PUBLIC" },
    body: {}
  });
  assert.equal(sandbox.err, null);
  assert.equal(sandbox.req.tenant.id, sandboxTenant.id);

  const live = await runMiddleware({
    headers: { authorization: `Bearer ${liveKey.key}`, origin: "https://app.example.com" },
    params: { sessionId: "vps_PUBLIC" },
    body: {}
  });
  assert.equal(live.err?.code, "DOMAIN_NOT_ALLOWED");

  liveTenant.allowedDomains = ["example.com"];
  const allowed = await runMiddleware({
    headers: { authorization: `Bearer ${liveKey.key}`, origin: "https://app.example.com" },
    params: { sessionId: "vps_PUBLIC" },
    body: {}
  });
  assert.equal(allowed.err, null);
  assert.equal(allowed.req.tenant.id, liveTenant.id);
});
