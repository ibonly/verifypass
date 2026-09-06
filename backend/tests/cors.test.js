"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { cors } = require("../src/middleware/cors");

function runCors(origin, method = "GET", requestHeaders = {}) {
  const headers = new Map();
  const req = { headers: { origin, ...requestHeaders }, method };
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
