"use strict";

// Self-locating SDK tokens: the environment (API origin) travels inside the
// credential, so browser SDKs never take a baseUrl. The embedded origin is
// covered by the token HMAC — tampering with it invalidates the token.

const test = require("node:test");
const assert = require("node:assert/strict");

const { setDb } = require("../src/lib/db");
const { createMockDb } = require("./helpers/mockDb");
const { tenantScope } = require("../src/middleware/tenantScope");
const { createSession, signSdkToken, verifySdkToken } = require("../src/services/sessionService");
const config = require("../src/config");

function scopeFor(tenant) {
  const req = { tenant };
  tenantScope(req, {}, () => {});
  return req.scopedDb;
}

function decodePayload(token) {
  const b64 = token.slice("sdk_v1_".length);
  return JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
}

test("issued tokens are v1 and embed this deployment's API origin", async (t) => {
  const db = createMockDb();
  setDb(db);
  t.after(() => setDb(null));

  const tenant = await db.tenant.create({ data: { tenantUid: "tnt_tok", companyName: "T", status: "active" } });
  const created = await createSession(scopeFor(tenant), {}, false);

  assert.match(created.sdkToken, /^sdk_v1_[A-Za-z0-9_-]+$/);
  const payload = decodePayload(created.sdkToken);
  assert.equal(payload.u, config.apiPublicUrl);
  assert.equal(typeof payload.t, "string");

  // and it verifies against the stored hash
  const session = await scopeFor(tenant).sessions.findByUid(created.sessionId);
  assert.equal(verifySdkToken(created.sessionId, created.sdkToken, session.sdkTokenHash), true);
});

test("tampering with the embedded origin invalidates the token", () => {
  const { token, tokenHash } = signSdkToken("vps_TAMPER");
  const payload = decodePayload(token);
  payload.u = "https://evil.example"; // attacker redirects SDK traffic
  const forged = `sdk_v1_${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;

  assert.equal(verifySdkToken("vps_TAMPER", forged, tokenHash), false);
  assert.equal(verifySdkToken("vps_TAMPER", token, tokenHash), true); // original still fine
});

test("legacy raw tokens still verify (hash covers whatever string was issued)", () => {
  // simulate a pre-v1 token: hash computed over the raw string
  const crypto = require("crypto");
  const legacy = "sdk_legacyrandomtoken123";
  const hash = crypto.createHmac("sha256", config.sdkTokenSecret).update(`vps_L.${legacy}`).digest("hex");
  assert.equal(verifySdkToken("vps_L", legacy, hash), true);
});
