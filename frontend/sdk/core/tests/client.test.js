"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  VerifyPassClient,
  claimMobileHandoff,
  parseHandoffToken,
  pollingTimeoutForExpiry
} = require("../src/client");

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
  assert.deepEqual(JSON.parse(call.opts.body), { sdkToken: "sdk_tok", action: "blink", imageBase64: "IMG64", captureMode: "unknown" });
  assert.equal(call.opts.headers["X-VP-SDK-Token"], "sdk_tok");
});

test("getChallenge fetches the server-issued actions", async () => {
  const fetch = mockFetch([{ body: { success: true, verificationType: "ID_AND_FACE", livenessActions: ["blink", "turn_left"] } }]);
  const client = new VerifyPassClient({ ...BASE, fetchImpl: fetch });
  const res = await client.getChallenge();
  assert.deepEqual(res.livenessActions, ["blink", "turn_left"]);
  // v5 A5: the session credential rides in a header, never the query string
  assert.ok(fetch.calls[0].url.endsWith("/challenge"));
  assert.ok(!fetch.calls[0].url.includes("sdkToken="));
  assert.equal(fetch.calls[0].opts.headers["X-VP-SDK-Token"], "sdk_tok");
});

test("beginChallenge posts to /challenge/begin with the attempt and records the deadlines", async () => {
  const fetch = mockFetch([
    { body: { success: true, verificationType: "FACE_ONLY", livenessActions: ["turn_left", "turn_right"], attemptId: "att_1" } },
    { body: { success: true, refreshed: true, challengeIssuedAt: "2026-09-07T10:00:00.000Z", challengeExpiresAt: "2026-09-07T10:10:00.000Z", firstFrameDeadline: "2026-09-07T10:03:00.000Z", sessionExpiresAt: "2026-09-07T10:30:00.000Z" } }
  ]);
  const client = new VerifyPassClient({ ...BASE, fetchImpl: fetch });
  await client.getChallenge();
  const res = await client.beginChallenge();
  assert.equal(res.refreshed, true);
  const call = fetch.calls[1];
  assert.equal(call.url, "https://api.test/v1/verification-sessions/vps_1/challenge/begin");
  assert.equal(call.opts.method, "POST");
  assert.deepEqual(JSON.parse(call.opts.body), { sdkToken: "sdk_tok", attemptId: "att_1" });
  assert.deepEqual(client.challengeDeadlines, { challengeExpiresAt: "2026-09-07T10:10:00.000Z", firstFrameDeadline: "2026-09-07T10:03:00.000Z", sessionExpiresAt: "2026-09-07T10:30:00.000Z" });
});

test("getStatus sends the sdk token as a header (not in the URL)", async () => {
  const fetch = mockFetch([{ body: { success: true, status: "submitted" } }]);
  const client = new VerifyPassClient({ ...BASE, sdkToken: "sdk_a+b/c", fetchImpl: fetch });
  await client.getStatus();
  assert.ok(fetch.calls[0].url.endsWith("/status"));
  assert.equal(fetch.calls[0].opts.headers["X-VP-SDK-Token"], "sdk_a+b/c");
});

test("reissueChallenge posts the excluded actions; submit carries capture + telemetry", async () => {
  const fetch = mockFetch([
    { body: { success: true, reissue: 1, livenessChallenge: { actions: ["turn_left", "turn_right", "look_down"] } } },
    { body: { success: true, status: "submitted" } }
  ]);
  const client = new VerifyPassClient({ ...BASE, fetchImpl: fetch });
  const r = await client.reissueChallenge(["look_up"]);
  assert.deepEqual(r.livenessChallenge.actions, ["turn_left", "turn_right", "look_down"]);
  assert.deepEqual(JSON.parse(fetch.calls[0].opts.body).excludeActions, ["look_up"]);
  client.setCaptureSignals({ cameraLabel: "FaceTime" });
  client.setCaptureTelemetry({ actions: [{ action: "turn_left", msToTrigger: 900, mode: "auto" }] });
  await client.submit();
  const body = JSON.parse(fetch.calls[1].opts.body);
  assert.equal(body.capture.cameraLabel, "FaceTime");
  assert.equal(body.telemetry.actions[0].msToTrigger, 900);
});

test("waitForResult polls until terminal status", async () => {
  const fetch = mockFetch((n) =>
    n < 3 ? { body: { success: true, status: "submitted" } } : { body: { success: true, status: "approved", sessionId: "vps_1" } }
  );
  const client = new VerifyPassClient({ ...BASE, fetchImpl: fetch });
  const ticks = [];
  const result = await client.waitForResult({ intervalMs: 1, onTick: (s) => ticks.push(s.status) });
  assert.equal(result.status, "approved");
  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(ticks, ["submitted", "submitted", "approved"]);
});

test("waitForResult distinguishes a local polling timeout from server expiry", async () => {
  const fetch = mockFetch(() => ({ body: { success: true, status: "submitted" } }));
  const client = new VerifyPassClient({ ...BASE, fetchImpl: fetch });
  await assert.rejects(
    () => client.waitForResult({ intervalMs: 1, timeoutMs: 5 }),
    (e) => e.code === "POLLING_TIMEOUT"
  );
});

