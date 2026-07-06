"use strict";

function requireSecret(name, fallback) {
  const value = process.env[name] || fallback;
  if (process.env.NODE_ENV === "production") {
    if (!process.env[name] || value.startsWith("dev-only-") || value.startsWith("change-me-") || value.length < 32) {
      throw new Error(`${name} must be set to a random 32+ character value in production`);
    }
  }
  return value;
}

function requireEvidenceKey() {
  const value = process.env.EVIDENCE_ENCRYPTION_KEY || null;
  if (process.env.NODE_ENV === "production" && !/^[0-9a-fA-F]{64}$/.test(value || "")) {
    throw new Error("EVIDENCE_ENCRYPTION_KEY must be 64 hex chars in production");
  }
  return value;
}

function requireApiPublicUrl() {
  const value = process.env.API_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
  if (process.env.NODE_ENV === "production") {
    if (!process.env.API_PUBLIC_URL || !/^https:\/\//.test(value)) {
      throw new Error("API_PUBLIC_URL must be set to this deployment's https origin in production (it is embedded in SDK tokens)");
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
  sdkTokenSecret: requireSecret("SDK_TOKEN_SECRET", "dev-only-secret"),
  authTokenSecret: requireSecret("AUTH_TOKEN_SECRET", "dev-only-auth-secret"),
  evidenceDir: process.env.EVIDENCE_DIR || "./evidence-store",
  hostedBaseUrl: process.env.HOSTED_BASE_URL || "https://verify.verifypass.com",
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
