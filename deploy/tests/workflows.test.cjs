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
