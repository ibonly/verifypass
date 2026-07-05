"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { VerifyPassClient } = require("../src/client");

function mockFetch(responses) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    const r = typeof responses === "function" ? responses(calls.length, url) : responses[calls.length - 1];
    return {
      ok: r.status ? r.status < 400 : true,
      status: r.status || 200,
      json: async () => r.body
    };
  };
  fn.calls = calls;
  return fn;
}

const BASE = {
  baseUrl: "https://api.test",
  publicKey: "vp_pub_test_x",
  sessionId: "vps_1",
  sdkToken: "sdk_tok"
};

test("requires sessionId + sdkToken; publicKey optional (hosted mode)", () => {
  assert.throws(() => new VerifyPassClient({ baseUrl: "x", sessionId: "s" }));
  const hosted = new VerifyPassClient({ ...BASE, publicKey: null, fetchImpl: mockFetch([{ body: {} }]) });
  assert.ok(hosted);
});

test("uploadDocument posts correct path, body, and auth header", async () => {
  const fetch = mockFetch([{ body: { success: true, fileType: "id_front" } }]);
  const client = new VerifyPassClient({ ...BASE, fetchImpl: fetch });

  const res = await client.uploadDocument("BASE64DATA", "front");
  assert.equal(res.fileType, "id_front");

  const call = fetch.calls[0];
  assert.equal(call.url, "https://api.test/v1/verification-sessions/vps_1/document");
  assert.equal(call.opts.headers.Authorization, "Bearer vp_pub_test_x");
  const body = JSON.parse(call.opts.body);
  assert.deepEqual(body, { sdkToken: "sdk_tok", side: "front", imageBase64: "BASE64DATA" });
});

test("hosted mode omits Authorization header", async () => {
  const fetch = mockFetch([{ body: { success: true } }]);
  const client = new VerifyPassClient({ ...BASE, publicKey: null, fetchImpl: fetch });
  await client.uploadFace("IMG");
  assert.equal(fetch.calls[0].opts.headers.Authorization, undefined);
});

test("API errors map to code + message", async () => {
  const fetch = mockFetch([{ status: 422, body: { success: false, error: { code: "DOCUMENT_BLURRY", message: "too blurry" } } }]);
  const client = new VerifyPassClient({ ...BASE, fetchImpl: fetch });
  await assert.rejects(
    () => client.uploadDocument("IMG"),
    (e) => e.code === "DOCUMENT_BLURRY" && e.http === 422 && e.message === "too blurry"
  );
});

test("uploadLivenessFrame posts action + image to the liveness-frame endpoint", async () => {
  const fetch = mockFetch([{ body: { success: true, fileType: "liveness_frame", label: "blink" } }]);
  const client = new VerifyPassClient({ ...BASE, fetchImpl: fetch });
  const res = await client.uploadLivenessFrame("blink", "IMG64");
  assert.equal(res.label, "blink");
  const call = fetch.calls[0];
  assert.equal(call.url, "https://api.test/v1/verification-sessions/vps_1/liveness-frame");
  assert.deepEqual(JSON.parse(call.opts.body), { sdkToken: "sdk_tok", action: "blink", imageBase64: "IMG64" });
});

test("getChallenge fetches the server-issued actions", async () => {
  const fetch = mockFetch([{ body: { success: true, verificationType: "ID_AND_FACE", livenessActions: ["blink", "turn_left"] } }]);
  const client = new VerifyPassClient({ ...BASE, fetchImpl: fetch });
  const res = await client.getChallenge();
  assert.deepEqual(res.livenessActions, ["blink", "turn_left"]);
  assert.ok(fetch.calls[0].url.endsWith(`/challenge?sdkToken=${encodeURIComponent("sdk_tok")}`));
});

test("getStatus URL-encodes the sdk token", async () => {
  const fetch = mockFetch([{ body: { success: true, status: "submitted" } }]);
  const client = new VerifyPassClient({ ...BASE, sdkToken: "sdk_a+b/c", fetchImpl: fetch });
  await client.getStatus();
  assert.ok(fetch.calls[0].url.endsWith(`/status?sdkToken=${encodeURIComponent("sdk_a+b/c")}`));
});

test("waitForResult polls until terminal status", async () => {
  const fetch = mockFetch((n) =>
    n < 3 ? { body: { status: "submitted" } } : { body: { status: "approved", sessionId: "vps_1" } }
  );
  const client = new VerifyPassClient({ ...BASE, fetchImpl: fetch });
  const ticks = [];
  const result = await client.waitForResult({ intervalMs: 1, onTick: (s) => ticks.push(s.status) });
  assert.equal(result.status, "approved");
  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(ticks, ["submitted", "submitted", "approved"]);
});

test("waitForResult times out with SESSION_EXPIRED", async () => {
  const fetch = mockFetch(() => ({ body: { status: "submitted" } }));
  const client = new VerifyPassClient({ ...BASE, fetchImpl: fetch });
  await assert.rejects(
    () => client.waitForResult({ intervalMs: 1, timeoutMs: 5 }),
    (e) => e.code === "SESSION_EXPIRED"
  );
});
