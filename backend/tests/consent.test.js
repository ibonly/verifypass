"use strict";

// Consent capture (NDPA lawful basis; CBN-aligned CDD proof): set-once,
// idempotent, audit-logged, token-guarded, enforced on uploads when required.

const test = require("node:test");
const assert = require("node:assert/strict");

const { setDb } = require("../src/lib/db");
const { createMockDb } = require("./helpers/mockDb");
const { tenantScope } = require("../src/middleware/tenantScope");
const { createSession, recordConsent } = require("../src/services/sessionService");

function scopeFor(tenant) {
  const req = { tenant };
  tenantScope(req, {}, () => {});
  return req.scopedDb;
}

async function setup() {
  const db = createMockDb();
  setDb(db);
  const tenant = await db.tenant.create({ data: { tenantUid: "tnt_cs", companyName: "C", status: "active" } });
  const scope = scopeFor(tenant);
  const created = await createSession(scope, { customerReference: "C1" }, false);
  return { db, tenant, scope, created };
}

test("records consent once with timestamp, copy version and audit trail", async () => {
  const { db, tenant, scope, created } = await setup();

  const r = await recordConsent(scope, created.sessionId, created.sdkToken, {
    copyVersion: "2026-07-09.1", tenantId: tenant.id,
    req: { headers: { "x-forwarded-for": "1.2.3.4", "user-agent": "TestUA" }, socket: {} }
  });
  assert.equal(r.alreadyRecorded, false);
  assert.ok(r.consentAt);

  const session = await scope.sessions.findByUid(created.sessionId);
  assert.ok(session.consentAt, "consent timestamp persisted");
  assert.equal(session.consentMeta.copyVersion, "2026-07-09.1");
  assert.equal(session.consentMeta.ip, "1.2.3.4");

  const audits = await db.auditLog.findMany({ where: { action: "session.consent" } });
  assert.equal(audits.length, 1, "consent is audit-logged");
});

test("consent is SET-ONCE: second call is idempotent, first timestamp is the record", async () => {
  const { tenant, scope, created } = await setup();
  const r1 = await recordConsent(scope, created.sessionId, created.sdkToken, { tenantId: tenant.id });
  const r2 = await recordConsent(scope, created.sessionId, created.sdkToken, { tenantId: tenant.id });
  assert.equal(r2.alreadyRecorded, true);
  assert.equal(r2.consentAt, r1.consentAt, "the FIRST acceptance is the legal record");
});

test("wrong SDK token cannot record consent", async () => {
  const { tenant, scope, created } = await setup();
  await assert.rejects(
    () => recordConsent(scope, created.sessionId, "sdk_v1_forged", { tenantId: tenant.id }),
    (err) => err.code === "INVALID_API_KEY"
  );
});

test("uploads are refused without consent when REQUIRE_CONSENT is on", async () => {
  const prev = process.env.REQUIRE_CONSENT;
  process.env.REQUIRE_CONSENT = "true";
  // config caches at require-time — re-require fresh
  delete require.cache[require.resolve("../src/config")];
  try {
    const { handleUpload } = require("../src/services/uploadService");
    const { tenant, scope, created } = await setup();

    await assert.rejects(
      () => handleUpload({
        scopedDb: scope, tenantUid: tenant.tenantUid, sessionUid: created.sessionId,
        sdkToken: created.sdkToken, kind: "document", side: "front",
        imageBase64: `data:image/png;base64,${Buffer.alloc(2048, 1).toString("base64")}`
      }),
      /consent has not been recorded/
    );
  } finally {
    if (prev === undefined) delete process.env.REQUIRE_CONSENT; else process.env.REQUIRE_CONSENT = prev;
    delete require.cache[require.resolve("../src/config")];
  }
});
