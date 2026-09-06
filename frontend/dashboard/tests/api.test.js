import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Load a fresh client against a tab-scoped storage/fetch stub without a browser.
async function client(seed = {}) {
  const values = new Map(Object.entries(seed));
  globalThis.sessionStorage = { getItem: k => values.get(k) || null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
  globalThis.__VP_API_BASE__ = "https://api.example.com";
  const source = await readFile(new URL("../src/api.js", import.meta.url), "utf8");
  return { values, module: await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${Math.random()}`) };
}
test("logout and tenant-admin login remove stale super-admin tenant context", async () => {
  const { module: api, values } = await client({ vp_token: "old-token", vp_tenant: "tnt_old" });
  assert.equal(api.getToken(), "old-token");
  api.setAuth(null);
  assert.equal(values.has("vp_token"), false); assert.equal(values.has("vp_tenant"), false);
  api.setAuth("new-token", null);
  let sent;
  globalThis.fetch = async (url, options) => { sent = options; return { ok: true, json: async () => ({ success: true }) }; };
  await api.api("/v1/auth/me");
  assert.equal(sent.headers.Authorization, "Bearer new-token");
  assert.equal(sent.headers["X-Tenant-Id"], undefined);
});
test("restored super-admin context is forwarded and validation errors remain actionable", async () => {
  const { module: api } = await client({ vp_token: "token", vp_tenant: "tnt_selected" });
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers["X-Tenant-Id"], "tnt_selected");
    return { ok: false, status: 400, json: async () => ({ error: { code: "VALIDATION_ERROR", message: "Incomplete", details: { errors: ["verification is incomplete"] } } }) };
  };
  await assert.rejects(api.api("/v1/onboarding/complete", { method: "POST", body: {} }), e => e.status === 400 && e.message.includes("verification is incomplete"));
});
