"use strict";

// CORS for the dashboard + hosted page.
// Production: only origins listed in CORS_ORIGINS (comma-separated).
// Development: any http/https origin, so `vite dev` also works through port forwarding.

const config = require("../config");

const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

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
  const ok = origin && (allowlist.includes(origin) || (config.env !== "production" && isDevelopmentOrigin(origin)));

  if (ok) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Tenant-Id, X-Correlation-Id");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
}

module.exports = { cors };
