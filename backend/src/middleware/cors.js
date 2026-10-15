"use strict";

// CORS for the dashboard + hosted page.
// Production: only origins listed in CORS_ORIGINS (comma-separated).
// Development: any http/https origin, so `vite dev` also works through port forwarding.

const config = require("../config");

const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// Browser SDK endpoints are embedded on tenant sites, so any origin may call
// them. Safe because they authenticate with a per-session bearer token or a
// public key + tenant domain allowlist sent in headers, never cookies (no
// Access-Control-Allow-Credentials). Secret-key routes (session create,
// /result) and the dashboard stay on the CORS_ORIGINS allowlist.
const SDK_ROUTE = /^\/v1\/verification-sessions\/[A-Za-z0-9_-]{1,256}\/(?:handoff\/claim|document|face|liveness-frame|flash|verify|retry|challenge(?:\/(?:reissue|begin))?|consent|status)$/;

function isSdkRoute(req) {
  const path = String(req.path || req.originalUrl || req.url || "").split("?")[0];
  return SDK_ROUTE.test(path);
}

function isDevelopmentOrigin(origin) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (_) {
    return LOCALHOST_RE.test(origin);
  }
}

function cors(req, res, next) {
  const origin = req.headers.origin;
  const allowlist = (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = origin && (allowlist.includes(origin)
    || (config.env !== "production" && isDevelopmentOrigin(origin))
    || (isSdkRoute(req) && isDevelopmentOrigin(origin)));

  if (ok) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Tenant-Id, X-Correlation-Id, X-VP-SDK-Token");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
}

module.exports = { cors, isSdkRoute };
