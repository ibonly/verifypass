"use strict";

// CORS for the dashboard + hosted page.
// Production: only origins listed in CORS_ORIGINS (comma-separated).
// Development: any localhost/127.0.0.1 origin, so `vite dev` on any port works.

const config = require("../config");

const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function cors(req, res, next) {
  const origin = req.headers.origin;
  const allowlist = (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = origin && (allowlist.includes(origin) || (config.env !== "production" && LOCALHOST_RE.test(origin)));

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
