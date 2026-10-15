#!/usr/bin/env node
// Installs the VerifyPass browser SDK the way an external integrator would: by
// downloading it from the public GitHub repository, never by reaching into the
// monorepo's working tree.
//
// The SDK is not published to npm and npm cannot install a sub-folder of a git
// repository, so this script vendors the two packages (and the browser face
// models) into ./vendor and ./public/models. package.json then depends on them
// via `file:` specifiers, and `.npmrc` (install-links=true) makes npm copy them
// into node_modules like any registry package.
//
// Usage:
//   node scripts/fetch-sdk.mjs                # latest commit on "main"
//   VERIFYPASS_SDK_REF=v0.2.0 node scripts/fetch-sdk.mjs
//   VERIFYPASS_SDK_REF=<commit-sha> node scripts/fetch-sdk.mjs
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = process.env.VERIFYPASS_SDK_REPO || "ibonly/verifypass";
const REF = process.env.VERIFYPASS_SDK_REF || "main";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = path.join(root, "vendor", "verifypass");

// The browser SDK is self-contained (bundled runtime, hosted models/WASM),
// so one package and no model files are needed.
const PACKAGES = [
  { from: "frontend/sdk/js", to: path.join(vendorDir, "js"), entries: ["package.json", "dist", "types", "index.d.ts", "element.d.ts"] }
];

if (!/^[\w.-]+\/[\w.-]+$/.test(REPO)) throw new Error(`Invalid VERIFYPASS_SDK_REPO: ${REPO}`);
if (!/^[\w./-]+$/.test(REF)) throw new Error(`Invalid VERIFYPASS_SDK_REF: ${REF}`);

async function resolveCommit() {
  if (/^[0-9a-f]{40}$/i.test(REF)) return REF.toLowerCase();
  const res = await fetch(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(REF)}`, {
    headers: { Accept: "application/vnd.github.sha", "User-Agent": "verifypass-vue-sample" }
  });
  if (!res.ok) throw new Error(`Could not resolve ${REPO}@${REF}: HTTP ${res.status}`);
  const sha = (await res.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Unexpected commit id for ${REPO}@${REF}`);
  return sha;
}

async function main() {
  const sha = await resolveCommit();
  console.log(`Fetching VerifyPass SDK from github.com/${REPO} @ ${REF} (${sha.slice(0, 12)})`);

  const res = await fetch(`https://codeload.github.com/${REPO}/tar.gz/${sha}`);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);

  const work = await mkdtemp(path.join(tmpdir(), "verifypass-sdk-"));
  try {
    const archive = path.join(work, "sdk.tar.gz");
    await writeFile(archive, Buffer.from(await res.arrayBuffer()));

    // GitHub archives are rooted at "<repo>-<sha>/"; extract only what we need.
    const prefix = `${REPO.split("/")[1]}-${sha}`;
    const members = PACKAGES.map((p) => `${prefix}/${p.from}`);
    execFileSync("tar", ["-xzf", archive, "-C", work, ...members], { stdio: "inherit" });
    const src = path.join(work, prefix);

    await rm(vendorDir, { recursive: true, force: true });
    for (const pkg of PACKAGES) {
      await mkdir(pkg.to, { recursive: true });
      for (const entry of pkg.entries) {
        // Some entries are absent in refs older than the self-contained SDK.
        await cp(path.join(src, pkg.from, entry), path.join(pkg.to, entry), { recursive: true })
          .catch((err) => { if (err.code !== "ENOENT") throw err; });
      }
    }

    const pkg = JSON.parse(await readFile(path.join(vendorDir, "js", "package.json"), "utf8"));
    await writeFile(path.join(vendorDir, "SOURCE.json"), JSON.stringify({
      repository: `https://github.com/${REPO}`,
      ref: REF,
      commit: sha,
      packages: { "@verifypass/sdk-js": pkg.version },
      fetchedAt: new Date().toISOString()
    }, null, 2) + "\n");

    console.log(`Vendored @verifypass/sdk-js ${pkg.version} into vendor/verifypass`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`fetch-sdk: ${err.message}`);
  process.exit(1);
});
