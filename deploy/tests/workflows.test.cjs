"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");

test("backend deploy workflow accepts AWS role ARN from secret or variable", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/backend-deploy.yml"), "utf8");
  assert.match(workflow, /role-to-assume:\s*\$\{\{\s*secrets\.AWS_DEPLOY_ROLE_ARN\s*\|\|\s*vars\.AWS_DEPLOY_ROLE_ARN\s*\}\}/);
});

test("backend deploy validates the AWS runtime parameter before deployment", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/backend-deploy.yml"), "utf8");
  assert.match(workflow, /name:\s*Validate AWS runtime parameter/);
  assert.match(workflow, /run:\s*node deploy\/runtime-parameter\.cjs/);
  assert.ok(workflow.indexOf("Validate AWS runtime parameter") < workflow.indexOf("Validate, synchronize compatible schema, and deploy"));
});

test("production release builds cPanel artifact with prod environment API URL", () => {
  const release = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
  const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(release, /use_prod_environment:\s*true/);
  assert.doesNotMatch(release, /api_url:\s*\$\{\{\s*vars\.API_PUBLIC_URL\s*\}\}/);
  assert.match(ci, /frontend-prod:/);
  assert.match(ci, /environment:\s*prod/);
  assert.match(ci, /VITE_VP_API_BASE:\s*\$\{\{\s*vars\.API_PUBLIC_URL\s*\}\}/);
  assert.match(ci, /prod API_PUBLIC_URL is not visible to the CI artifact job/);
});

test("Lambda container handlers use dot-free entry modules", () => {
  const workerDockerfile = fs.readFileSync(path.join(root, "backend/Dockerfile.worker"), "utf8");
  const apiDockerfile = fs.readFileSync(path.join(root, "backend/Dockerfile.api"), "utf8");
  assert.match(workerDockerfile, /CMD \["worker-lambda-entry\.handler"\]/);
  assert.match(apiDockerfile, /CMD \["api-lambda-entry\.handler"\]/);
  assert.doesNotMatch(workerDockerfile, /CMD \["worker\.lambda\.handler"\]/);
  assert.doesNotMatch(apiDockerfile, /CMD \["api\.lambda\.handler"\]/);
});

test("frontend deploy binds prod environment and validates cPanel secrets", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/frontend-deploy.yml"), "utf8");
  assert.match(workflow, /environment:\s*prod/);
  assert.match(workflow, /name:\s*Validate cPanel environment secrets/);
  assert.match(workflow, /CPANEL_SSH_KEY is not visible to this job/);
  assert.match(workflow, /CPANEL_KNOWN_HOSTS is not visible to this job/);
  assert.ok(workflow.indexOf("Validate cPanel environment secrets") < workflow.indexOf("Stage, promote, smoke-test and roll back on failure"));
});
