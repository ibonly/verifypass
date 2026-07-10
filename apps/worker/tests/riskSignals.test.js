"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveThresholds } = require("@verifypass/shared");
const { createMockDb } = require("../../api/tests/helpers/mockDb");
const { computeRiskSignals } = require("../src/riskSignals");

const T = resolveThresholds({}); // defaults: 3 failures/24h, 3 ids/device/7d, 20 ip/h
const HOUR = 3600 * 1000;

async function seedSessions(db, tenantId, rows) {
  const out = [];
  for (const r of rows) {
    out.push(await db.verificationSession.create({
      data: {
        sessionUid: r.uid, tenantId, status: r.status || "created",
        customerReference: r.ref ?? null,
        deviceFingerprint: r.fp ?? null,
        clientIp: r.ip ?? null,
        createdAt: r.at || new Date()
      }
    }));
  }
  return out;
}

test("repeated failures: flags at threshold, ignores old + other-tenant + own session", async () => {
  const db = createMockDb();
  const now = new Date();
  const recent = (h) => new Date(now.getTime() - h * HOUR);

  await seedSessions(db, 1, [
    { uid: "f1", ref: "CUST-1", status: "rejected", at: recent(1) },
    { uid: "f2", ref: "CUST-1", status: "failed", at: recent(5) },
    { uid: "f3", ref: "CUST-1", status: "rejected", at: recent(23) },
    { uid: "old", ref: "CUST-1", status: "rejected", at: recent(30) },      // outside window
    { uid: "ok", ref: "CUST-1", status: "approved", at: recent(2) }         // not a failure
  ]);
  await seedSessions(db, 2, [{ uid: "other", ref: "CUST-1", status: "rejected", at: recent(1) }]);
  const [current] = await seedSessions(db, 1, [{ uid: "cur", ref: "CUST-1", status: "submitted", at: now }]);

  const risk = await computeRiskSignals(db, current, T, now);
  assert.equal(risk.counts.priorFailures, 3);
  assert.equal(risk.repeatedFailedAttempts, true);

  // one fewer failure → under threshold
  const db2 = createMockDb();
  await seedSessions(db2, 1, [
    { uid: "f1", ref: "CUST-1", status: "rejected", at: recent(1) },
    { uid: "f2", ref: "CUST-1", status: "failed", at: recent(5) }
  ]);
  const [cur2] = await seedSessions(db2, 1, [{ uid: "cur", ref: "CUST-1", status: "submitted", at: now }]);
  const risk2 = await computeRiskSignals(db2, cur2, T, now);
  assert.equal(risk2.repeatedFailedAttempts, false);
});

test("device reuse: distinct identities over threshold flags; same identity reuse doesn't", async () => {
  const db = createMockDb();
  const now = new Date();
  const FP = "fp_shared_device";

  await seedSessions(db, 1, [
    { uid: "d1", ref: "ID-A", fp: FP, at: new Date(now - 1 * HOUR) },
    { uid: "d2", ref: "ID-B", fp: FP, at: new Date(now - 2 * HOUR) },
    { uid: "d3", ref: "ID-C", fp: FP, at: new Date(now - 50 * HOUR) },
    { uid: "d4", ref: "ID-A", fp: FP, at: new Date(now - 3 * HOUR) } // repeat identity, not new
  ]);
  const [current] = await seedSessions(db, 1, [{ uid: "cur", ref: "ID-D", fp: FP, at: now }]);

  const risk = await computeRiskSignals(db, current, T, now);
  assert.equal(risk.counts.deviceIdentities, 4); // A, B, C, D
  assert.equal(risk.deviceSharedAcrossIdentities, true); // > 3

  // Same device, same person retrying → 1 identity, no flag
  const db2 = createMockDb();
  await seedSessions(db2, 1, [
    { uid: "d1", ref: "ID-A", fp: FP, at: new Date(now - 1 * HOUR) },
    { uid: "d2", ref: "ID-A", fp: FP, at: new Date(now - 2 * HOUR) }
  ]);
  const [cur2] = await seedSessions(db2, 1, [{ uid: "cur", ref: "ID-A", fp: FP, at: now }]);
  const risk2 = await computeRiskSignals(db2, cur2, T, now);
  assert.equal(risk2.deviceSharedAcrossIdentities, false);
});

test("device reuse is DISABLED in development, active in staging/production", async () => {
  const now = new Date();
  const FP = "fp_dev_machine";

  // One dev machine, five throwaway SAMPLE-* identities — over the threshold.
  async function seedFarm() {
    const db = createMockDb();
    await seedSessions(db, 1, [
      { uid: "d1", ref: "SAMPLE-1", fp: FP, at: new Date(now - 1 * HOUR) },
      { uid: "d2", ref: "SAMPLE-2", fp: FP, at: new Date(now - 2 * HOUR) },
      { uid: "d3", ref: "SAMPLE-3", fp: FP, at: new Date(now - 3 * HOUR) },
      { uid: "d4", ref: "SAMPLE-4", fp: FP, at: new Date(now - 4 * HOUR) }
    ]);
    const [cur] = await seedSessions(db, 1, [{ uid: "cur", ref: "SAMPLE-5", fp: FP, at: now }]);
    return { db, cur };
  }

  const dev = await seedFarm();
  const devRisk = await computeRiskSignals(dev.db, dev.cur, T, now, { env: "development" });
  assert.equal(devRisk.deviceSharedAcrossIdentities, false, "dev machines legitimately create many identities");
  assert.equal(devRisk.counts.deviceIdentities, 0, "check skipped entirely in development");

  for (const env of ["staging", "production", undefined]) {
    const { db, cur } = await seedFarm();
    const risk = await computeRiskSignals(db, cur, T, now, { env });
    assert.equal(risk.deviceSharedAcrossIdentities, true, `must stay armed for env=${env}`);
  }
});

test("ip velocity: bursts flag, spread-out traffic doesn't; null ip skips", async () => {
  const db = createMockDb();
  const now = new Date();
  const burst = [];
  for (let i = 0; i < 21; i++) burst.push({ uid: `b${i}`, ip: "197.210.0.1", at: new Date(now - 10 * 60 * 1000) });
  await seedSessions(db, 1, burst);
  const [current] = await seedSessions(db, 1, [{ uid: "cur", ip: "197.210.0.1", at: now }]);

  const risk = await computeRiskSignals(db, current, T, now);
  assert.equal(risk.ipVelocityExceeded, true);
  assert.ok(risk.counts.ipSessionsLastHour >= 21);

  const [noIp] = await seedSessions(db, 1, [{ uid: "noip", at: now }]);
  const riskNoIp = await computeRiskSignals(db, noIp, T, now);
  assert.equal(riskNoIp.ipVelocityExceeded, false);
  assert.equal(riskNoIp.counts.ipSessionsLastHour, 0);
});
