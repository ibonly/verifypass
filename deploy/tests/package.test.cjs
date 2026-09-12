"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { packageRelease } = require("../package.cjs");

test("release artifact includes routing and mailer code but never private config or demo", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vp-package-test-"));
  const fixture = name => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "fixture"); };
  try {
    for (const name of ["frontend/dashboard/dist/index.html", "frontend/dashboard/dist/.htaccess", "frontend/verify-page/dist/index.html", "frontend/verify-page/dist/.htaccess", "frontend/sdk/js/dist/verifypass.js", "email-api/src/bootstrap.php", "email-api/public/send.php", "email-api/.htaccess", "email-api/config.php", "sample-app/dist/index.html"]) fixture(name);
    const env = { GITHUB_SHA: "a".repeat(40), VITE_VP_API_BASE: "https://api.example.com" };
    packageRelease(root, env);
    const archive = path.join(root, "release.tar.gz");
    const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
    assert.match(entries, /verify\/\.htaccess/);
    assert.match(entries, /mailer\/public\/send.php/);
    assert.doesNotMatch(entries, /config.php|sample-app|\.env/);
    const manifest = JSON.parse(execFileSync("tar", ["-xOf", archive, "./manifest.json"], { encoding: "utf8" }));
    assert.deepEqual(manifest, { commit: env.GITHUB_SHA, apiUrl: env.VITE_VP_API_BASE });
    fixture("frontend/dashboard/dist/.env");
    assert.throws(() => packageRelease(root, env), /Private configuration/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});