test("waitForResult honours an explicit signal (caller-scoped, not the shared parent)", async () => {
  // A child controller lets a caller restart polling on retry WITHOUT
  // aborting the shared parent — which would kill the init effect.
  const fetch = mockFetch((n) =>
    n < 2 ? { body: { success: true, status: "submitted" } } : { body: { success: true, status: "approved", sessionId: "vps_1" } }
  );
  const client = new VerifyPassClient({ ...BASE, fetchImpl: fetch });
  const child = new AbortController();
  const result = await client.waitForResult({ intervalMs: 1, signal: child.signal });
  assert.equal(result.status, "approved");
  assert.equal(fetch.calls.length, 2);
  // The parent is untouched — a later poll would still work.
  assert.equal(client.controller.signal.aborted, false);
});

test("waitForResult aborts on its own signal without touching the parent", async () => {
  const fetch = mockFetch(() => ({ body: { success: true, status: "submitted" } }));
  const client = new VerifyPassClient({ ...BASE, fetchImpl: fetch });
  const child = new AbortController();
  child.abort();
  await assert.rejects(
    () => client.waitForResult({ intervalMs: 1, timeoutMs: 10000, signal: child.signal }),
    (e) => /Verification cancelled/.test(e.message)
  );
  assert.equal(client.controller.signal.aborted, false);
});

test("getHostedUrl builds the hosted verification URL with the token in the fragment", async () => {
  const fetch = mockFetch([{ body: {
    success: true, verificationType: "ID_AND_FACE", livenessActions: ["turn_left"],
    hostedBaseUrl: "https://verify.example.com", handoffToken: "vph_test", attemptId: "att_1"
  }}]);
  const client = new VerifyPassClient({ ...BASE, fetchImpl: fetch });
  await client.getChallenge({ mobileHandoff: true });
  const url = client.getHostedUrl();
  const u = new URL(url);
  assert.equal(u.origin, "https://verify.example.com");
  assert.equal(u.pathname, "/session/vps_1");
  assert.equal(u.hash, "#h=vph_test");
  // The token lives ONLY in the fragment — browsers drop fragments on
  // requests, so it never reaches any server. Assert the server-sent
  // portion (pathname + search) is free of the token.
  const serverSent = `${u.origin}${u.pathname}${u.search}`;
  assert.ok(!serverSent.includes("sdk_tok"), "token must not appear in the server-sent URL portion");
  // No query string, no credentials, no fragment other than the token
  assert.equal(u.search, "");
  assert.equal(u.username, "");
  assert.equal(u.password, "");
  assert.ok(fetch.calls[0].url.endsWith("/challenge?handoff=1"));
});

test("getHostedUrl rejects URLs with a query string or credentials", async () => {
  const fetch = mockFetch([{ body: {
    success: true, verificationType: "ID_AND_FACE", livenessActions: ["turn_left"],
    hostedBaseUrl: "https://verify.example.com/?x=1", handoffToken: "vph_test", attemptId: "att_1"
  }}]);
  const client = new VerifyPassClient({ ...BASE, fetchImpl: fetch });
  await client.getChallenge({ mobileHandoff: true });
  assert.throws(() => client.getHostedUrl(), /Invalid hosted verification URL/);
});

test("getHostedUrl throws before getChallenge has run", () => {
  const client = new VerifyPassClient({ ...BASE, fetchImpl: mockFetch([]) });
  assert.throws(() => client.getHostedUrl(), /Hosted verification URL is not configured/);
});

test("self-locating SDK tokens reject a mismatched explicit API URL", () => {
  const payload = Buffer.from(JSON.stringify({ u: "https://issuer.example", t: "random" })).toString("base64url");
  assert.throws(
    () => new VerifyPassClient({ ...BASE, baseUrl: "https://other.example", sdkToken: `sdk_v1_${payload}`, fetchImpl: mockFetch([]) }),
    /does not match the credential issuer/
  );
});

test("claimMobileHandoff exchanges a self-locating one-time token", async () => {
  const payload = Buffer.from(JSON.stringify({ u: "https://api.test", t: "random" })).toString("base64url");
  const handoffToken = `vph_v1_${payload}`;
  const fetch = mockFetch([{ body: { success: true, sessionId: "vps_1", sdkToken: "sdk_mobile" } }]);
  const result = await claimMobileHandoff({ sessionId: "vps_1", handoffToken, fetchImpl: fetch });
  assert.equal(result.sdkToken, "sdk_mobile");
  assert.equal(fetch.calls[0].url, "https://api.test/v1/verification-sessions/vps_1/handoff/claim");
  assert.deepEqual(JSON.parse(fetch.calls[0].opts.body), { handoffToken });
  assert.equal(parseHandoffToken(handoffToken).baseUrl, "https://api.test");
});

test("pollingTimeoutForExpiry follows the server deadline with grace", () => {
  const timeout = pollingTimeoutForExpiry(new Date(Date.now() + 2000).toISOString(), 99, 500);
  assert.ok(timeout >= 2400 && timeout <= 2500);
  assert.equal(pollingTimeoutForExpiry("invalid", 1234), 1234);
});
