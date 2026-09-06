"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMockDb } = require("./helpers/mockDb");
const { analyzeTelemetry, runTelemetryAnomaly } = require("../src/worker/telemetryAnomaly");

let n = 0;
function sess(tenantId, actions, extra = {}) {
  n++;
  return {
    id: `s${n}`, sessionUid: `ses_${n}`, tenantId, createdAt: new Date(),
    deviceFingerprint: extra.fp || null,
    deviceMeta: { telemetry: { actions: actions.map(([action, ms, hints = 1]) => ({ action, msToTrigger: ms, hints: Array(hints).fill("none"), mode: "auto" })) } }
  };
}
// realistic human population: 1.2–3.5 s, varied, usually coached once
function human(tenantId, seed) {
  const r = (i) => 1200 + ((seed * 7919 + i * 104729) % 2300);
  return sess(tenantId, [["turn_left", r(1)], ["turn_right", r(2)], ["look_up", r(3)]]);
}

test("humans are not flagged; instant / uniform / duplicate / too_fast / device farms are", () => {
  const humans = Array.from({ length: 30 }, (_, i) => human(1, i + 1));
  const instant = sess(1, [["turn_left", 120], ["turn_right", 2100], ["look_up", 1900]]);
  const uniform = sess(1, [["turn_left", 1500, 0], ["turn_right", 1520, 0], ["look_up", 1490, 0]]);
  const dupA = sess(1, [["turn_left", 1810], ["turn_right", 2205], ["look_up", 1633]]);
  const dupB = sess(1, [["turn_left", 1812], ["turn_right", 2201], ["look_up", 1637]]);
  const fast = sess(1, [["turn_left", 400], ["turn_right", 450], ["look_up", 2000]]);
  const farm = [1, 2, 3].map((i) => sess(1, [["turn_left", 2000 + i], ["turn_right", 2500 + i], ["look_up", 1800 - i]], { fp: "fp-farm" }));
  const otherTenantDup = sess(2, [["turn_left", 1810], ["turn_right", 2205], ["look_up", 1633]]); // same vector, other tenant → not a duplicate

  const { findings, stats } = analyzeTelemetry([...humans, instant, uniform, dupA, dupB, fast, ...farm, otherTenantDup]);
  const byUid = Object.fromEntries(findings.map((f) => [f.sessionUid, f.flags]));

  for (const h of humans) assert.equal(byUid[h.sessionUid], undefined, `human ${h.sessionUid} flagged: ${byUid[h.sessionUid]}`);
  assert.deepEqual(byUid[instant.sessionUid], ["instant"]);
  assert.deepEqual(byUid[uniform.sessionUid], ["uniform"]);
  assert.deepEqual(byUid[dupA.sessionUid], ["duplicate"]);
  assert.deepEqual(byUid[dupB.sessionUid], ["duplicate"]);
  assert.ok(byUid[fast.sessionUid].includes("too_fast"));
  for (const f of farm) assert.ok(byUid[f.sessionUid].includes("device_uniform"), `farm ${f.sessionUid}: ${byUid[f.sessionUid]}`);
  assert.equal(byUid[otherTenantDup.sessionUid], undefined);
  assert.ok(stats["1|turn_left"].n >= 30);
});

test("too_fast needs enough samples per tenant+action; manual-mode timings are ignored", () => {
  const few = Array.from({ length: 5 }, (_, i) => human(3, i + 1));
  const fast = sess(3, [["turn_left", 400], ["turn_right", 450], ["look_up", 2000]]);
  const manual = sess(3, []);
  manual.deviceMeta.telemetry.actions = [{ action: "turn_left", msToTrigger: 50, mode: "manual", hints: [] }];
  const { findings } = analyzeTelemetry([...few, fast, manual]);
  const f = findings.find((x) => x.sessionUid === fast.sessionUid);
  assert.equal(f, undefined); // 400/450 ms are not instant and stats are untrusted
  assert.equal(findings.find((x) => x.sessionUid === manual.sessionUid), undefined);
});

test("runTelemetryAnomaly writes an audited risk event + result signal once per flag set", async () => {
  const db = createMockDb();
  const humans = Array.from({ length: 25 }, (_, i) => human(1, i + 1));
  const bad = sess(1, [["turn_left", 100], ["turn_right", 2100], ["look_up", 1900]]);
  for (const s of [...humans, bad]) await db.verificationSession.create({ data: s });
  const bref = await db.verificationSession.findFirst({ where: { sessionUid: bad.sessionUid } });
  await db.verificationResult.create({ data: { sessionId: bref.id, rawResult: { riskSignals: { captureAnomaly: false } } } });

  const r1 = await runTelemetryAnomaly(db);
  assert.equal(r1.flagged, 1);
  assert.equal(r1.written, 1);
  const res = await db.verificationResult.findFirst({ where: { sessionId: bref.id } });
  assert.deepEqual(res.rawResult.riskSignals.telemetryAnomaly.flags, ["instant"]);
  assert.equal(res.rawResult.riskSignals.captureAnomaly, false); // merged, not replaced
  const audits = await db.auditLog.findMany({ where: { action: "telemetry.anomaly" } });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].riskEvent, true);

  const r2 = await runTelemetryAnomaly(db); // idempotent
  assert.equal(r2.written, 0);
  assert.equal((await db.auditLog.findMany({ where: { action: "telemetry.anomaly" } })).length, 1);
});
