"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { VerifyPassClient, parseSdkToken } = require("../src/client");
const { readPublicConfig } = require("../src/config");
const options = { baseUrl: "https://api.example.com", sessionId: "vps_test", sdkToken: "sdk_test" };

test("API origins reject insecure transport, credentials and URL suffixes", () => {
  for (const baseUrl of ["http://api.example.com", "https://user:pass@api.example.com", "https://api.example.com?redirect=x", "https://api.example.com#x", "https://api.example.com\\other", "javascript:alert(1)"]) {
    assert.throws(() => new VerifyPassClient({ ...options, baseUrl }));
    const token = `sdk_v1_${Buffer.from(JSON.stringify({ u: baseUrl })).toString("base64url")}`;
    assert.deepEqual(parseSdkToken(token), { baseUrl: null });
  }
  assert.equal(new VerifyPassClient({ ...options, baseUrl: "http://localhost:3000" }).baseUrl, "http://localhost:3000");
});

test("public configuration allowlists app settings and rejects secret keys", () => {
  const config = readPublicConfig({ VITE_VP_API_BASE: options.baseUrl, VITE_VP_PUBLIC_KEY: "vp_pub_test_example", DATABASE_URL: "private", VP_SECRET_KEY: "private" });
  assert.equal(config.baseUrl, options.baseUrl);
  assert.equal(config.publicKey, "vp_pub_test_example");
  assert.equal(JSON.stringify(config).includes("private"), false);
  assert.throws(() => readPublicConfig({ VITE_VP_PUBLIC_KEY: "vp_sec_test_example" }), /secret key/);
  assert.throws(() => new VerifyPassClient({ ...options, publicKey: "vp_sec_test_example" }), /secret key/);
  assert.throws(() => new VerifyPassClient({ ...options, sessionId: "../other?token=x" }));
});

test("requests omit cookies, referrers and caches and refuse redirects", async () => {
  const client = new VerifyPassClient({ ...options, fetchImpl: async (url, request) => {
    assert.equal(request.redirect, "error");
    assert.equal(request.credentials, "omit");
    assert.equal(request.cache, "no-store");
    assert.equal(request.referrerPolicy, "no-referrer");
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  } });
  await client.uploadFace("synthetic");
});

test("malformed success responses never confirm an upload", async () => {
  for (const body of [null, [], {}, { success: "true" }, "html"]) {
    const client = new VerifyPassClient({ ...options, fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }) });
    await assert.rejects(client.uploadFace("synthetic"), { code: "INVALID_RESPONSE" });
  }
});

test("disposed clients never issue requests or accept late responses", async () => {
  let finish;
  let calls = 0;
  const client = new VerifyPassClient({ ...options, fetchImpl: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const pending = client.getChallenge();
  client.dispose();
  finish({ ok: true, status: 200, json: async () => ({ success: true, attemptId: "stale" }) });
  await assert.rejects(pending, /cancelled/);
  assert.equal(client.attemptId, undefined);
  await assert.rejects(client.getStatus(), /cancelled/);
  assert.equal(calls, 1);
});