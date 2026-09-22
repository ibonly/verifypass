"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const script = path.resolve(__dirname, "../cpanel-remote.sh");

test("cPanel release switching is atomic and rollback is ownership-aware", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vp-cpanel-test-"));
  const env = { ...process.env, HOME: home };
  const first = "a".repeat(40) + "-1-1";
  const second = "b".repeat(40) + "-2-1";
  const run = (action, release) => execFileSync("bash", [script, action, "verifypass", release], { env });
  try {
    for (const release of [first, second]) {
      run("prepare", release);
      const target = path.join(home, "verifypass/releases", release);
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, "manifest.json"), JSON.stringify({ release }));
      run("promote", release);
      const current = path.join(home, "verifypass/current");
      assert.equal(fs.lstatSync(current).isDirectory(), true);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(current, "manifest.json"), "utf8")), { release });
    }
    assert.notEqual(spawnSync("bash", [script, "rollback", "verifypass", first], { env }).status, 0);
    run("rollback", second);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "verifypass/current/manifest.json"), "utf8")), { release: first });
    assert.ok(fs.existsSync(path.join(home, "verifypass/releases", second)), "Keep failed release available for diagnosis");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("cPanel rejects path traversal and shell metacharacters before writing files", () => {
  for (const folder of ["../public_html", "site;touch bad", "/tmp/site"]) {
    const result = spawnSync("bash", [script, "prepare", folder, "a".repeat(40) + "-1-1"]);
    assert.equal(result.status, 2);
  }
});
