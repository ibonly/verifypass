"use strict";

// Audit-log immutability is enforced at the APPLICATION layer on MongoDB
// (no SQL append-only grants exist): no code path may ever update or delete
// audit rows. This static gate fails the build if one appears.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

test("no code path mutates or deletes audit logs", () => {
  const roots = [path.join(__dirname, "../src"), path.join(__dirname, "../shared/src")];
  const offenders = [];
  for (const root of roots) {
    for (const f of walk(root)) {
      const src = fs.readFileSync(f, "utf8");
      if (/auditLog\s*\.\s*(update|updateMany|delete|deleteMany|upsert)\s*\(/.test(src)) {
        offenders.push(path.relative(process.cwd(), f));
      }
    }
  }
  assert.deepEqual(offenders, [], `audit rows must be append-only; found mutations in: ${offenders.join(", ")}`);
});
