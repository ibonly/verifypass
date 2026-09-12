"use strict";

function required(env, name, pattern) {
  const value = env[name];
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) throw new Error(`Invalid or missing ${name}`);
  return value;
}

function origin(value, name = "URL") {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || !["", "/"].includes(parsed.pathname) || /[\s\\]/.test(value)) {
    throw new Error(`${name} must be an HTTPS origin without credentials or a path`);
  }
  return parsed.origin;
}

function awsConfig(env = process.env) {
  const config = {
    stack: required(env, "STACK_NAME", /^[A-Za-z][A-Za-z0-9-]{0,127}$/),
    region: required(env, "AWS_REGION", /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/),
    secretArn: required(env, "RUNTIME_SECRET_ARN", /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/),
    secretVersion: required(env, "RUNTIME_SECRET_VERSION", /^[A-Za-z0-9-]{32,64}$/),
    commit: required(env, "BUILD_COMMIT", /^[a-f0-9]{40}$/),
    modelVersion: required(env, "PROVIDER_MODEL_VERSION", /^[A-Za-z0-9._-]{1,100}$/)
  };
  for (const name of ["API_PUBLIC_URL", "HOSTED_BASE_URL", "DASHBOARD_URL", "EMAIL_API_URL"]) config[name] = origin(required(env, name), name);
  config.cors = required(env, "CORS_ORIGINS").split(",").map(value => origin(value.trim(), "CORS_ORIGINS"));
  for (const name of ["HOSTED_BASE_URL", "DASHBOARD_URL"]) {
    if (!config.cors.includes(config[name])) throw new Error(`CORS_ORIGINS must include ${name}`);
  }
  if (env.SCHEMA_CHANGE_APPROVED !== "true") throw new Error("Approve a backward-compatible schema rollout with SCHEMA_CHANGE_APPROVED=true");
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