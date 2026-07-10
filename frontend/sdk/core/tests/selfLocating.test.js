"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { VerifyPassClient, parseSdkToken } = require("../src/client");

function v1Token(origin, raw = "rand0m") {
  return `sdk_v1_${Buffer.from(JSON.stringify({ u: origin, t: raw })).toString("base64url")}`;
}

const noFetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

test("parseSdkToken extracts the embedded origin; rejects junk safely", () => {
  assert.deepEqual(parseSdkToken(v1Token("https://api.sandbox.acme.ng")), { baseUrl: "https://api.sandbox.acme.ng" });
  assert.deepEqual(parseSdkToken(v1Token("https://api.acme.ng/")), { baseUrl: "https://api.acme.ng" }); // trailing slash stripped
  assert.deepEqual(parseSdkToken("sdk_legacyrandom"), { baseUrl: null });
  assert.deepEqual(parseSdkToken(v1Token("javascript:alert(1)")), { baseUrl: null }); // non-http scheme rejected
  assert.deepEqual(parseSdkToken("sdk_v1_!!!notbase64!!!"), { baseUrl: null });
  assert.deepEqual(parseSdkToken(null), { baseUrl: null });
});

test("client is self-locating: no baseUrl needed with a v1 token", () => {
  const c = new VerifyPassClient({
    sessionId: "vps_1",
    sdkToken: v1Token("https://api.prod.verifypass.com"),
    fetchImpl: noFetch
  });
  assert.equal(c.baseUrl, "https://api.prod.verifypass.com");
});

test("explicit baseUrl overrides the token (dev proxies)", () => {
  const c = new VerifyPassClient({
    sessionId: "vps_1",
    sdkToken: v1Token("https://api.prod.verifypass.com"),
    baseUrl: "http://localhost:3000",
    fetchImpl: noFetch
  });
  assert.equal(c.baseUrl, "http://localhost:3000");
});

test("legacy token without baseUrl fails with a clear error", () => {
  assert.throws(
    () => new VerifyPassClient({ sessionId: "vps_1", sdkToken: "sdk_legacy", fetchImpl: noFetch }),
    /does not embed an API origin/
  );
});

test("requests go to the token's environment", async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ success: true }) }; };
  const c = new VerifyPassClient({ sessionId: "vps_9", sdkToken: v1Token("https://api.sandbox.x.ng"), fetchImpl });
  await c.uploadFace("IMG");
  assert.ok(calls[0].startsWith("https://api.sandbox.x.ng/v1/verification-sessions/vps_9/"));
});
