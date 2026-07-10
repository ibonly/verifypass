"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { screenCustomer } = require("../src/worker/screening");

const subject = { fullName: "Adewale Test", customerReference: "cust_1" };

test("default backend none → not performed, no hit", async () => {
  const r = await screenCustomer(subject, { env: {} });
  assert.deepEqual(r, { performed: false, backend: "none", hit: false });
});

test("webhook backend: sanctions/pep/matches all flag a hit", async () => {
  for (const body of [{ sanctions: true }, { pep: true }, { matches: [{ list: "OFAC" }] }]) {
    const r = await screenCustomer(subject, {
      env: { SCREENING_BACKEND: "webhook", SCREENING_WEBHOOK_URL: "https://scr.example/check" },
      fetchImpl: async () => ({ ok: true, json: async () => body })
    });
    assert.equal(r.performed, true);
    assert.equal(r.hit, true, JSON.stringify(body));
  }
});

test("webhook backend: clean result → performed, no hit", async () => {
  const r = await screenCustomer(subject, {
    env: { SCREENING_BACKEND: "webhook", SCREENING_WEBHOOK_URL: "https://scr.example/check" },
    fetchImpl: async () => ({ ok: true, json: async () => ({ sanctions: false, pep: false, matches: [] }) })
  });
  assert.deepEqual({ performed: r.performed, hit: r.hit }, { performed: true, hit: false });
});

test("fail-open but RECORDED: provider error / missing URL / missing name", async () => {
  const failing = await screenCustomer(subject, {
    env: { SCREENING_BACKEND: "webhook", SCREENING_WEBHOOK_URL: "https://scr.example/check" },
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); }
  });
  assert.equal(failing.performed, false);
  assert.equal(failing.hit, false);
  assert.match(failing.error, /ECONNREFUSED/);

  const noUrl = await screenCustomer(subject, { env: { SCREENING_BACKEND: "webhook" } });
  assert.match(noUrl.error, /SCREENING_WEBHOOK_URL/);

  const noName = await screenCustomer({ fullName: null }, {
    env: { SCREENING_BACKEND: "webhook", SCREENING_WEBHOOK_URL: "https://scr.example/check" }
  });
  assert.match(noName.error, /no name/);
});

test("webhook auth header sent when token configured", async () => {
  let seen = null;
  await screenCustomer(subject, {
    env: { SCREENING_BACKEND: "webhook", SCREENING_WEBHOOK_URL: "https://scr.example/check", SCREENING_WEBHOOK_TOKEN: "tok_1" },
    fetchImpl: async (url, opts) => { seen = opts.headers; return { ok: true, json: async () => ({}) }; }
  });
  assert.equal(seen.authorization, "Bearer tok_1");
});
