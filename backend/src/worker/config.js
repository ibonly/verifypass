"use strict";

const { requireSecret, requireEvidenceKey } = require("../lib/envConfig");

module.exports = {
  env: process.env.NODE_ENV || "development",
  pollMs: Number(process.env.WORKER_POLL_MS || 2000),
  evidenceEncryptionKey: requireEvidenceKey(),
  sdkTokenSecret: requireSecret("SDK_TOKEN_SECRET", "dev-only-secret"),
  // Which verification provider the worker uses:
  //   "onnx"       — server-side ONNX models (onnxruntime-node), no license/Docker
  //   "faceplugin" — Faceplugin on-prem Docker services (licensed)
  provider: (process.env.VP_PROVIDER || "onnx").toLowerCase(),
  // Version label for the deployed biometric models (container tag, model
  // file hash — whatever identifies the exact models). Recorded with every
  // result: scores from DIFFERENT model versions are NOT comparable, and
  // face-match thresholds must be recalibrated on every model upgrade.
  modelVersion: process.env.PROVIDER_MODEL_VERSION || null,
  onnx: {
    modelsDir: process.env.ONNX_MODELS_DIR || null, // defaults to backend/models
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
