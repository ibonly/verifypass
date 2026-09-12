"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { required, origin } = require("./config.cjs");

function packageRelease(root, env = process.env) {
  const commit = required(env, "GITHUB_SHA", /^[a-f0-9]{40}$/);
  const apiUrl = origin(required(env, "VITE_VP_API_BASE"));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "vp-artifact-"));
  try {
    for (const [name, source] of Object.entries({ dashboard: "frontend/dashboard/dist", verify: "frontend/verify-page/dist" })) {
      fs.cpSync(path.join(root, source), path.join(stage, name), { recursive: true });
      if (!fs.existsSync(path.join(stage, name, ".htaccess"))) throw new Error("Missing Apache routing configuration");
      fs.writeFileSync(path.join(stage, name, "release.json"), JSON.stringify({ commit, apiUrl }));
    }
    const mailer = path.join(stage, "mailer");
    fs.mkdirSync(mailer);
    for (const entry of ["src", "public", ".htaccess"]) fs.cpSync(path.join(root, "email-api", entry), path.join(mailer, entry), { recursive: true });
    fs.writeFileSync(path.join(mailer, "public/release.json"), JSON.stringify({ commit }));
    fs.mkdirSync(path.join(stage, "verify/sdk"));
    fs.copyFileSync(path.join(root, "frontend/sdk/js/dist/verifypass.js"), path.join(stage, "verify/sdk/verifypass.js"));
    fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify({ commit, apiUrl }));
    function validate(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || /^(?:\.env(?:\..*)?|config\.php|\.security-state|\.git)$/.test(entry.name)) throw new Error("Private configuration or symlink in release artifact");
        if (entry.isDirectory()) validate(path.join(directory, entry.name));
      }
    }
    validate(stage);
    execFileSync("tar", ["-czf", path.join(root, "release.tar.gz"), "-C", stage, "."]);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
module.exports = { packageRelease };
if (require.main === module) packageRelease(path.resolve(__dirname, ".."));