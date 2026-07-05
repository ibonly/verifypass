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

module.exports = {
  env: process.env.NODE_ENV || "development",
  pollMs: Number(process.env.WORKER_POLL_MS || 2000),
  evidenceEncryptionKey: requireEvidenceKey(),
  sdkTokenSecret: requireSecret("SDK_TOKEN_SECRET", "dev-only-secret"),
  // Which verification provider the worker uses:
  //   "onnx"       — server-side ONNX models (onnxruntime-node), no license/Docker
  //   "faceplugin" — Faceplugin on-prem Docker services (licensed)
  provider: (process.env.VP_PROVIDER || "onnx").toLowerCase(),
  onnx: {
    modelsDir: process.env.ONNX_MODELS_DIR || null, // defaults to apps/worker/models
    matchThreshold: Number(process.env.ONNX_MATCH_THRESHOLD || 0.6)
  },
  // Faceplugin on-premise Docker services (activate each with its license
  // via /get-machine-code + /activate-machine — see deploy/faceplugin.md)
  faceplugin: {
    livenessUrl: process.env.FACEPLUGIN_LIVENESS_URL || "http://127.0.0.1:8888",
    faceUrl: process.env.FACEPLUGIN_FACE_URL || "http://127.0.0.1:8889",
    idOcrUrl: process.env.FACEPLUGIN_IDOCR_URL || null, // null = OCR service not deployed
    matchThreshold: Number(process.env.FACEPLUGIN_MATCH_THRESHOLD || 0.6),
    timeoutMs: Number(process.env.FACEPLUGIN_TIMEOUT_MS || 20000)
  }
};
