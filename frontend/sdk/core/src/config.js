"use strict";

function validateApiBase(value) {
  if (typeof value !== "string" || /[\s\\]/.test(value)) throw new Error("Invalid VerifyPass API URL");
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      || url.username || url.password || url.search || url.hash) {
    throw new Error("VerifyPass API URL must use HTTPS (HTTP is allowed only on localhost), without credentials, query or fragment");
  }
  return url.href.replace(/\/+$/, "");
}

function validatePublicKey(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^vp_pub_[A-Za-z0-9_-]+$/.test(value) || value.length > 512) {
    throw new Error("VerifyPass requires a public API key; never pass a secret key to the browser");
  }
  return value;
}

function readPublicConfig(env = {}) {
  const baseUrl = env.VITE_VP_API_BASE || env.VP_API_BASE || null;
  const publicKey = env.VITE_VP_PUBLIC_KEY || null;
  return {
    baseUrl: baseUrl ? validateApiBase(baseUrl) : null,
    publicKey: validatePublicKey(publicKey),
    faceModelUrl: env.VITE_VP_FACE_MODEL_URL || null,
    landmarkModelUrl: env.VITE_VP_LANDMARK_MODEL_URL || undefined
  };
}

module.exports = { validateApiBase, validatePublicKey, readPublicConfig };