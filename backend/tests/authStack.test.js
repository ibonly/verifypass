"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { setDb } = require("../src/lib/db");
const { createMockDb } = require("./helpers/mockDb");
const { totpAt, verifyTotp, base32Encode } = require("../src/services/totp");
const { hashPassword, verifyPassword, createUser, authenticate } = require("../src/services/userService");
const { signToken, verifyToken } = require("../src/services/authTokens");

// RFC 6238 Appendix B test vectors (SHA-1). Secret = ASCII "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

test("TOTP matches RFC 6238 test vectors (6-digit truncation)", () => {
  // 8-digit vectors: 94287082 (t=59), 07081804 (t=1111111109), 89005924 (t=1234567890)
  assert.equal(totpAt(RFC_SECRET, 59), "287082");
  assert.equal(totpAt(RFC_SECRET, 1111111109), "081804");
  assert.equal(totpAt(RFC_SECRET, 1234567890), "005924");
});

test("verifyTotp accepts ±1 step drift, rejects garbage", () => {
  const now = 1234567890;
  const code = totpAt(RFC_SECRET, now);
  assert.equal(verifyTotp(RFC_SECRET, code, { now }), true);
  assert.equal(verifyTotp(RFC_SECRET, code, { now: now + 30 }), true);  // one step later
  assert.equal(verifyTotp(RFC_SECRET, code, { now: now + 90 }), false); // too late
  assert.equal(verifyTotp(RFC_SECRET, "000000", { now }), false);
  assert.equal(verifyTotp(RFC_SECRET, "abc123", { now }), false);
});

test("scrypt password hash: verify, reject wrong, unique salts", () => {
  const h1 = hashPassword("correct horse battery staple");
  const h2 = hashPassword("correct horse battery staple");
  assert.notEqual(h1, h2); // salted
  assert.equal(verifyPassword("correct horse battery staple", h1), true);
  assert.equal(verifyPassword("wrong password entirely!", h1), false);
  assert.equal(verifyPassword("x", "malformed"), false);
});

test("auth tokens: roundtrip, expiry, tamper rejection", () => {
  const token = signToken({ userId: "42", role: "tenant_admin" });
  const payload = verifyToken(token);
  assert.equal(payload.userId, "42");
  assert.equal(payload.role, "tenant_admin");

  const expired = signToken({ userId: "42" }, { ttlSeconds: -10 });
  assert.equal(verifyToken(expired), null);

  const tampered = token.slice(0, -4) + "AAAA";
  assert.equal(verifyToken(tampered), null);
  assert.equal(verifyToken("vpu_garbage.sig"), null);
  assert.equal(verifyToken(null), null);
});

test("authenticate: password, MFA when enrolled, uniform failures", async (t) => {
  const db = createMockDb();
  setDb(db);
  t.after(() => setDb(null));

  const tenant = await db.tenant.create({ data: { tenantUid: "tnt_u", companyName: "U", status: "active" } });
  await createUser({ tenantId: tenant.id, email: "Reviewer@Acme.NG", password: "a-long-password-123", role: "compliance_reviewer" });

  // email is case-normalized
  const user = await authenticate({ email: "reviewer@acme.ng", password: "a-long-password-123" });
  assert.equal(user.role, "compliance_reviewer");

  // wrong password and unknown user → identical error code
  for (const creds of [
    { email: "reviewer@acme.ng", password: "wrong-password-123" },
    { email: "ghost@acme.ng", password: "a-long-password-123" }
  ]) {
    await assert.rejects(() => authenticate(creds), (e) => e.code === "FORBIDDEN");
  }

  // enroll MFA → login now requires valid TOTP
  await db.user.updateMany({ where: { email: "reviewer@acme.ng" }, data: { mfaSecret: RFC_SECRET } });
  await assert.rejects(
    () => authenticate({ email: "reviewer@acme.ng", password: "a-long-password-123", totp: "000000" }),
    (e) => e.code === "FORBIDDEN"
  );
  const now = Math.floor(Date.now() / 1000);
  const ok = await authenticate({ email: "reviewer@acme.ng", password: "a-long-password-123", totp: totpAt(RFC_SECRET, now) });
  assert.equal(ok.email, "reviewer@acme.ng");
});

test("createUser enforces role and password policy", async (t) => {
  const db = createMockDb();
  setDb(db);
  t.after(() => setDb(null));
  await assert.rejects(() => createUser({ tenantId: 1, email: "a@b.c", password: "short", role: "tenant_admin" }),
    (e) => e.code === "VALIDATION_ERROR");
  await assert.rejects(() => createUser({ tenantId: 1, email: "a@b.c", password: "long-enough-password", role: "owner" }),
    (e) => e.code === "VALIDATION_ERROR");
});

test("userAuth middleware: JWT userId (string ObjectId) resolves the user — Mongo migration regression", async (t) => {
  const db = createMockDb();
  setDb(db);
  t.after(() => setDb(null));

  const { requireUser } = require("../src/middleware/userAuth");
  const tenant = await db.tenant.create({ data: { tenantUid: "tnt_ua", companyName: "UA", status: "active" } });
  const user = await db.user.create({
    data: { tenantId: tenant.id, email: "ua@acme.ng", passwordHash: "x", role: "tenant_admin", status: "active" }
  });
  const token = signToken({ userId: String(user.id), role: user.role });

  const req = { headers: { authorization: `Bearer ${token}` } };
  let nextErr = "not called";
  await requireUser()(req, {}, (err) => { nextErr = err; });

  assert.equal(nextErr, undefined, "middleware must call next() without error");
  assert.equal(String(req.user.id), String(user.id));
});
