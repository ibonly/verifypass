"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { required, origin } = require("./config.cjs");

async function main() {
  const env = process.env;
  const commit = required(env, "GITHUB_SHA", /^[a-f0-9]{40}$/);
  const release = `${commit}-${required(env, "GITHUB_RUN_ID", /^\d+$/)}-${required(env, "GITHUB_RUN_ATTEMPT", /^\d+$/)}`;
  const host = required(env, "CPANEL_SSH_HOST", /^[A-Za-z0-9][A-Za-z0-9.-]*$/);
  const user = required(env, "CPANEL_SSH_USER", /^[A-Za-z0-9_][A-Za-z0-9_-]*$/);
  const port = required(env, "CPANEL_SSH_PORT", /^\d{1,5}$/);
  if (Number(port) < 1 || Number(port) > 65535) throw new Error("Invalid SSH port");
  const folder = required(env, "CPANEL_RELEASE_ROOT", /^[A-Za-z0-9_-]+$/);
  const apiUrl = origin(required(env, "API_PUBLIC_URL"));
  const dashboard = origin(required(env, "DASHBOARD_URL"));
  const verify = origin(required(env, "HOSTED_BASE_URL"));
  const mailer = origin(required(env, "EMAIL_API_URL"));
  const archive = path.resolve(__dirname, "../artifact/release.tar.gz");
  const manifest = JSON.parse(execFileSync("tar", ["-xOf", archive, "./manifest.json"], { encoding: "utf8" }));
  if (manifest.commit !== commit || manifest.apiUrl !== apiUrl) throw new Error("Artifact commit or API URL does not match production configuration");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vp-ssh-"));
  let promoted = false;
  try {
    const key = path.join(directory, "key");
    const hosts = path.join(directory, "known_hosts");
    fs.writeFileSync(key, required(env, "CPANEL_SSH_KEY") + "\n", { mode: 0o600 });
    fs.writeFileSync(hosts, required(env, "CPANEL_KNOWN_HOSTS") + "\n", { mode: 0o600 });
    const common = ["-i", key, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${hosts}`, "-o", "ConnectTimeout=20"];
    const publicKey = execFileSync("ssh-keygen", ["-y", "-f", key], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const fingerprint = execFileSync("ssh-keygen", ["-lf", "-"], { input: publicKey, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    console.log(`Using cPanel deploy key fingerprint: ${fingerprint}`);
    try {
      execFileSync("ssh", [...common, "-p", port, `${user}@${host}`, "true"], { stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
    } catch (error) {
      throw new Error([
        `Unable to authenticate to cPanel over SSH as ${user}@${host}:${port}.`,
        `Deploy key fingerprint offered by CI: ${fingerprint}`,
        "Verify that this exact public key is installed in the cPanel account's ~/.ssh/authorized_keys, SSH access is enabled for the account, the username and port are correct, and the private key in CPANEL_SSH_KEY is the matching unencrypted key."
      ].join("\n"));
    }
    const remoteScript = fs.readFileSync(path.join(__dirname, "cpanel-remote.sh"));
    const remote = action => execFileSync("ssh", [...common, "-p", port, `${user}@${host}`, "bash", "-s", "--", action, folder, release], { input: remoteScript, stdio: ["pipe", "inherit", "inherit"], timeout: 180000 });
    remote("prepare");
    execFileSync("scp", [...common, "-P", port, archive, `${user}@${host}:${folder}/incoming/${release}.tar.gz`], { stdio: "inherit", timeout: 300000 });
    remote("stage");
    try {
      remote("promote");
      promoted = true;
      for (const base of [dashboard, verify, mailer]) {
        const url = `${base}/release.json?release=${release}`;
        const response = await fetch(url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`cPanel release identity failed for ${url}: HTTP ${response.status}`);
        const receipt = await response.json();
        if (receipt.commit !== commit) {
          throw new Error(`cPanel release identity failed for ${url}: expected ${commit}, got ${receipt.commit ?? "missing commit"}`);
        }
      }
      const health = await fetch(`${mailer}/health.php`, { redirect: "error", signal: AbortSignal.timeout(15000) });
      if (!health.ok) throw new Error("cPanel mailer health failed");
      const { chromium } = require("../frontend/verify-page/node_modules/@playwright/test");
      const browser = await chromium.launch();
      try {
        for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
          const page = await browser.newPage({ viewport });
          const errors = [];
          page.on("pageerror", error => errors.push(error.message));
          await page.goto(`${verify}/session/vps_release`, { waitUntil: "networkidle", timeout: 30000 });
          await page.getByRole("heading", { name: "Invalid verification link" }).waitFor();
          await page.goto(dashboard, { waitUntil: "networkidle", timeout: 30000 });
          if (!(await page.locator("#root").innerText()).trim() || errors.length) throw new Error("Production browser smoke failed");
          await page.close();
        }
      } finally { await browser.close(); }
    } catch (error) {
      if (promoted) remote("rollback");
      throw error;
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  console.log("cPanel release promoted; browser, release identity and mailer smoke checks passed");
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
