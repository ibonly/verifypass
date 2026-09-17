"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { awsConfig, origin, runtimeSecret } = require("../config.cjs");
const env = {
  STACK_NAME: "verix", AWS_REGION: "us-east-1", AWS_PARAMETER_NAME: "/verix/production",
  AWS_PARAMETER_VERSION: "1", BUILD_COMMIT: "b".repeat(40), PROVIDER_MODEL_VERSION: "onnx-2026-07",
  API_PUBLIC_URL: "https://api.example.com", HOSTED_BASE_URL: "https://verify.example.com", DASHBOARD_URL: "https://app.example.com", EMAIL_API_URL: "https://mail.example.com",
  CORS_ORIGINS: "https://verify.example.com,https://app.example.com", SCHEMA_CHANGE_APPROVED: "true"
};
test("production configuration requires explicit matching origins and schema approval", () => {
  assert.equal(awsConfig(env).stack, "verix");
  assert.equal(awsConfig(env).parameterName, "/verix/production");
  assert.equal(awsConfig(env).parameterVersion, "1");
  assert.equal(awsConfig({ ...env, STACK_NAME: "verifypass", AWS_PARAMETER_NAME: "/verifypass/production" }).stack, "verifypass");
  assert.equal(awsConfig({ ...env, AWS_PARAMETER_NAME: "arn:aws:ssm:us-east-1:123456789012:parameter/verix/production" }).parameterName, "arn:aws:ssm:us-east-1:123456789012:parameter/verix/production");
  for (const changed of [{ CORS_ORIGINS: "https://other.example.com", HOSTED_BASE_URL: "https://verify.example.com" }, { STACK_NAME: 'stack";exit 0' }, { SCHEMA_CHANGE_APPROVED: "" }, { AWS_PARAMETER_NAME: "invalid-no-slash" }, { AWS_PARAMETER_VERSION: "0" }, { AWS_PARAMETER_VERSION: "latest" }]) assert.throws(() => awsConfig({ ...env, ...changed }));
});
test("fresh deployment works with minimal defaults and auto-detects URLs", () => {
  const minimal = awsConfig({
    AWS_PARAMETER_NAME: "/verix/production",
    AWS_PARAMETER_VERSION: "1"
  });
  assert.equal(minimal.stack, "verix");
  assert.equal(minimal.region, "us-east-1");
  assert.equal(minimal.API_PUBLIC_URL, null);
  assert.equal(minimal.HOSTED_BASE_URL, "https://verify.verix.invalid");
  assert.equal(minimal.cors.length, 2);
});
test("deployment URLs reject credentials, paths, HTTP and query data", () => {
  for (const value of ["http://api.example.com", "https://name:secret@api.example.com", "https://api.example.com/path", "https://api.example.com?q=x", "https://api.example.com\\x"]) assert.throws(() => origin(value));
});
test("runtime secrets require receipts and explicit bounded database pools", () => {
  const secret = { DATABASE_URL: "mongodb+srv://user:password@cluster.example.com/db?maxPoolSize=5", SDK_TOKEN_SECRET: "s".repeat(40), AUTH_TOKEN_SECRET: "a".repeat(40), EMAIL_API_KEY: "e".repeat(40), EVIDENCE_ENCRYPTION_KEY: "a".repeat(64), LIVENESS_VALIDATION_RECEIPTS: '[{"fingerprint":"example","dataset":"synthetic","evaluation":"test"}]' };
  assert.equal(runtimeSecret(secret).SDK_TOKEN_SECRET, secret.SDK_TOKEN_SECRET);
  assert.throws(() => runtimeSecret({ ...secret, LIVENESS_VALIDATION_RECEIPTS: "[]" }));
  assert.throws(() => runtimeSecret({ ...secret, DATABASE_URL: "mongodb://localhost/db" }));
  for (const query of ["maxPoolSize=0", "maxPoolSize=999", "maxPoolSize=5&tls=false", "maxPoolSize=5&tlsInsecure=true"]) assert.throws(() => runtimeSecret({ ...secret, DATABASE_URL: "mongodb+srv://cluster.example.com/db?" + query }));
});