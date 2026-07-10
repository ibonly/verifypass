"use strict";

// DB-backed rate limiter: shared fixed-window counters (multi-process safe).

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDbRateLimiter, standardLimiters } = require("../src/middleware/rateLimit");

/** Minimal atomic-counter store mimicking prisma.rateLimitCounter. */
function fakeStore() {
  const rows = new Map();
  return {
    rateLimitCounter: {
      async upsert({ where, create, update }) {
        const existing = rows.get(where.key);
        if (!existing) {
          const row = { ...create };
          rows.set(where.key, row);
          return row;
        }
        existing.count += update.count.increment;
        return existing;
      },
      async update({ where, data }) {
        const row = rows.get(where.key);
        row.count += data.count.increment;
        return row;
      }
    },
    _rows: rows
  };
}

test("caps at max within one window, resets in the next", async () => {
  const db = fakeStore();
  let t = 1_000_000_000_000;
  const limiter = createDbRateLimiter({
    windowMs: 60_000, max: 3, name: "t",
    now: () => t,
    getDbImpl: () => db
  });

  assert.equal(await limiter.check("ip1"), true);
  assert.equal(await limiter.check("ip1"), true);
  assert.equal(await limiter.check("ip1"), true);
  assert.equal(await limiter.check("ip1"), false, "4th call in the window must block");
  assert.equal(await limiter.check("ip2"), true, "other keys unaffected");

  t += 61_000; // next window
  assert.equal(await limiter.check("ip1"), true, "fresh window resets the counter");
});

test("counters are SHARED: two limiter instances (≈ two processes) see one budget", async () => {
  const db = fakeStore();
  const mk = () => createDbRateLimiter({ windowMs: 60_000, max: 3, name: "t", now: () => 1_000_000_000_000, getDbImpl: () => db });
  const procA = mk();
  const procB = mk();

  assert.equal(await procA.check("ip1"), true);
  assert.equal(await procB.check("ip1"), true);
  assert.equal(await procA.check("ip1"), true);
  assert.equal(await procB.check("ip1"), false, "the cap holds ACROSS processes — the whole point");
});

test("middleware fails OPEN when the store errors (availability over strictness)", async () => {
  const limiter = createDbRateLimiter({
    windowMs: 60_000, max: 1, name: "t",
    getDbImpl: () => ({ rateLimitCounter: { upsert: async () => { throw new Error("db down"); }, update: async () => { throw new Error("db down"); } } })
  });
  const next = [];
  await new Promise((resolve) => {
    limiter({ headers: {}, socket: {} }, { setHeader() {} }, (err) => { next.push(err); resolve(); });
  });
  assert.equal(next.length, 1);
  assert.equal(next[0], undefined, "no error passed — request allowed through");
});

test("standardLimiters picks memory backend outside production/staging", () => {
  const limiters = standardLimiters();
  // in-memory limiter's check() is synchronous — that's its signature
  assert.equal(typeof limiters.global.check("x"), "boolean");
});
