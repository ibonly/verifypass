"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const { setDb } = require("../src/lib/db");
const { createMockDb } = require("./helpers/mockDb");
const { createRateLimiter } = require("../src/middleware/rateLimit");
const { deleteBiometricData } = require("../src/services/deletionService");
const { tenantScope } = require("../src/middleware/tenantScope");

test("rate limiter: allows up to max, then blocks, then recovers after window", () => {
  let t = 0;
  const limiter = createRateLimiter({ windowMs: 1000, max: 3, now: () => t });

  assert.equal(limiter.check("k"), true);
  assert.equal(limiter.check("k"), true);
  assert.equal(limiter.check("k"), true);
  assert.equal(limiter.check("k"), false); // over limit
  assert.equal(limiter.check("other"), true); // separate key unaffected

  t = 1001; // window elapsed
  assert.equal(limiter.check("k"), true);
});

test("rate limiter middleware returns RATE_LIMITED error", () => {
  let t = 0;
  const limiter = createRateLimiter({ windowMs: 1000, max: 1, keyFn: () => "fixed", now: () => t });
  const res = { setHeader: () => {} };
  let err = null;
  limiter({ headers: {} }, res, (e) => { err = e || null; });
  assert.equal(err, null);
  limiter({ headers: {} }, res, (e) => { err = e || null; });
  assert.equal(err?.code, "RATE_LIMITED");
  assert.equal(err?.http, 429);
});

test("biometric deletion: files removed, PII stripped, scores retained, other customers untouched", async (t) => {
  const db = createMockDb();
  setDb(db);
  t.after(() => setDb(null));

  const tenant = await db.tenant.create({ data: { tenantUid: "tnt_del", companyName: "D", status: "active" } });
  const scope = (() => { const req = { tenant }; tenantScope(req, {}, () => {}); return req.scopedDb; })();

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vp-del-"));

  async function makeSession(ref, uid) {
    const s = await db.verificationSession.create({
      data: { sessionUid: uid, tenantId: tenant.id, customerReference: ref, status: "approved" }
    });
    const p = path.join(dir, `${uid}.enc`);
    await fs.writeFile(p, crypto.randomBytes(100));
    await db.evidenceFile.create({ data: { sessionId: s.id, fileType: "selfie", storagePath: p } });
    await db.verificationResult.create({
      data: { sessionId: s.id, livenessScore: 0.95, extractedData: { fullName: "SENSITIVE" }, rawResult: { x: 1 } }
    });
    return { session: s, path: p };
  }

  const a1 = await makeSession("CUST-A", "vps_DEL1");
  const a2 = await makeSession("CUST-A", "vps_DEL2");
  const b = await makeSession("CUST-B", "vps_DEL3");

  const out = await deleteBiometricData(scope, "CUST-A");
  assert.equal(out.sessionsAffected, 2);
  assert.equal(out.filesDeleted, 2);

  // A's files gone, B's intact
  await assert.rejects(() => fs.access(a1.path));
  await assert.rejects(() => fs.access(a2.path));
  await fs.access(b.path);

  // A's PII stripped but scores retained
  const rA = await db.verificationResult.findFirst({ where: { sessionId: a1.session.id } });
  assert.equal(rA.extractedData, null);
  assert.equal(rA.rawResult, null);
  assert.equal(rA.livenessScore, 0.95);

  const rB = await db.verificationResult.findFirst({ where: { sessionId: b.session.id } });
  assert.equal(rB.extractedData.fullName, "SENSITIVE");

  // evidence rows for A removed
  assert.equal((await db.evidenceFile.findMany({ where: { sessionId: a1.session.id } })).length, 0);
  assert.equal((await db.evidenceFile.findMany({ where: { sessionId: b.session.id } })).length, 1);
});

test("biometric deletion: unknown reference 404s; cannot cross tenants", async (t) => {
  const db = createMockDb();
  setDb(db);
  t.after(() => setDb(null));

  const tenantA = await db.tenant.create({ data: { tenantUid: "tnt_x", companyName: "X", status: "active" } });
  const tenantB = await db.tenant.create({ data: { tenantUid: "tnt_y", companyName: "Y", status: "active" } });
  await db.verificationSession.create({
    data: { sessionUid: "vps_TX", tenantId: tenantA.id, customerReference: "CUST-X", status: "approved" }
  });

  const scopeB = (() => { const req = { tenant: tenantB }; tenantScope(req, {}, () => {}); return req.scopedDb; })();
  // B asking to delete A's customer → 404, nothing leaked or removed
  await assert.rejects(() => deleteBiometricData(scopeB, "CUST-X"), (e) => e.code === "NOT_FOUND");
});
