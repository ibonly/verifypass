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
  for (const url of ["http://example.com", "javascript:alert(1)", "https://user:pass@example.com", "https://example.com/#secret"]) assert.throws(() => validateWebhookUrl(url));
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
