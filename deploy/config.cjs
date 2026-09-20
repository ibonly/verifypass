"use strict";

function stripQuotes(value) {
  if (typeof value !== "string") return value;
  let trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function required(env, name, pattern) {
  let value = env[name];
  if (typeof value === "string") value = stripQuotes(value);
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) throw new Error(`Invalid or missing ${name}`);
  return value;
}

function origin(value, name = "URL") {
  const cleaned = stripQuotes(value);
  let parsed;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL (received: ${JSON.stringify(value)})`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || !["", "/"].includes(parsed.pathname) || /[\s\\]/.test(cleaned)) {
    throw new Error(`${name} must be an HTTPS origin without credentials or a path`);
  }
  return parsed.origin;
}

function optionalOrigin(value, fallback = null, name = "URL") {
  if (!value || typeof value !== "string") return fallback;
  const cleaned = stripQuotes(value);
  if (!cleaned || cleaned === "null" || cleaned === "undefined") return fallback;
  return origin(cleaned, name);
}

function awsConfig(env = process.env) {
  const stack = env.STACK_NAME || env.AWS_STACK_NAME || "verix";
  const region = env.AWS_REGION || "us-east-1";
  const parameterName = env.AWS_PARAMETER_NAME || env.RUNTIME_PARAMETER_NAME || "/verix/production";
  const parameterVersion = env.AWS_PARAMETER_VERSION || env.RUNTIME_PARAMETER_VERSION || null;
  const commit = env.BUILD_COMMIT || env.GITHUB_SHA || "0000000000000000000000000000000000000000";
  const modelVersion = env.PROVIDER_MODEL_VERSION || "onnx-2026-07";
  const apiReservedConcurrency = env.API_RESERVED_CONCURRENCY || "0";

  const config = {
    stack: required({ STACK_NAME: stack }, "STACK_NAME", /^[A-Za-z][A-Za-z0-9-]{0,127}$/),
    region: required({ AWS_REGION: region }, "AWS_REGION", /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/),
    parameterName: required({ AWS_PARAMETER_NAME: parameterName }, "AWS_PARAMETER_NAME", /^(?:\/[A-Za-z0-9_.-]+)+$|^arn:aws[a-z-]*:ssm:[a-z0-9-]+:\d{12}:parameter\/[A-Za-z0-9/_.-]+$/),
    parameterVersion: parameterVersion ? required({ AWS_PARAMETER_VERSION: parameterVersion }, "AWS_PARAMETER_VERSION", /^[1-9][0-9]*$/) : null,
    commit: required({ BUILD_COMMIT: commit }, "BUILD_COMMIT", /^[a-f0-9]{40}$/),
    modelVersion: required({ PROVIDER_MODEL_VERSION: modelVersion }, "PROVIDER_MODEL_VERSION", /^[A-Za-z0-9._-]{1,100}$/),
    apiReservedConcurrency: required({ API_RESERVED_CONCURRENCY: apiReservedConcurrency }, "API_RESERVED_CONCURRENCY", /^(?:0|[1-9][0-9]*)$/)
  };

  config.API_PUBLIC_URL = optionalOrigin(env.API_PUBLIC_URL, null, "API_PUBLIC_URL");
  config.HOSTED_BASE_URL = optionalOrigin(env.HOSTED_BASE_URL, `https://verify.${config.stack}.invalid`, "HOSTED_BASE_URL");
  config.DASHBOARD_URL = optionalOrigin(env.DASHBOARD_URL, `https://app.${config.stack}.invalid`, "DASHBOARD_URL");
  config.EMAIL_API_URL = optionalOrigin(env.EMAIL_API_URL, `https://mail.${config.stack}.invalid`, "EMAIL_API_URL");

  if (env.CORS_ORIGINS && typeof env.CORS_ORIGINS === "string" && env.CORS_ORIGINS.trim()) {
    const cleanedCors = stripQuotes(env.CORS_ORIGINS);
    if (cleanedCors) {
      config.cors = cleanedCors.split(",").map(value => value.trim()).filter(Boolean).map(value => origin(value, "CORS_ORIGINS"));
      if (config.HOSTED_BASE_URL && !config.cors.includes(config.HOSTED_BASE_URL)) {
        throw new Error("CORS_ORIGINS must include HOSTED_BASE_URL");
      }
      if (config.DASHBOARD_URL && !config.cors.includes(config.DASHBOARD_URL)) {
        throw new Error("CORS_ORIGINS must include DASHBOARD_URL");
      }
    } else {
      config.cors = [config.HOSTED_BASE_URL, config.DASHBOARD_URL];
    }
  } else {
    config.cors = [config.HOSTED_BASE_URL, config.DASHBOARD_URL];
  }

  const schemaApproved = env.SCHEMA_CHANGE_APPROVED !== undefined ? stripQuotes(String(env.SCHEMA_CHANGE_APPROVED)) : "true";
  if (schemaApproved !== "true") throw new Error("Approve a backward-compatible schema rollout with SCHEMA_CHANGE_APPROVED=true");

  return config;
}

function runtimeSecret(value) {
  const keys = ["DATABASE_URL", "SDK_TOKEN_SECRET", "AUTH_TOKEN_SECRET", "EVIDENCE_ENCRYPTION_KEY", "EMAIL_API_KEY", "LIVENESS_VALIDATION_RECEIPTS"];
  const secret = Object.fromEntries(keys.map(name => [name, required(value, name)]));
  for (const name of ["SDK_TOKEN_SECRET", "AUTH_TOKEN_SECRET", "EMAIL_API_KEY"]) {
    if (secret[name].length < 32 || /^(dev-only-|change-me-)/.test(secret[name])) throw new Error(`Invalid ${name}`);
  }
  if (!/^[a-f0-9]{64}$/i.test(secret.EVIDENCE_ENCRYPTION_KEY)) throw new Error("Invalid EVIDENCE_ENCRYPTION_KEY");
  const database = new URL(secret.DATABASE_URL);
  const pool = Number(database.searchParams.get("maxPoolSize"));
  if (!["mongodb:", "mongodb+srv:"].includes(database.protocol) || !Number.isInteger(pool) || pool < 1 || pool > 10) throw new Error("DATABASE_URL must set maxPoolSize between 1 and 10");
  if ((database.protocol === "mongodb:" && database.searchParams.get("tls") !== "true") || ["tls", "ssl"].some(name => database.searchParams.get(name) === "false") || ["tlsAllowInvalidCertificates", "tlsAllowInvalidHostnames", "tlsInsecure"].some(name => database.searchParams.get(name) === "true")) throw new Error("Production MongoDB requires verified TLS");
  const receipts = JSON.parse(secret.LIVENESS_VALIDATION_RECEIPTS);
  if (!Array.isArray(receipts) || !receipts.length) throw new Error("Matching liveness validation receipts are required");
  if (Buffer.byteLength(JSON.stringify(secret)) > 2700) throw new Error("Runtime secret values exceed the reserved Lambda environment budget; reduce receipts or externalize receipt storage before release");
  return secret;
}

module.exports = { required, origin, awsConfig, runtimeSecret };
if (require.main === module) {
  try { awsConfig(); console.log("Production deployment configuration validated"); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
