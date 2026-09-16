"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const app = require("../src/app");
const { setDb } = require("../src/lib/db");
const { createMockDb } = require("./helpers/mockDb");
const { signToken } = require("../src/services/authTokens");
const { verifyPassword } = require("../src/services/userService");
const { validateProfile, validateWebhookUrl } = require("../src/services/onboardingService");

const profile = { companyName: "Example Business", contactEmail: "admin@example.com", verificationType: "FACE_ONLY", integration: "hosted", allowedDomains: [] };
async function setup(t, role = "tenant_admin") {
  const db = createMockDb(); setDb(db); t.after(() => setDb(null));
  const tenant = await db.tenant.create({ data: { tenantUid: "tnt_a", companyName: "A", status: "sandbox", settings: { thresholds: { maxFailedAttempts: 4 } } } });
  const user = await db.user.create({ data: { tenantId: tenant.id, email: "a@example.com", status: "active", role } });
  const token = signToken({ userId: user.id, role });
  const call = (method, path) => request(app)[method](path).set("Authorization", `Bearer ${token}`);
  return { db, tenant, user, call };
}
test("profile/domain and webhook validation reject malformed configuration", () => {
  assert.deepEqual(validateProfile(profile), profile);
  for (const bad of [{ ...profile, companyName: "" }, { ...profile, contactEmail: "bad" }, { ...profile, integration: "react" }, { ...profile, allowedDomains: ["https://example.com"] }, { ...profile, verificationType: "anything" }]) assert.throws(() => validateProfile(bad));
  assert.equal(validateWebhookUrl("https://example.com/webhook"), "https://example.com/webhook");
  for (const url of ["http://example.com", "javascript:alert(1)", "https://user:pass@example.com", "https://example.com/#secret", "https://example.com:8443/hook", "https://127.0.0.1", "https://10.0.0.1", "https://[::1]"]) assert.throws(() => validateWebhookUrl(url));
});
test("full onboarding persists progress, requires real test outcome, and leaves tenant sandbox", async t => {
  const { db, tenant, call } = await setup(t);
  assert.equal((await call("post", "/v1/onboarding/complete").send({ ready: true })).status, 400);
  let r = await call("put", "/v1/onboarding/profile").send({ ...profile, tenantId: "other", completedAt: "forged" });
  assert.equal(r.status, 200); assert.equal(r.body.steps.profile, true); assert.equal(r.body.completedAt, null);
  await call("put", "/v1/onboarding/security").send({ choice: "later" }).expect(200);
  r = await call("post", "/v1/settings/api-keys").send({ keyType: "secret", isLive: false }).expect(201);
  assert.match(r.body.key, /^vp_sec_test_/);
  await call("post", "/v1/settings/api-keys").send({ keyType: "secret", isLive: true }).expect(403);
  await call("put", "/v1/onboarding/delivery").send({ method: "polling" }).expect(200);
  await call("put", "/v1/onboarding/policies").send({ retention: { rawEvidenceDays: 14, failedSessionDays: 7 }, dualApproval: false }).expect(200);
  r = await call("post", "/v1/onboarding/verification").send({ isLive: true, verificationType: "ID_ONLY", tenantId: "other" }).expect(201);
  const created = db.verificationSession.rows.find(s => s.sessionUid === r.body.sessionId);
  assert.equal(created.tenantId, tenant.id); assert.equal(created.isLive, false); assert.equal(created.verificationType, "FACE_ONLY");
  await call("post", "/v1/onboarding/complete").send({}).expect(400);
  created.status = "expired";
  assert.equal((await call("get", "/v1/onboarding")).body.steps.verification, false);
  created.status = "manual_review";
  r = await call("post", "/v1/onboarding/complete").send({}).expect(200);
  assert.ok(r.body.completedAt); assert.equal(r.body.ready, true); assert.equal(tenant.status, "sandbox");
  assert.equal(tenant.settings.thresholds.maxFailedAttempts, 4);
  assert.equal(tenant.settings.retention.rawEvidenceDays, 14);
  const again = await call("post", "/v1/onboarding/complete").send({}).expect(200);
  assert.equal(again.body.completedAt, r.body.completedAt);
  assert.equal(db.auditLog.rows.filter(a => a.action === "onboarding.completed").length, 1);
  db.apiKey.rows[0].status = "revoked";
  assert.equal((await call("get", "/v1/onboarding")).body.ready, false);
  await call("post", "/v1/onboarding/complete").send({}).expect(400);
});
test("onboarding requires admin and isolates all data from a spoofed tenant header", async t => {
  const { db, tenant, call } = await setup(t);
  const other = await db.tenant.create({ data: { tenantUid: "tnt_other", companyName: "Other", status: "active" } });
  await db.apiKey.create({ data: { tenantId: other.id, keyType: "secret", isLive: false, status: "active", keyHash: "never-send", prefix: "other" } });
  await db.verificationSession.create({ data: { tenantId: other.id, isLive: false, status: "approved", sessionUid: "vps_other" } });
  const r = await call("get", "/v1/onboarding").set("X-Tenant-Id", "tnt_other").expect(200);
  assert.equal(r.body.tenant.tenantUid, tenant.tenantUid); assert.deepEqual(r.body.keyTypes, []); assert.equal(r.body.verification, null);
  await request(app).get("/v1/onboarding").expect(403);
  for (const role of ["developer", "auditor", "compliance_reviewer"]) {
    const user = await db.user.create({ data: { tenantId: tenant.id, role, status: "active" } });
    await request(app).put("/v1/onboarding/profile").set("Authorization", `Bearer ${signToken({ userId: user.id, role })}`).send(profile).expect(403);
  }
});
test("expired keys do not count, and embedded integration needs a public key", async t => {
  const { db, tenant, call } = await setup(t);
  await call("put", "/v1/onboarding/profile").send({ ...profile, integration: "react", allowedDomains: ["app.example.com"] }).expect(200);
  await db.apiKey.create({ data: { tenantId: tenant.id, keyType: "secret", status: "active", isLive: false } });
  await db.apiKey.create({ data: { tenantId: tenant.id, keyType: "public", status: "active", isLive: false, expiresAt: new Date(0) } });
  assert.equal((await call("get", "/v1/onboarding")).body.steps.keys, false);
  db.apiKey.rows[1].expiresAt = null;
  assert.equal((await call("get", "/v1/onboarding")).body.steps.keys, true);
});
test("dashboard webhooks use user auth, omit stored secrets and scope retries", async t => {
  const { db, tenant, call } = await setup(t);
  const r = await call("put", "/v1/onboarding/webhook").send({ url: "https://example.com/hook" }).expect(200);
  assert.match(r.body.secret, /^whsec_/); assert.equal(tenant.webhookSecret, r.body.secret);
  const status = await call("get", "/v1/onboarding").expect(200);
  assert.equal(JSON.stringify(status.body).includes(r.body.secret), false);
  assert.equal(status.headers["cache-control"], "no-store");
  await call("put", "/v1/onboarding/delivery").send({ method: "polling" }).expect(400);
  await db.webhookDelivery.create({ data: { tenantId: "other", eventUid: "evt_other", status: "pending" } });
  await call("post", "/v1/onboarding/webhooks/evt_other/retry").send({}).expect(404);
});
test("session restoration returns safe identity only and existing MFA cannot be overwritten", async t => {
  const { user, call } = await setup(t); user.mfaSecret = "existing-secret"; user.passwordHash = "private";
  const r = await call("get", "/v1/auth/me").expect(200);
  assert.equal(r.body.mfaEnrolled, true); assert.equal(r.body.passwordHash, undefined); assert.equal(r.body.mfaSecret, undefined);
  await call("post", "/v1/auth/mfa/confirm").send({ secret: "new", totp: "123456" }).expect(400);
  assert.equal(user.mfaSecret, "existing-secret");
});
test("signup validates input and creates sandbox admin with atomic nested creation", async t => {
  const db = createMockDb(); setDb(db); t.after(() => setDb(null));
  let creation = null;
  db.tenant.create = async args => {
    creation = args;
    return { id: "000000000000000000000001", users: [{ id: "000000000000000000000002", email: args.data.users.create.email, role: args.data.users.create.role }] };
  };
  const submit = body => request(app).post("/v1/auth/register").send(body);
  await submit({ companyName: "Example", email: "invalid", password: "long-enough-password" }).expect(400);
  assert.equal(creation, null);
  const r = await submit({ companyName: " Example ", email: " Admin@Example.com ", password: "long-enough-password", role: "super_admin", status: "active" }).expect(201);
  assert.equal(creation.data.status, "sandbox"); assert.equal(creation.data.users.create.role, "tenant_admin");
  assert.equal(creation.data.users.create.email, "admin@example.com");
  assert.ok(verifyPassword("long-enough-password", creation.data.users.create.passwordHash));
  assert.ok(r.body.token); assert.equal(r.body.passwordHash, undefined);
  db.tenant.create = async () => { throw Object.assign(new Error("duplicate"), { code: "P2002" }); };
  await submit({ companyName: "Example", email: "Admin@Example.com", password: "long-enough-password" }).expect(400);
});
test("signup rate limiting is keyed by IP even when email changes", () => {
  const limiter = require("../src/middleware/rateLimit").standardLimiters().signup;
  let allowed = 0; let blocked = null; let retryAfter = null;
  const res = { setHeader: (key, value) => { if (key === "Retry-After") retryAfter = value; } };
  for (let i = 0; i < 6; i++) limiter({ ip: "signup-test-ip", body: { email: `user${i}@example.com` } }, res, error => { if (error) blocked = error; else allowed++; });
  assert.equal(allowed, 5); assert.equal(blocked.code, "RATE_LIMITED"); assert.ok(retryAfter > 0);
});
test("MFA setup handles invalid secrets and completion reads actual enrollment", async t => {
  const { call } = await setup(t);
  await call("post", "/v1/auth/mfa/confirm").send({ secret: { unexpected: true }, totp: "123456" }).expect(400);
  const enrolled = await call("post", "/v1/auth/mfa/enroll").send({}).expect(200);
  const { totpAt } = require("../src/services/totp");
  await call("post", "/v1/auth/mfa/confirm").send({ secret: enrolled.body.secret, totp: totpAt(enrolled.body.secret, Math.floor(Date.now() / 1000)) }).expect(200);
  const status = await call("get", "/v1/onboarding").expect(200);
  assert.equal(status.body.steps.security, true); assert.equal(status.body.mfaEnrolled, true);
});

