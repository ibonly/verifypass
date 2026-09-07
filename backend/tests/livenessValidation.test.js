"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validationFingerprint, livenessValidation } = require("../src/lib/livenessValidation");

const release = { sourceDigest: "source-one", modelSet: "models-one", policyVersion: "policy-one" };
const options = { release, environment: {}, settings: { challenge: { enforcePose: true } }, thresholds: { liveness: { pass: 0.65 } } };

test("validation requires a matching receipt with dataset and evaluation provenance", () => {
  const fingerprint = validationFingerprint(options);
  assert.equal(livenessValidation(options).validated, false);
  assert.equal(livenessValidation({ ...options, environment: { LIVENESS_VALIDATED_POLICY: release.policyVersion } }).validated, false);
  for (const receipt of [{ fingerprint }, { fingerprint, dataset: "cohort-1" }]) {
    assert.equal(livenessValidation({ ...options, environment: { LIVENESS_VALIDATION_RECEIPTS: JSON.stringify([receipt]) } }).validated, false);
  }
  const environment = { LIVENESS_VALIDATION_RECEIPTS: JSON.stringify([{ fingerprint, dataset: "cohort-1", evaluation: "report-1" }]) };
  assert.equal(livenessValidation({ ...options, environment }).validated, true);
  assert.equal(livenessValidation({ ...options, environment: { LIVENESS_VALIDATION_RECEIPTS: "invalid" } }).validated, false);
});

test("source, models, effective thresholds, tenant settings and runtime policy invalidate validation", () => {
  const fingerprint = validationFingerprint(options);
  const environment = { LIVENESS_VALIDATION_RECEIPTS: JSON.stringify([{ fingerprint, dataset: "cohort-1", evaluation: "report-1" }]) };
  for (const change of [
    { release: { ...release, sourceDigest: "source-two" } },
    { release: { ...release, modelSet: "models-two" } },
    { thresholds: { liveness: { pass: 0.7 } } },
    { settings: { challenge: { enforcePose: false } } },
    { environment: { ...environment, CHALLENGE_SCORE_FLOOR: "0.1" } },
    { environment: { ...environment, PROVIDER_MODEL_VERSION: "model-two" } },
    { environment: { ...environment, FACEPLUGIN_MATCH_THRESHOLD: "0.7" } },
    { provider: "other" }
  ]) assert.equal(livenessValidation({ ...options, environment, ...change }).validated, false);
});

test("fingerprints are stable across object key order and exclude unrelated secrets", () => {
  const first = validationFingerprint({ ...options, settings: { first: 1, second: { left: 2, right: 3 } } });
  const second = validationFingerprint({ ...options, settings: { second: { right: 3, left: 2 }, first: 1 }, environment: { DATABASE_URL: "private", SDK_TOKEN_SECRET: "private" } });
  assert.equal(first, second);
});