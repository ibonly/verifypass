"use strict";
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { awsConfig, origin } = require("./config.cjs");
const { parameterTarget, validateRuntimeParameter } = require("./runtime-parameter.cjs");

async function main() {
  const config = awsConfig();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const step = (name, fn) => {
    console.log(`\n==> ${name}`);
    try {
      const result = fn();
      if (result && typeof result.then === "function") {
        return result.catch(error => {
          error.deployStep = name;
          throw error;
        });
      }
      return result;
    } catch (error) {
      error.deployStep = name;
      throw error;
    }
  };
  const { secrets } = step(`Validate runtime parameter ${parameterTarget(config)}`, () => validateRuntimeParameter());
  const env = { ...process.env, ...secrets, NODE_ENV: "production", VP_PROVIDER: "onnx", PROVIDER_MODEL_VERSION: config.modelVersion };
  const backend = path.resolve(__dirname, "../backend");
  const run = (command, args, options = {}) => execFileSync(command, args, { stdio: "inherit", ...options });
  const awsJson = (args, options = {}) => JSON.parse(execFileSync("aws", [...args, "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }));
  const smokeError = (message, details) => {
    const error = new Error(message);
    error.details = details;
    throw error;
  };
  const stackEvents = () => {
    try {
      return awsJson(["cloudformation", "describe-stack-events", "--stack-name", config.stack]).StackEvents || [];
    } catch {
      return [];
    }
  };
  const printRecentStackEvents = (seen = new Set(), { limit = 8 } = {}) => {
    for (const event of stackEvents().slice(0, limit).reverse()) {
      const id = event.EventId || `${event.LogicalResourceId}:${event.Timestamp}`;
      if (seen.has(id)) continue;
      seen.add(id);
      console.log(`[CloudFormation] ${event.Timestamp} ${event.LogicalResourceId} ${event.ResourceStatus}${event.ResourceStatusReason ? ` - ${event.ResourceStatusReason}` : ""}`);
    }
    return seen;
  };
  const waitForStack = async () => {
    const complete = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE"]);
    const failed = /(?:FAILED|ROLLBACK|DELETE_COMPLETE)$/;
    const seen = printRecentStackEvents(new Set());
    const deadline = Date.now() + 35 * 60 * 1000;
    while (Date.now() < deadline) {
      const stack = awsJson(["cloudformation", "describe-stacks", "--stack-name", config.stack]).Stacks[0];
      printRecentStackEvents(seen, { limit: 12 });
      if (complete.has(stack.StackStatus)) return stack;
      if (failed.test(stack.StackStatus)) throw new Error(`CloudFormation stack ${config.stack} ended in ${stack.StackStatus}${stack.StackStatusReason ? `: ${stack.StackStatusReason}` : ""}`);
      console.log(`Waiting for CloudFormation stack ${config.stack}: ${stack.StackStatus}`);
      await sleep(30000);
    }
    throw new Error(`Timed out waiting for CloudFormation stack ${config.stack} to complete`);
  };
  const recoverSamChangeSet = async () => {
    console.log("SAM change-set waiter timed out; inspecting CloudFormation directly");
    const list = awsJson(["cloudformation", "list-change-sets", "--stack-name", config.stack]).Summaries || [];
    const latest = list.sort((a, b) => new Date(b.CreationTime) - new Date(a.CreationTime))[0];
    if (!latest) throw new Error(`SAM deploy failed and no CloudFormation change set was found for stack ${config.stack}`);
    console.log(`Newest change set: ${latest.ChangeSetName} (${latest.Status}/${latest.ExecutionStatus})`);
    const deadline = Date.now() + 25 * 60 * 1000;
    let changeSet = null;
    while (Date.now() < deadline) {
      changeSet = awsJson(["cloudformation", "describe-change-set", "--stack-name", config.stack, "--change-set-name", latest.ChangeSetName]);
      if (changeSet.Status === "CREATE_COMPLETE") break;
      if (changeSet.Status === "FAILED") {
        if (/didn't contain changes|No updates are to be performed/i.test(changeSet.StatusReason || "")) {
          console.log(`Change set contains no changes: ${changeSet.StatusReason}`);
          return;
        }
        throw new Error(`Change set ${latest.ChangeSetName} failed: ${changeSet.StatusReason || "unknown reason"}`);
      }
      console.log(`Waiting for change set ${latest.ChangeSetName}: ${changeSet.Status}${changeSet.StatusReason ? ` - ${changeSet.StatusReason}` : ""}`);
      await sleep(30000);
    }
    if (!changeSet || changeSet.Status !== "CREATE_COMPLETE") throw new Error(`Timed out waiting for change set ${latest.ChangeSetName} to finish creating`);
    if (changeSet.ExecutionStatus !== "AVAILABLE") throw new Error(`Change set ${latest.ChangeSetName} is ${changeSet.ExecutionStatus}, not executable`);
    console.log(`Executing recovered change set ${latest.ChangeSetName}`);
    execFileSync("aws", ["cloudformation", "execute-change-set", "--stack-name", config.stack, "--change-set-name", latest.ChangeSetName], { stdio: "inherit" });
    await waitForStack();
  };
  step("Validate SAM template", () => run("sam", ["validate", "--lint", "-t", "backend/template.yaml"]));
  step("Synchronize MongoDB schema", () => run(path.join(backend, "node_modules/.bin/prisma"), ["db", "push", "--schema", "prisma/schema.prisma", "--skip-generate"], { cwd: backend, env }));
  step("Check liveness release receipts", () => run(process.execPath, ["scripts/check-liveness-release.js"], { cwd: backend, env }));
  step("Build SAM application", () => run("sam", ["build", "--no-use-container", "-t", "backend/template.yaml"]));
  let apiPublicUrl = config.API_PUBLIC_URL;
  if (!apiPublicUrl) {
    try {
      const existing = JSON.parse(step("Detect existing API URL from CloudFormation", () => execFileSync("aws", ["cloudformation", "describe-stacks", "--stack-name", config.stack, "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))).Stacks[0];
      const existingOutputs = Object.fromEntries((existing.Outputs || []).map(o => [o.OutputKey, o.OutputValue]));
      if (existingOutputs.ApiUrl) apiPublicUrl = origin(existingOutputs.ApiUrl, "ApiUrl");
    } catch {
      apiPublicUrl = `https://${config.stack}.lambda-url.${config.region}.on.aws`;
    }
  }
  const parameters = {
    DatabaseUrl: secrets.DATABASE_URL,
    SdkTokenSecret: secrets.SDK_TOKEN_SECRET,
    AuthTokenSecret: secrets.AUTH_TOKEN_SECRET,
    EvidenceEncryptionKey: secrets.EVIDENCE_ENCRYPTION_KEY,
    LivenessValidationReceipts: secrets.LIVENESS_VALIDATION_RECEIPTS,
    EmailApiKey: secrets.EMAIL_API_KEY,
    BuildCommit: config.commit,
    CorsOrigins: config.cors.join(","),
    ApiPublicUrl: apiPublicUrl,
    HostedBaseUrl: config.HOSTED_BASE_URL,
    DashboardUrl: config.DASHBOARD_URL,
    EmailApiUrl: config.EMAIL_API_URL,
    ProviderModelVersion: config.modelVersion,
    ApiReservedConcurrency: config.apiReservedConcurrency
  };
  await step("Deploy SAM stack", async () => {
    try {
      run("sam", [
        "deploy",
        "--stack-name", config.stack,
        "--resolve-s3",
        "--resolve-image-repos",
        "--no-confirm-changeset",
        "--no-fail-on-empty-changeset",
        "--capabilities", "CAPABILITY_IAM",
        "--parameter-overrides",
        ...Object.entries(parameters).map(([name, value]) => `${name}="${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
      ]);
    } catch {
      await recoverSamChangeSet();
    }
  });
  const stack = JSON.parse(step("Read deployed stack outputs", () => execFileSync("aws", ["cloudformation", "describe-stacks", "--stack-name", config.stack, "--output", "json"], { encoding: "utf8" }))).Stacks[0];
  const outputs = Object.fromEntries((stack.Outputs || []).map(output => [output.OutputKey, output.OutputValue]));
  console.log(`\n============================================================`);
  console.log(`🚀 Verix Lambda Function URL: ${outputs.ApiUrl}`);
  if (config.API_PUBLIC_URL) console.log(`🌐 Configured Public API Origin: ${config.API_PUBLIC_URL}`);
  console.log(`============================================================\n`);
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::notice title=Verix API URL::Deployed Lambda Function URL: ${outputs.ApiUrl}`);
  }
  await step("Run AWS smoke checks", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "verix-smoke-"));
    try {
      const file = path.join(directory, "worker.json");
      const invocation = JSON.parse(step("Smoke check worker release identity", () => execFileSync("aws", ["lambda", "invoke", "--function-name", outputs.WorkerFunctionArn, "--cli-binary-format", "raw-in-base64-out", "--payload", '{"type":"health"}', "--log-type", "Tail", file], { encoding: "utf8" })));
      let worker;
      try {
        worker = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (error) {
        smokeError("Worker health response was not valid JSON", { parseError: error.message });
      }
      if (invocation.FunctionError || worker.release?.commit !== config.commit || !worker.ok) {
        smokeError("Deployed worker readiness or release identity failed", {
          functionError: invocation.FunctionError || null,
          statusCode: invocation.StatusCode,
          workerOk: worker.ok === true,
          expectedCommit: config.commit,
          actualCommit: worker.release?.commit || null,
          errorType: worker.errorType || null,
          errorMessage: worker.errorMessage || null,
          logTail: invocation.LogResult ? Buffer.from(invocation.LogResult, "base64").toString("utf8").slice(-4000) : null
        });
      }
      const testUrl = origin(outputs.ApiUrl, "ApiUrl");
      const response = await step("Smoke check public API health", () => fetch(testUrl + "/health", { redirect: "error", signal: AbortSignal.timeout(20000) }));
      const health = await response.json();
      if (!response.ok || health.release?.commit !== config.commit) throw new Error("Public API is not serving the expected release");
      const activeCors = config.cors.filter(c => !c.endsWith(".invalid"));
      for (const corsOrigin of activeCors) {
        const preflight = await step(`Smoke check CORS preflight for ${corsOrigin}`, () => fetch(testUrl + "/v1/verification-sessions", { method: "OPTIONS", headers: { Origin: corsOrigin, "Access-Control-Request-Method": "POST" }, redirect: "error", signal: AbortSignal.timeout(15000) }));
        if (!preflight.ok || preflight.headers.get("access-control-allow-origin") !== corsOrigin) throw new Error("Production CORS smoke check failed");
      }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  console.log("AWS release, database, worker and CORS smoke checks passed");
}

main().catch(error => {
  if (error.deployStep) console.error(`AWS release failed during: ${error.deployStep}`);
  if (error.message) console.error(error.message);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  console.error("AWS release failed. Review the failed step; cPanel promotion is blocked. No secret values are logged here.");
  process.exitCode = 1;
});
