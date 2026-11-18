"use strict";

const path = require("path");
const { isStrictEnv, requireSecret, requireEvidenceKey } = require("./lib/envConfig");

function requireApiPublicUrl() {
  const value = process.env.API_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
  if (isStrictEnv()) {
    if (!process.env.API_PUBLIC_URL || !/^https:\/\//.test(value)) {
      throw new Error(`API_PUBLIC_URL must be set to this deployment's https origin in ${process.env.NODE_ENV} (it is embedded in SDK tokens)`);
    }
  }
  return value.replace(/\/$/, "");
}

module.exports = {
  env: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 3000),
  // Public origin of THIS API deployment — embedded in SDK tokens so browser
  // SDKs are self-locating (consumers never configure a baseUrl). One value
  // per environment; sandbox and production deployments each set their own.
  apiPublicUrl: requireApiPublicUrl(),
  sessionTtlMinutes: Number(process.env.SESSION_TTL_MINUTES || 30),
  // Refuse biometric uploads until consent is recorded (NDPA). ON in
  // production; override with REQUIRE_CONSENT=true|false (dev default off so
  // scripts/e2e that upload directly keep working).
  requireConsent: process.env.REQUIRE_CONSENT
    ? process.env.REQUIRE_CONSENT === "true"
    : (process.env.NODE_ENV || "development") === "production",
  sdkTokenSecret: requireSecret("SDK_TOKEN_SECRET", "dev-only-secret"),
  authTokenSecret: requireSecret("AUTH_TOKEN_SECRET", "dev-only-auth-secret"),
  // Always absolute. A relative EVIDENCE_DIR (the .env default) is anchored on
  // the backend directory, NOT process.cwd(), so `node server.js` from
  // backend/ and `node scripts/dev-stack.js` from the repo root share one store.
  evidenceDir: path.resolve(__dirname, "..", process.env.EVIDENCE_DIR || "./evidence-store"),
  hostedBaseUrl: process.env.HOSTED_BASE_URL || "https://verify.verix.com",
  // Verification provider the worker runs (mirrors worker.js). The API needs
  // it to issue only challenges the provider can verify: expression actions
  // need 68-point landmarks, which only the ONNX provider supplies.
  provider: (process.env.VP_PROVIDER || "onnx").toLowerCase(),
  // Expression actions (blink / open_mouth) are retired from issuance by
  // default (browser eye-band detection false-triggered on lighting). Opt in
  // per deployment; ignored unless the provider can verify them.
  challengeExpressions: process.env.CHALLENGE_ALLOW_EXPRESSIONS === "true" && (process.env.VP_PROVIDER || "onnx").toLowerCase() === "onnx",
  evidenceEncryptionKey: requireEvidenceKey(),
  cloudinary: (() => {
    // Ignore a placeholder CLOUDINARY_URL (contains "<...>") so it can't shadow
    // the discrete cloud_name/api_key/api_secret values.
    const rawUrl = process.env.CLOUDINARY_URL || null;
    const url = rawUrl && !rawUrl.includes("<") ? rawUrl : null;
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME || null;
    const apiKey = process.env.CLOUDINARY_API_KEY || null;
    const apiSecret = process.env.CLOUDINARY_API_SECRET || null;
    return {
      url,
      cloudName,
      apiKey,
      apiSecret,
      folder: process.env.CLOUDINARY_FOLDER || "verifypass",
      enabled: !!(url || (cloudName && apiKey && apiSecret))
    };
  })()
};
