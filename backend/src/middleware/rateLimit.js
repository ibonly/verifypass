"use strict";

// Rate limiting (PRD §16.1), two backends:
//   memory — sliding window, dependency-free, PER-PROCESS. Used in dev/test.
//   db     — fixed-window counters in MongoDB, shared across ALL processes.
//            Default in production/staging (Passenger spawns N processes; the
//            in-memory limiter would silently multiply every cap by N).
// Select explicitly with RATE_LIMIT_BACKEND=db|memory.

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

/**
 * MongoDB-backed fixed-window limiter — one shared counter per key+window, so
 * the cap holds regardless of how many API processes are running.
 * Counter increments are atomic (upsert with increment; unique-race retried).
 * FAIL-OPEN on database errors: rate limiting protects capacity, and refusing
 * all traffic because the limiter store hiccuped would be worse — errors are
 * logged loudly instead.
 */
function createDbRateLimiter({ windowMs, max, keyFn, name = "default", now = Date.now, getDbImpl }) {
  const resolveDb = getDbImpl || (() => require("../lib/db").getDb());

  async function count(key) {
    const db = resolveDb();
    const t = now();
    const bucket = Math.floor(t / windowMs);
    const rowKey = `${name}:${key}:${bucket}`.slice(0, 191);
    const windowEndsAt = new Date((bucket + 1) * windowMs);
    try {
      const row = await db.rateLimitCounter.upsert({
        where: { key: rowKey },
        create: { key: rowKey, count: 1, windowEndsAt },
        update: { count: { increment: 1 } }
      });
      return row.count;
    } catch (_) {
      // two processes raced the create — the row exists now, plain increment
      const row = await db.rateLimitCounter.update({
        where: { key: rowKey },
        data: { count: { increment: 1 } }
      });
      return row.count;
    }
  }

  async function check(key) {
    return (await count(key)) <= max;
  }

  function middleware(req, res, next) {
    const key = keyFn ? keyFn(req) : (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown");
    check(String(key))
      .then((ok) => {
        if (ok) return next();
        res.setHeader("Retry-After", Math.ceil(windowMs / 1000));
        next(new AppError("RATE_LIMITED", `Too many requests (${name})`));
      })
      .catch((err) => {
        console.error("RATE_LIMIT_STORE_ERROR", { name, err: err.message });
        next(); // fail open — see note above
      });
  }

  middleware.check = check; // exposed for tests
  return middleware;
}

/** Standard limiters used across the app. Backend chosen by environment. */
function standardLimiters() {
  const env = process.env.NODE_ENV || "development";
  const backend = process.env.RATE_LIMIT_BACKEND
    || (env === "production" || env === "staging" ? "db" : "memory");
  const make = backend === "db" ? createDbRateLimiter : createRateLimiter;

  const ipKey = (req) => req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown";
  return {
    // generous global backstop
    global: make({ windowMs: 60_000, max: 300, keyFn: ipKey, name: "global" }),
    // credential stuffing protection: per IP+email
    login: make({
      windowMs: 15 * 60_000, max: 10, name: "login",
      keyFn: (req) => `${ipKey(req)}:${(req.body?.email || "").toLowerCase()}`
    }),
    // capture uploads: per tenant once authed — applied after auth middleware
    captures: make({
      windowMs: 60_000, max: 60, name: "captures",
      keyFn: (req) => `tnt:${req.tenant?.id ?? ipKey(req)}`
    })
  };
}

module.exports = { createRateLimiter, createDbRateLimiter, standardLimiters };
