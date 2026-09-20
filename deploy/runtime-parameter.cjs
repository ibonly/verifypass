"use strict";
const { execFileSync } = require("node:child_process");
const { awsConfig, runtimeSecret } = require("./config.cjs");

function parameterTarget(config) {
  return config.parameterVersion ? `${config.parameterName}:${config.parameterVersion}` : config.parameterName;
}

function maskRuntimeValues(raw) {
  if (!process.env.GITHUB_ACTIONS || !raw || typeof raw !== "object") return;
  for (const value of Object.values(raw)) {
    if (typeof value === "string") {
      console.log(`::add-mask::${value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`);
    }
  }
}

function loadRuntimeParameter(config = awsConfig()) {
  const response = JSON.parse(execFileSync("aws", ["ssm", "get-parameter", "--name", parameterTarget(config), "--with-decryption", "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const raw = JSON.parse(response.Parameter.Value);
  maskRuntimeValues(raw);
  return raw;
}

function validateRuntimeParameter(env = process.env) {
  const config = awsConfig(env);
  const raw = loadRuntimeParameter(config);
  const secrets = runtimeSecret(raw);
  const runtimeBytes = Buffer.byteLength(JSON.stringify({ ...secrets, ...Object.fromEntries(["API_PUBLIC_URL", "HOSTED_BASE_URL", "DASHBOARD_URL", "EMAIL_API_URL"].map(name => [name, config[name]])), CORS_ORIGINS: config.cors.join(","), PROVIDER_MODEL_VERSION: config.modelVersion, BUILD_COMMIT: config.commit }));
  if (runtimeBytes > 3500) throw new Error("Lambda runtime configuration exceeds its reserved environment budget");
  console.log(`Runtime parameter ${parameterTarget(config)} passed shape and Lambda environment budget checks`);
  return { config, secrets, raw };
}

module.exports = { loadRuntimeParameter, maskRuntimeValues, parameterTarget, validateRuntimeParameter };

if (require.main === module) {
  try {
    validateRuntimeParameter();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
