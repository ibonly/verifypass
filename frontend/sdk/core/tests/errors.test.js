"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { VerifyPassError, toVerifyPassError } = require("../src/errors");
const { VerifyPassApiError } = require("../src/client");

test("API errors pass through unchanged and are VerifyPassErrors", () => {
  const err = new VerifyPassApiError("SESSION_EXPIRED", "expired", 410);
  assert.ok(err instanceof VerifyPassError);
  assert.equal(toVerifyPassError(err), err);
  assert.equal(err.http, 410);
});

test("camera DOMException names map to stable codes, keeping the cause", () => {
  const cases = { NotAllowedError: "CAMERA_PERMISSION_DENIED", NotFoundError: "CAMERA_NOT_FOUND", NotReadableError: "CAMERA_IN_USE" };
  for (const [name, code] of Object.entries(cases)) {
    const raw = Object.assign(new Error("x"), { name });
    const out = toVerifyPassError(raw, "CAMERA_ERROR", { camera: true });
    assert.equal(out.code, code);
    assert.equal(out.cause, raw);
  }
  // Same name outside camera context is not guessed at.
  assert.equal(toVerifyPassError(Object.assign(new Error("x"), { name: "NotFoundError" }), "CAPTURE_FAILED").code, "CAPTURE_FAILED");
});

test("existing string codes, network failures and fallbacks", () => {
  assert.equal(toVerifyPassError(Object.assign(new Error("no cam"), { code: "CAMERA_UNSUPPORTED" }), "CAMERA_ERROR", { camera: true }).code, "CAMERA_UNSUPPORTED");
  assert.equal(toVerifyPassError(new TypeError("Failed to fetch")).code, "NETWORK_ERROR");
  assert.equal(toVerifyPassError(new TypeError("x is not a function")).code, "UNKNOWN_ERROR");
  const s = toVerifyPassError("boom", "INIT_FAILED");
  assert.equal(s.code, "INIT_FAILED");
  assert.equal(s.message, "boom");
});
