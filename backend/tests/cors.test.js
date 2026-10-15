"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { cors } = require("../src/middleware/cors");

function runCors(origin, method = "GET", requestHeaders = {}, url = "/") {
  const headers = new Map();
  const req = { headers: { origin, ...requestHeaders }, method, url, path: url };
  const res = {
    statusCode: 200,
    setHeader(name, value) { headers.set(name, value); },
    status(code) { this.statusCode = code; return this; },
    end() { this.ended = true; }
  };
  let nextCalled = false;

  cors(req, res, () => { nextCalled = true; });

  return { headers, res, nextCalled };
}

test("development CORS allows forwarded http origins", () => {
  const { headers, nextCalled } = runCors("https://demo-5175.app.github.dev");

  assert.equal(headers.get("Access-Control-Allow-Origin"), "https://demo-5175.app.github.dev");
  assert.equal(headers.get("Vary"), "Origin");
  assert.equal(nextCalled, true);
});

test("CORS preflight ends with 204", () => {
  const { headers, res, nextCalled } = runCors("https://demo-5175.app.github.dev", "OPTIONS");

  assert.equal(headers.get("Access-Control-Allow-Origin"), "https://demo-5175.app.github.dev");
  assert.equal(res.statusCode, 204);
  assert.equal(res.ended, true);
  assert.equal(nextCalled, false);
});

test("sample app preflight permits SDK token authentication", () => {
  const { headers, res, nextCalled } = runCors("http://localhost:5175", "OPTIONS", {
    "access-control-request-method": "GET",
    "access-control-request-headers": "x-vp-sdk-token"
  });

  assert.equal(headers.get("Access-Control-Allow-Origin"), "http://localhost:5175");
  const allowedHeaders = headers.get("Access-Control-Allow-Headers").toLowerCase().split(/,\s*/);
  assert.ok(allowedHeaders.includes("x-vp-sdk-token"));
  assert.equal(res.statusCode, 204);
  assert.equal(res.ended, true);
  assert.equal(nextCalled, false);
});

function inProduction(fn) {
  const config = require("../src/config");
  const prev = { env: config.env, origins: process.env.CORS_ORIGINS };
  config.env = "production";
  process.env.CORS_ORIGINS = "https://dashboard.example.com";
  try { return fn(); } finally {
    config.env = prev.env;
    if (prev.origins === undefined) delete process.env.CORS_ORIGINS; else process.env.CORS_ORIGINS = prev.origins;
  }
}

test("production CORS lets any tenant origin call browser SDK routes", () => inProduction(() => {
  for (const url of ["/v1/verification-sessions/vps_1/challenge", "/v1/verification-sessions/vps_1/challenge/begin",
    "/v1/verification-sessions/vps_1/liveness-frame", "/v1/verification-sessions/vps_1/status", "/v1/verification-sessions/vps_1/handoff/claim"]) {
    const { headers } = runCors("https://shop.tenant.example", "OPTIONS", {}, url);
    assert.equal(headers.get("Access-Control-Allow-Origin"), "https://shop.tenant.example", url);
    assert.equal(headers.get("Access-Control-Allow-Credentials"), undefined);
  }
}));

test("production CORS keeps secret-key and dashboard routes on the allowlist", () => inProduction(() => {
  for (const url of ["/v1/verification-sessions", "/v1/verification-sessions/vps_1", "/v1/verification-sessions/vps_1/result", "/v1/auth/login", "/v1/verification-sessions/vps_1/status/extra"]) {
    const { headers } = runCors("https://shop.tenant.example", "OPTIONS", {}, url);
    assert.equal(headers.get("Access-Control-Allow-Origin"), undefined, url);
  }
  const { headers } = runCors("https://dashboard.example.com", "OPTIONS", {}, "/v1/auth/login");
  assert.equal(headers.get("Access-Control-Allow-Origin"), "https://dashboard.example.com");
}));

test("SDK route CORS rejects non-http origins", () => inProduction(() => {
  const { headers } = runCors("null", "OPTIONS", {}, "/v1/verification-sessions/vps_1/status");
  assert.equal(headers.get("Access-Control-Allow-Origin"), undefined);
}));
