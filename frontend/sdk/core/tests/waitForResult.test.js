"use strict";

// waitForResult resilience: one failed poll must never abort a verification
// that is completing server-side ("Failed to fetch" on mobile was killing
// the whole flow at the final screen).

const test = require("node:test");
const assert = require("node:assert/strict");

const { VerifyPassClient, VerifyPassApiError } = require("../src/client");

function clientWith(fetchImpl) {
  return new VerifyPassClient({
    baseUrl: "http://api.test",
    sessionId: "vps_TEST",
    sdkToken: "sdk_legacy_token",
    fetchImpl
  });
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const httpErr = (status, code) => ({ ok: false, status, json: async () => ({ error: { code, message: code } }) });

test("transient network failures are retried — verification still resolves", async () => {
  let call = 0;
  const c = clientWith(async () => {
    call++;
    if (call <= 2) throw new TypeError("Failed to fetch"); // wifi blip / server restart
    if (call === 3) return ok({ success: true, status: "submitted" });
    return ok({ success: true, status: "approved" });
  });
  const r = await c.waitForResult({ intervalMs: 1, timeoutMs: 5000 });
  assert.equal(r.status, "approved");
  assert.ok(call >= 4, "kept polling through the failures");
});

test("5xx and 429 are transient — polling continues", async () => {
  let call = 0;
  const c = clientWith(async () => {
    call++;
    if (call === 1) return httpErr(502, "INTERNAL_ERROR");
    if (call === 2) return httpErr(429, "RATE_LIMITED");
    return ok({ success: true, status: "rejected" });
  });
  const r = await c.waitForResult({ intervalMs: 1, timeoutMs: 5000 });
  assert.equal(r.status, "rejected");
});

test("definitive answers (401/404) abort immediately — no pointless polling", async () => {
  let call = 0;
  const c = clientWith(async () => { call++; return httpErr(404, "SESSION_NOT_FOUND"); });
  await assert.rejects(
    () => c.waitForResult({ intervalMs: 1, timeoutMs: 5000 }),
    (err) => err instanceof VerifyPassApiError && err.code === "SESSION_NOT_FOUND"
  );
  assert.equal(call, 1, "no retry on a definitive rejection");
});

test("persistent network failure surfaces the REAL error at the deadline", async () => {
  const c = clientWith(async () => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(
    () => c.waitForResult({ intervalMs: 1, timeoutMs: 30 }),
    /Failed to fetch/
  );
});
