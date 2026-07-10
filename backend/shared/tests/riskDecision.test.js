"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { decide, resolveThresholds } = require("../src/decisionEngine");
const { DEFAULT_THRESHOLDS } = require("../src/reasonCodes");

const clean = {
  selfie: { faceCount: 1 },
  liveness: { score: 0.95 },
  idFace: { found: true },
  faceMatch: { score: 0.9 },
  document: { ocrConfidence: 0.94, expired: false }
};

test("risk flags force manual_review on an otherwise-approved case", () => {
  const d = decide({ ...clean, risk: { repeatedFailedAttempts: true } }, DEFAULT_THRESHOLDS);
  assert.equal(d.status, "manual_review");
  assert.deepEqual(d.reasonCodes, ["REPEATED_FAILED_ATTEMPTS"]);
  assert.equal(d.riskLevel, "medium");
});

test("multiple risk flags accumulate", () => {
  const d = decide({
    ...clean,
    risk: { repeatedFailedAttempts: true, deviceSharedAcrossIdentities: true, ipVelocityExceeded: true }
  }, DEFAULT_THRESHOLDS);
  assert.equal(d.status, "manual_review");
  assert.deepEqual(
    [...d.reasonCodes].sort(),
    ["DEVICE_SHARED_ACROSS_IDENTITIES", "IP_VELOCITY_EXCEEDED", "REPEATED_FAILED_ATTEMPTS"]
  );
});

test("risk flags never rescue a rejection — reject wins, codes preserved", () => {
  const d = decide({
    ...clean,
    liveness: { score: 0.2 },
    risk: { deviceSharedAcrossIdentities: true }
  }, DEFAULT_THRESHOLDS);
  assert.equal(d.status, "rejected");
  assert.ok(d.reasonCodes.includes("LIVENESS_FAILED"));
  assert.ok(d.reasonCodes.includes("DEVICE_SHARED_ACROSS_IDENTITIES"));
});

test("no risk object → behaves exactly as before", () => {
  const d = decide(clean, DEFAULT_THRESHOLDS);
  assert.equal(d.status, "approved");
  assert.deepEqual(d.reasonCodes, []);
});

test("resolveThresholds merges tenant risk settings over defaults", () => {
  const t = resolveThresholds({ thresholds: { risk: { maxIdentitiesPerDevice: 1, maxSessionsPerIpPerHour: 5 } } });
  assert.equal(t.risk.maxIdentitiesPerDevice, 1);
  assert.equal(t.risk.maxSessionsPerIpPerHour, 5);
  assert.equal(t.risk.failedAttemptsWindowHours, DEFAULT_THRESHOLDS.risk.failedAttemptsWindowHours);
});