test("admin config → queued test → real HTTP receiver → visible signed delivery", async t => {
  const { db, tenant, call } = await setup(t);
  const http = require("node:http");
  const { once } = require("node:events");
  const { verifyWebhookSignature } = require("@verifypass/shared");
  const { drainDbQueue } = require("../worker.lambda");
  const received = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ body, headers: req.headers, method: req.method });
    res.writeHead(204); res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  await call("post", "/v1/onboarding/webhooks/test").send({}).expect(400);
  const config = await call("put", "/v1/onboarding/webhook").send({ url: "https://receiver.example/hook" }).expect(200);
  const queued = await call("post", "/v1/onboarding/webhooks/test").set("X-Tenant-Id", "forged").send({ tenantId: "forged" }).expect(202);
  assert.equal(db.webhookDelivery.rows[0].tenantId, tenant.id);
  assert.equal(db.webhookDelivery.rows[0].status, "pending");
  // Only transport destination/DNS are substituted; HTTP, HMAC, queue,
  // dispatcher, authenticated routes and delivery persistence all execute.
  const deps = {
    db, provider: {}, validateTarget: async () => {},
    fetchImpl: (url, opts) => {
      assert.equal(url, "https://receiver.example/hook");
      return fetch(`http://127.0.0.1:${server.address().port}/hook`, opts);
    }
  };
  await drainDbQueue(deps);
  assert.equal(received.length, 1);
  assert.equal(received[0].method, "POST");
  assert.equal(verifyWebhookSignature(received[0].body, received[0].headers, config.body.secret), true);
  assert.equal(JSON.parse(received[0].body).event, "webhook.test");
  assert.equal(JSON.parse(received[0].body).eventId, queued.body.eventId);
  const log = await call("get", "/v1/dashboard/webhook-deliveries").expect(200);
  assert.deepEqual(log.body.tenant, { tenantUid: tenant.tenantUid, companyName: tenant.companyName });
  assert.equal(log.body.deliveries[0].status, "delivered");
  assert.equal(log.body.deliveries[0].lastStatusCode, 204);
  assert.equal(JSON.stringify(log.body).includes(config.body.secret), false);
  await call("post", `/v1/onboarding/webhooks/${queued.body.eventId}/retry`).send({}).expect(400);

  // Actual verification finalization must dispatch its generated webhook in
  // the same default drain invocation (no next-minute cron required).
  await db.verificationSession.create({ data: {
    tenantId: tenant.id, sessionUid: "vps_admin_delivery", status: "submitted", verificationType: "FACE_ONLY"
  } });
  await db.jobQueue.create({ data: {
    type: "run_verification", payload: { sessionUid: "vps_admin_delivery" },
    status: "pending", runAfter: new Date(0), maxAttempts: 5, attempts: 0
  } });
  const drained = await drainDbQueue(deps);
  assert.equal(drained.failed, 0);
  assert.equal(drained.processed, 2);
  assert.equal(received.length, 2);
  assert.equal(JSON.parse(received[1].body).event, "verification.failed");
  assert.equal(JSON.parse(received[1].body).sessionId, "vps_admin_delivery");
  assert.equal(verifyWebhookSignature(received[1].body, received[1].headers, config.body.secret), true);
});

