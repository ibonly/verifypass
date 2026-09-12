"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

test("production worker S3 cleanup does not require API-only secrets", () => {
  const script = `
    const { storage } = require('@verifypass/shared');
    let deleted = false;
    storage.__setTestClient({ send: async command => { deleted = command.input.Key === 'synthetic.enc'; } });
    require('./src/services/cleanupEvidence').cleanupEvidence({ storagePath: 's3://synthetic/synthetic.enc' })
      .then(() => { if (!deleted || require.cache[require.resolve('./src/config')]) process.exitCode = 1; })
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: path.resolve(__dirname, ".."), env: { PATH: process.env.PATH, NODE_ENV: "production" }, encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
});