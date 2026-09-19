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
