"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { setDb } = require("../src/lib/db");
const { createMockDb } = require("./helpers/mockDb");
const { tenantScope } = require("../src/middleware/tenantScope");
const { toCsv, escapeCell } = require("../src/services/csv");
const reports = require("../src/services/reportService");

function scopeFor(tenant) {
  const req = { tenant };
  tenantScope(req, {}, () => {});
  return req.scopedDb;
}

const DAY = 86_400_000;

async function seed(db) {
  const tenant = await db.tenant.create({ data: { tenantUid: "tnt_r", companyName: "R", status: "active" } });
  const other = await db.tenant.create({ data: { tenantUid: "tnt_o", companyName: "O", status: "active" } });

  const mk = (uid, status, daysAgo, reasonCodes = [], ref = null, tenantId = tenant.id) =>
    db.verificationSession.create({
      data: {
        sessionUid: uid, tenantId, status, customerReference: ref,
        decisionReason: reasonCodes.length ? { reasonCodes } : null,
        createdAt: new Date(Date.now() - daysAgo * DAY),
        completedAt: ["approved", "rejected"].includes(status) ? new Date(Date.now() - daysAgo * DAY + 60_000) : null
      }
    });

  await mk("vps_R1", "approved", 0, [], "CUST-R");
  await mk("vps_R2", "approved", 1);
  await mk("vps_R3", "rejected", 1, ["LIVENESS_FAILED"]);
  await mk("vps_R4", "rejected", 2, ["LIVENESS_FAILED", "DOCUMENT_EXPIRED"]);
  await mk("vps_R5", "manual_review", 1, ["FACE_MATCH_BORDERLINE"], "CUST-R");
  await mk("vps_R6", "approved", 45); // outside 30-day window
  await mk("vps_OTHER", "rejected", 0, ["LIVENESS_FAILED"], null, other.id); // other tenant

  await db.auditLog.create({ data: { tenantId: tenant.id, actorType: "system", action: "verification.decided", riskEvent: true, createdAt: new Date() } });
  await db.auditLog.create({ data: { tenantId: tenant.id, actorType: "api", action: "session.created", riskEvent: false, createdAt: new Date() } });
  await db.auditLog.create({ data: { tenantId: other.id, actorType: "system", action: "verification.decided", riskEvent: true, createdAt: new Date() } });

  return { tenant, other };
}

test("dailyVolume: groups by day, respects window, scoped to tenant", async (t) => {
  const db = createMockDb();
  setDb(db);
  t.after(() => setDb(null));
  const { tenant } = await seed(db);

  const days = await reports.dailyVolume(scopeFor(tenant), { days: 30 });
  const totals = days.reduce((n, d) => n + d.total, 0);
  assert.equal(totals, 5); // 6 in-tenant minus 1 outside window; other tenant's excluded

  const yesterday = days.find((d) => d.total === 3);
  assert.equal(yesterday.approved, 1);
  assert.equal(yesterday.rejected, 1);
  assert.equal(yesterday.manual_review, 1);
  // sorted ascending
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  assert.deepEqual(days.map((d) => d.date), sorted.map((d) => d.date));
});

test("topReasons: counts codes across rejected + review, sorted desc", async (t) => {
  const db = createMockDb();
  setDb(db);
  t.after(() => setDb(null));
  const { tenant } = await seed(db);

  const reasons = await reports.topReasons(scopeFor(tenant), { days: 30 });
  assert.deepEqual(reasons[0], { reasonCode: "LIVENESS_FAILED", count: 2 });
  const codes = reasons.map((r) => r.reasonCode);
  assert.ok(codes.includes("DOCUMENT_EXPIRED"));
  assert.ok(codes.includes("FACE_MATCH_BORDERLINE"));
});

test("riskEvents + auditExport: tenant-scoped", async (t) => {
  const db = createMockDb();
  setDb(db);
  t.after(() => setDb(null));
  const { tenant } = await seed(db);

  const risk = await reports.riskEvents(scopeFor(tenant), { days: 30 });
  assert.equal(risk.length, 1); // other tenant's risk event excluded
  assert.equal(risk[0].action, "verification.decided");

  const all = await reports.auditExport(scopeFor(tenant), { days: 30 });
  assert.equal(all.length, 2);
});

test("customerHistory: assembles sessions, scores, notes; 404 unknown; scoped", async (t) => {
  const db = createMockDb();
  setDb(db);
  t.after(() => setDb(null));
  const { tenant, other } = await seed(db);

  const s5 = await db.verificationSession.findFirst({ where: { sessionUid: "vps_R5" } });
  await db.verificationResult.create({ data: { sessionId: s5.id, livenessScore: 0.8, faceMatchScore: 0.7, extractedData: { fullName: "X" } } });
  await db.manualReviewNote.create({ data: { sessionId: s5.id, userId: 1, decision: "approved", note: "checked manually" } });

  const h = await reports.customerHistory(scopeFor(tenant), "CUST-R");
  assert.equal(h.sessionCount, 2);
  const reviewed = h.sessions.find((s) => s.sessionId === "vps_R5");
  assert.equal(reviewed.scores.faceMatch, 0.7);
  assert.equal(reviewed.reviewNotes[0].note, "checked manually");

  await assert.rejects(() => reports.customerHistory(scopeFor(tenant), "CUST-GHOST"), (e) => e.code === "NOT_FOUND");
  await assert.rejects(() => reports.customerHistory(scopeFor(other), "CUST-R"), (e) => e.code === "NOT_FOUND");
});

test("CSV: RFC 4180 escaping + formula injection guard", () => {
  assert.equal(escapeCell("plain"), "plain");
  assert.equal(escapeCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(escapeCell("line1\nline2"), '"line1\nline2"');
  assert.equal(escapeCell("=SUM(A1:A9)"), "'=SUM(A1:A9)");
  assert.equal(escapeCell("+2348001234567"), "'+2348001234567");
  assert.equal(escapeCell("@handle"), "'@handle");
  assert.equal(escapeCell(null), "");
  assert.equal(escapeCell({ a: 1 }), '"{""a"":1}"');

  const csv = toCsv(
    [{ name: "A,B", nested: { v: 2 } }],
    [{ key: "name", header: "name" }, { key: "nested.v", header: "value" }]
  );
  assert.equal(csv, 'name,value\r\n"A,B",2\r\n');
});

test("webhookFailures: only failed/exhausted, tenant-scoped", async (t) => {
  const db = createMockDb();
  setDb(db);
  t.after(() => setDb(null));
  const { tenant, other } = await seed(db);

  const mkD = (uid, status, tenantId) => db.webhookDelivery.create({
    data: { eventUid: uid, tenantId, event: "verification.approved", payload: {}, url: "https://x", status, attempts: 1 }
  });
  await mkD("evt_ok", "delivered", tenant.id);
  await mkD("evt_bad", "failed", tenant.id);
  await mkD("evt_dead", "exhausted", tenant.id);
  await mkD("evt_other", "failed", other.id);

  const rows = await reports.webhookFailures(scopeFor(tenant));
  assert.deepEqual(rows.map((r) => r.eventId).sort(), ["evt_bad", "evt_dead"]);
});
