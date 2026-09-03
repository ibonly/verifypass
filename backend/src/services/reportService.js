"use strict";

// Advanced audit reports (PRD §22, Phase 2).
// Aggregations are computed in JS from tenant-scoped rows — correct and
// auditable at current volumes; swap hot paths to SQL GROUP BY when needed.

const { AppError } = require("@verifypass/shared");
const { getDb } = require("../lib/db");

const DAY_MS = 24 * 60 * 60 * 1000;

function dateKey(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function rangeFilter(days) {
  const n = Math.min(Math.max(Number(days) || 30, 1), 365);
  return { from: new Date(Date.now() - n * DAY_MS), days: n };
}

/** Daily verification volume + outcome trend (PRD: daily volume, approval/rejection trend, manual review volume). */
async function dailyVolume(scopedDb, { days = 30 } = {}) {
  const { from } = rangeFilter(days);
  const sessions = await scopedDb.sessions.list({ createdAt: { gte: from } }, { take: 50000 });
  const byDay = new Map();
  for (const s of sessions) {
    const key = dateKey(s.createdAt);
    if (!byDay.has(key)) {
      byDay.set(key, { date: key, total: 0, approved: 0, rejected: 0, manual_review: 0, expired: 0, failed: 0, abandoned: 0, other: 0 });
    }
    const row = byDay.get(key);
    row.total++;
    if (row[s.status] != null) row[s.status]++; else row.other++;
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Top rejection/review reasons (PRD: top rejection reasons). */
async function topReasons(scopedDb, { days = 30, statuses = ["rejected", "manual_review"] } = {}) {
  const { from } = rangeFilter(days);
  const sessions = await scopedDb.sessions.list({ createdAt: { gte: from } }, { take: 50000 });
  const counts = new Map();
  for (const s of sessions) {
    if (!statuses.includes(s.status)) continue;
    for (const code of s.decisionReason?.reasonCodes || []) {
      counts.set(code, (counts.get(code) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([reasonCode, count]) => ({ reasonCode, count }))
    .sort((a, b) => b.count - a.count);
}

/** Failed webhook report (PRD). */
async function webhookFailures(scopedDb) {
  const deliveries = await scopedDb.webhookDeliveries.list({ status: { in: ["failed", "exhausted"] } });
  return deliveries.map((d) => ({
    eventId: d.eventUid,
    event: d.event,
    status: d.status,
    attempts: d.attempts,
    lastStatusCode: d.lastStatusCode,
    lastError: d.lastError,
    createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null
  }));
}

/** Risk event report (PRD): audit entries flagged riskEvent, tenant-scoped. */
async function riskEvents(scopedDb, { days = 30 } = {}) {
  const { from } = rangeFilter(days);
  const rows = await scopedDb.auditLogs.list({ riskEvent: true, createdAt: { gte: from } });
  return rows.map(auditRow);
}

/** Audit log export (PRD), tenant-scoped. */
async function auditExport(scopedDb, { days = 30 } = {}) {
  const { from } = rangeFilter(days);
  const rows = await scopedDb.auditLogs.list({ createdAt: { gte: from } });
  return rows.map(auditRow);
}

function auditRow(a) {
  return {
    id: String(a.id),
    action: a.action,
    actorType: a.actorType,
    actorId: a.actorId,
    sessionId: a.sessionId != null ? String(a.sessionId) : null,
    ipAddress: a.ipAddress,
    riskEvent: Boolean(a.riskEvent),
    metadata: a.metadata || null,
    createdAt: a.createdAt ? new Date(a.createdAt).toISOString() : null
  };
}

/**
 * Compliance export per customer (PRD): full verification history —
 * sessions, scores, decisions, review notes, audit trail.
 */
async function customerHistory(scopedDb, customerReference) {
  const sessions = await scopedDb.sessions.list({ customerReference });
  if (!sessions.length) throw new AppError("NOT_FOUND", "No sessions for this customer reference");
  const db = getDb();

  const items = await Promise.all(sessions.map(async (s) => {
    const result = await scopedDb.results.latestForSession(s.id);
    const notes = await db.manualReviewNote.findMany({ where: { sessionId: s.id } });
    return {
      sessionId: s.sessionUid,
      status: s.status,
      riskLevel: s.riskLevel,
      reasonCodes: s.decisionReason?.reasonCodes || [],
      isLive: Boolean(s.isLive),
      createdAt: s.createdAt ? new Date(s.createdAt).toISOString() : null,
      completedAt: s.completedAt ? new Date(s.completedAt).toISOString() : null,
      scores: result ? {
        liveness: result.livenessScore != null ? Number(result.livenessScore) : null,
        faceMatch: result.faceMatchScore != null ? Number(result.faceMatchScore) : null,
        ocrConfidence: result.ocrConfidence != null ? Number(result.ocrConfidence) : null
      } : null,
      extractedData: result?.extractedData || null, // null after biometric deletion
      reviewNotes: notes.map((n) => ({
        decision: n.decision,
        note: n.note,
        userId: String(n.userId),
        createdAt: n.createdAt ? new Date(n.createdAt).toISOString() : null
      }))
    };
  }));

  return { customerReference, sessionCount: items.length, sessions: items };
}

/**
 * Per-month usage for metering/billing. "billable" = sessions that reached a
 * decision (approved/rejected/manual_review) — created-but-abandoned sessions
 * consumed no provider compute and are broken out separately.
 */
async function usageSummary(scopedDb, { months = 6 } = {}) {
  const n = Math.min(Math.max(Number(months) || 6, 1), 24);
  const since = new Date();
  since.setMonth(since.getMonth() - (n - 1));
  since.setDate(1);
  since.setHours(0, 0, 0, 0);
  const BILLABLE = ["approved", "rejected", "manual_review"];
  const sessions = await scopedDb.sessions.list({ createdAt: { gte: since } }, { take: 50000 });
  const byMonth = new Map();
  for (const s of sessions) {
    const key = new Date(s.createdAt).toISOString().slice(0, 7); // YYYY-MM
    if (!byMonth.has(key)) {
      byMonth.set(key, { month: key, total: 0, billable: 0, approved: 0, rejected: 0, manual_review: 0, failed: 0, byType: {} });
    }
    const m = byMonth.get(key);
    m.total++;
    if (BILLABLE.includes(s.status)) m.billable++;
    if (m[s.status] != null && typeof m[s.status] === "number") m[s.status]++;
    const t = s.verificationType || "ID_AND_FACE";
    m.byType[t] = (m.byType[t] || 0) + 1;
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Raw per-session score rows for FAR/FRR threshold calibration (skill §26.3).
 * Genuine/impostor pools are separated OFFLINE by the analyst; scores are only
 * comparable within one modelVersion — group by it before aggregating.
 */
async function scoreDistribution(scopedDb, { days = 90 } = {}) {
  const { from } = rangeFilter(days);
  const sessions = await scopedDb.sessions.list(
    { createdAt: { gte: from } },
    { orderBy: { createdAt: "desc" }, take: 5000 }
  );
  const rows = [];
  for (const s of sessions) {
    const r = await scopedDb.results.latestForSession(s.id);
    if (!r) continue;
    rows.push({
      sessionId: s.sessionUid,
      verificationType: s.verificationType || "ID_AND_FACE",
      status: s.status,
      riskLevel: s.riskLevel || null,
      livenessScore: r.livenessScore != null ? Number(r.livenessScore) : null,
      faceMatchScore: r.faceMatchScore != null ? Number(r.faceMatchScore) : null,
      ocrConfidence: r.ocrConfidence != null ? Number(r.ocrConfidence) : null,
      modelVersion: r.rawResult?.modelVersion ?? null,
      pipelineVersion: r.rawResult?.pipelineVersion ?? null,
      createdAt: s.createdAt ? new Date(s.createdAt).toISOString() : null
    });
  }
  return rows;
}

module.exports = { dailyVolume, topReasons, webhookFailures, riskEvents, auditExport, customerHistory, usageSummary, scoreDistribution };