test("test webhook requires admin and transactionally preserves queue-outage recovery", async t => {
  const { db, tenant, call } = await setup(t);
  const { queueWebhookTest } = require("../src/services/webhookTest");
  await call("put", "/v1/onboarding/webhook").send({ url: "https://receiver.example/hook" }).expect(200);
  const developer = await db.user.create({ data: { tenantId: tenant.id, role: "developer", status: "active" } });
  await request(app).post("/v1/onboarding/webhooks/test").set("Authorization", `Bearer ${signToken({ userId: developer.id, role: developer.role })}`).send({}).expect(403);
  const queued = await queueWebhookTest(tenant, { db, enqueue: async () => { throw new Error("queue unavailable"); } });
  assert.equal(db.webhookDelivery.rows[0].eventUid, queued.eventId);
  assert.equal(db.outbox.rows[0].status, "pending");
  const { flushOutbox } = require("../src/services/outbox");
  await flushOutbox(db, async (type, payload) => db.jobQueue.create({ data: { type, payload } }));
  assert.equal(db.outbox.rows[0].status, "sent");
  assert.equal(db.jobQueue.rows[0].payload.deliveryId, db.webhookDelivery.rows[0].id);
  db.outbox.create = async () => { throw new Error("database unavailable"); };
  await assert.rejects(queueWebhookTest(tenant, { db, enqueue: async () => {} }), /database unavailable/);
  assert.equal(db.webhookDelivery.rows.length, 1, "no orphan delivery when outbox creation rolls back");
});

test("admin and secret-key API reject the same unsupported webhook URLs", async t => {
  const { tenant, call } = await setup(t);
  const key = await call("post", "/v1/settings/api-keys").send({ keyType: "secret", isLive: false }).expect(201);
  const secretApi = () => request(app).put("/v1/webhooks/config").set("Authorization", `Bearer ${key.body.key}`);
  for (const url of ["http://example.com/hook", "https://example.com:8443/hook", "https://user:pass@example.com/hook", "https://127.0.0.1/hook"]) {
    await call("put", "/v1/onboarding/webhook").send({ url }).expect(400);
    await secretApi().send({ url }).expect(400);
  }
  assert.equal(tenant.webhookUrl, undefined);
  const saved = await secretApi().send({ url: "https://example.com:443/hook" }).expect(200);
  assert.equal(saved.body.url, "https://example.com/hook");
  assert.equal(saved.headers["cache-control"], "no-store");
});
