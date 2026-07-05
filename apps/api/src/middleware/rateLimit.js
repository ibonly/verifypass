"use strict";

// In-memory sliding-window rate limiter (PRD §16.1). Dependency-free.
// NOTE: per-process state. Under Passenger with multiple processes the
// effective limit is N× the configured value — set limits with headroom, and
// add Apache mod_ratelimit / a shared store when scaling out (M5 note in docs).

const { AppError } = require("@verifypass/shared");

function createRateLimiter({ windowMs, max, keyFn, name = "default", now = Date.now }) {
  const hits = new Map(); // key → [timestamps]
  let lastSweep = now();

  function sweep(t) {
    if (t - lastSweep < windowMs) return;
    lastSweep = t;
    for (const [k, arr] of hits) {
      const fresh = arr.filter((ts) => t - ts < windowMs);
      if (fresh.length) hits.set(k, fresh); else hits.delete(k);
    }
  }

  function check(key) {
    const t = now();
    sweep(t);
    const arr = (hits.get(key) || []).filter((ts) => t - ts < windowMs);
    if (arr.length >= max) {
      hits.set(key, arr);
      return false;
    }
    arr.push(t);
    hits.set(key, arr);
    return true;
  }

  function middleware(req, res, next) {
    const key = keyFn ? keyFn(req) : (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown");
    if (!check(String(key))) {
      res.setHeader("Retry-After", Math.ceil(windowMs / 1000));
      return next(new AppError("RATE_LIMITED", `Too many requests (${name})`));
    }
    next();
  }

  middleware.check = check; // exposed for tests
  return middleware;
}

/** Standard limiters used across the app. */
function standardLimiters() {
  const ipKey = (req) => req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown";
  return {
    // generous global backstop
    global: createRateLimiter({ windowMs: 60_000, max: 300, keyFn: ipKey, name: "global" }),
    // credential stuffing protection: per IP+email
    login: createRateLimiter({
      windowMs: 15 * 60_000, max: 10, name: "login",
      keyFn: (req) => `${ipKey(req)}:${(req.body?.email || "").toLowerCase()}`
    }),
    // capture uploads: per tenant once authed — applied after auth middleware
    captures: createRateLimiter({
      windowMs: 60_000, max: 60, name: "captures",
      keyFn: (req) => `tnt:${req.tenant?.id ?? ipKey(req)}`
    })
  };
}

module.exports = { createRateLimiter, standardLimiters };
