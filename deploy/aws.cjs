"use strict";
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { awsConfig, runtimeSecret } = require("./config.cjs");

async function main() {
  const config = awsConfig();
  const secretResponse = JSON.parse(execFileSync("aws", ["secretsmanager", "get-secret-value", "--secret-id", config.secretArn, "--version-id", config.secretVersion, "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const raw = JSON.parse(secretResponse.SecretString);
  for (const value of Object.values(raw)) {
    if (typeof value === "string" && process.env.GITHUB_ACTIONS) console.log(`::add-mask::${value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`);
  }
  const secrets = runtimeSecret(raw);
  const runtimeBytes = Buffer.byteLength(JSON.stringify({ ...secrets, ...Object.fromEntries(["API_PUBLIC_URL", "HOSTED_BASE_URL", "DASHBOARD_URL", "EMAIL_API_URL"].map(name => [name, config[name]])), CORS_ORIGINS: config.cors.join(","), PROVIDER_MODEL_VERSION: config.modelVersion, BUILD_COMMIT: config.commit }));
  if (runtimeBytes > 3500) throw new Error("Lambda runtime configuration exceeds its reserved environment budget");
  const env = { ...process.env, ...secrets, NODE_ENV: "production", VP_PROVIDER: "onnx", PROVIDER_MODEL_VERSION: config.modelVersion };
  const backend = path.resolve(__dirname, "../backend");
  const run = (command, args, options = {}) => execFileSync(command, args, { stdio: "inherit", ...options });
  run("sam", ["validate", "--lint", "-t", "backend/template.yaml"]);
  run(path.join(backend, "node_modules/.bin/prisma"), ["db", "push", "--schema", "prisma/schema.prisma", "--skip-generate"], { cwd: backend, env });
  run(process.execPath, ["scripts/check-liveness-release.js"], { cwd: backend, env });
  run("sam", ["build", "--no-use-container", "-t", "backend/template.yaml"]);
  const parameters = {
    RuntimeSecretArn: config.secretArn, RuntimeSecretVersion: config.secretVersion,
    BuildCommit: config.commit, CorsOrigins: config.cors.join(","),
    ApiPublicUrl: config.API_PUBLIC_URL, HostedBaseUrl: config.HOSTED_BASE_URL,
    DashboardUrl: config.DASHBOARD_URL, EmailApiUrl: config.EMAIL_API_URL,
    ProviderModelVersion: config.modelVersion, ApiReservedConcurrency: "10"
  };
  run("sam", ["deploy", "--stack-name", config.stack, "--resolve-s3", "--resolve-image-repos", "--no-confirm-changeset", "--no-fail-on-empty-changeset", "--capabilities", "CAPABILITY_IAM", "--parameter-overrides", ...Object.entries(parameters).map(([name, value]) => `${name}=${value}`)]);
  const stack = JSON.parse(execFileSync("aws", ["cloudformation", "describe-stacks", "--stack-name", config.stack, "--output", "json"], { encoding: "utf8" })).Stacks[0];
  const outputs = Object.fromEntries(stack.Outputs.map(output => [output.OutputKey, output.OutputValue]));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vp-smoke-"));
  try {
    const file = path.join(directory, "worker.json");
    const invocation = JSON.parse(execFileSync("aws", ["lambda", "invoke", "--function-name", outputs.WorkerFunctionArn, "--cli-binary-format", "raw-in-base64-out", "--payload", '{"type":"health"}', file], { encoding: "utf8" }));
    const worker = JSON.parse(fs.readFileSync(file));
    if (invocation.FunctionError || worker.release?.commit !== config.commit || !worker.ok) throw new Error("Deployed worker readiness or release identity failed");
    const response = await fetch(config.API_PUBLIC_URL + "/health", { redirect: "error", signal: AbortSignal.timeout(20000) });
    const health = await response.json();
    if (!response.ok || health.release?.commit !== config.commit) throw new Error("Public API is not serving the expected release");
    for (const corsOrigin of config.cors) {
      const preflight = await fetch(config.API_PUBLIC_URL + "/v1/verification-sessions", { method: "OPTIONS", headers: { Origin: corsOrigin, "Access-Control-Request-Method": "POST" }, redirect: "error", signal: AbortSignal.timeout(15000) });
      if (!preflight.ok || preflight.headers.get("access-control-allow-origin") !== corsOrigin) throw new Error("Production CORS smoke check failed");
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  console.log("AWS release, database, worker and CORS smoke checks passed");
}

main().catch(() => { console.error("AWS release failed. Review the failed step; cPanel promotion is blocked. No secret values are logged here."); process.exitCode = 1; });