"use strict";

// Telemetry-driven anomaly scoring (roadmap Tier 0.5). Nightly job.
//
// The widget records, per challenge action, how long the user took to start
// the movement (msToTrigger), which coaching hints fired, how many frames
// were taken and in which mode. Humans are slow and variable; scripts,
// injected video and replay rigs are fast and identical. With no new model
// we fit robust statistics (median / MAD) per tenant and action over the
// last window and flag sessions in the extreme tails:
//
//   instant        — an action "triggered" < INSTANT_MS after the instruction
//   too_fast       — ≥2 actions below max(median − K·MAD, ¼ median) and
//                    below 700 ms (needs MIN_SAMPLES per tenant+action)
//   uniform        — all actions triggered within ±UNIFORM_MS of each other
//                    AND none was coached (humans vary between movements)
//   duplicate      — another session in the window has the same timing
//                    vector (every action within ±10 ms) — a replay rig, or
//                    the same script driving many sessions
//   device_uniform — one device fingerprint with ≥ DEVICE_MIN sessions whose
//                    mean time-to-trigger varies < DEVICE_CV (coefficient of
//                    variation) — an automated farm on one machine
//
// Output is a SOFT signal: an audited `telemetry.anomaly` risk event per
// flagged session and `rawResult.riskSignals.telemetryAnomaly` on the
// session's result row. It never changes a decision on its own; reviewers
// and the calibration script consume it.

const DEFAULTS = Object.freeze({
  windowDays: 14,
  instantMs: 300,
  minSamples: 20,   // per tenant+action before median/MAD are trusted
  madK: 3,
  fastFloorMs: 700, // too_fast additionally requires the value below this
  fastFraction: 0.25, // …and below this fraction of the tenant's median
  uniformMs: 60,
  duplicateMs: 10, // two sessions whose every action triggered within this of each other
  deviceMin: 3,
  deviceCv: 0.08
});

function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function mad(a, med) { if (!a.length) return null; return median(a.map((v) => Math.abs(v - med))); }

/** Usable auto-mode trigger timings of one session: [{action, ms, hints}] */
function sessionTimings(session) {
  const tel = session && session.deviceMeta && session.deviceMeta.telemetry;
  if (!tel || !Array.isArray(tel.actions)) return [];
  return tel.actions
    .filter((a) => a && Number.isFinite(a.msToTrigger) && a.msToTrigger >= 0 && (a.mode === "auto" || a.mode == null))
    .map((a) => ({ action: a.action, ms: a.msToTrigger, hints: Array.isArray(a.hints) ? a.hints.length : 0 }));
}

/** Per tenant+action robust stats from a list of sessions. */
function fitStats(sessions) {
  const buckets = new Map();
  for (const s of sessions) {
    for (const t of sessionTimings(s)) {
      const k = `${s.tenantId}|${t.action}`;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(t.ms);
    }
  }
  const stats = {};
  for (const [k, arr] of buckets) {
    const med = median(arr);
    stats[k] = { n: arr.length, median: med, mad: mad(arr, med) };
  }
  return stats;
}

/**
 * Pure analysis: sessions (with tenantId, id/sessionUid, deviceFingerprint,
 * deviceMeta.telemetry) → per-session findings + fitted stats.
 */
function analyzeTelemetry(sessions, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const stats = fitStats(sessions);
  const vectors = new Map(); // timing vector → session ids
  const byDevice = new Map();
  const per = [];
  const bySession = new Map();

  for (const s of sessions) {
    const t = sessionTimings(s);
    if (!t.length) continue;
    const flags = [];
    const detail = {};
    const instant = t.filter((x) => x.ms < o.instantMs);
    if (instant.length) { flags.push("instant"); detail.instant = instant.map((x) => x.action); }

    let fast = 0;
    for (const x of t) {
      const st = stats[`${s.tenantId}|${x.action}`];
      if (!st || st.n < o.minSamples || st.mad == null) continue;
      // robust lower tail; with a wide human spread the MAD floor drops below
      // zero, so a quarter of the typical time is the practical floor
      const floor = Math.max(st.median - o.madK * 1.4826 * st.mad, st.median * o.fastFraction);
      if (x.ms < floor && x.ms < o.fastFloorMs) fast++;
    }
    if (fast >= 2) { flags.push("too_fast"); detail.tooFast = fast; }

    if (t.length >= 3) {
      const ms = t.map((x) => x.ms);
      const spread = Math.max(...ms) - Math.min(...ms);
      const coached = t.some((x) => x.hints > 0);
      if (spread <= o.uniformMs && !coached) { flags.push("uniform"); detail.spreadMs = spread; }
    }

    const key = `${s.tenantId}|` + t.map((x) => x.action).join(",");
    if (t.length >= 2) {
      if (!vectors.has(key)) vectors.set(key, []);
      vectors.get(key).push({ s, ms: t.map((x) => x.ms) });
    }
    if (s.deviceFingerprint) {
      const dk = `${s.tenantId}|${s.deviceFingerprint}`;
      if (!byDevice.has(dk)) byDevice.set(dk, []);
      byDevice.get(dk).push({ s, mean: t.reduce((a, x) => a + x.ms, 0) / t.length });
    }
    const entry = { session: s, flags, detail, key };
    per.push(entry); bySession.set(s, entry);
  }

  // duplicate timing vectors across sessions: same tenant + action sequence,
  // every action within ±duplicateMs. Sorted by the first timing so only a
  // sliding window is compared (n log n, not n²).
  const dups = new Map(); // session → [peer uids]
  for (const [, rows] of vectors) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => a.ms[0] - b.ms[0]);
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < Math.min(rows.length, i + 65) && rows[j].ms[0] - rows[i].ms[0] <= o.duplicateMs; j++) {
        const a = rows[i].ms, b = rows[j].ms;
        let close = true;
        for (let k = 0; k < a.length; k++) if (Math.abs(a[k] - b[k]) > o.duplicateMs) { close = false; break; }
        if (!close) continue;
        for (const [x, y] of [[rows[i].s, rows[j].s], [rows[j].s, rows[i].s]]) {
          if (!dups.has(x)) dups.set(x, []);
          if (dups.get(x).length < 10) dups.get(x).push(y.sessionUid || y.id);
        }
      }
    }
  }
  for (const p of per) {
    const peers = dups.get(p.session);
    if (peers) { p.flags.push("duplicate"); p.detail.duplicates = [...new Set(peers)].slice(0, 10); }
  }
  // device farms: many sessions, near-identical mean timing
  for (const [, rows] of byDevice) {
    if (rows.length < o.deviceMin) continue;
    const means = rows.map((r) => r.mean);
    const mu = means.reduce((a, b) => a + b, 0) / means.length;
    if (!(mu > 0)) continue;
    const sd = Math.sqrt(means.reduce((a, b) => a + (b - mu) ** 2, 0) / means.length);
    const cv = sd / mu;
    if (cv < o.deviceCv) {
      for (const r of rows) {
        const p = bySession.get(r.s);
        if (p) { p.flags.push("device_uniform"); p.detail.deviceSessions = rows.length; p.detail.deviceCv = Number(cv.toFixed(3)); }
      }
    }
  }

  return {
    stats,
    findings: per.filter((p) => p.flags.length).map((p) => ({
      sessionId: p.session.id, sessionUid: p.session.sessionUid, tenantId: p.session.tenantId,
      flags: [...new Set(p.flags)], detail: p.detail
    }))
  };
}

/**
 * Job body: load recent sessions with telemetry, analyse, write the soft
 * signal. Idempotent — a session already carrying the same flag set is
 * skipped (audit rows are append-only).
 */
async function runTelemetryAnomaly(db, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const since = new Date(Date.now() - o.windowDays * 24 * 3600 * 1000);
  const sessions = await db.verificationSession.findMany({ where: { createdAt: { gte: since }, ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) }, orderBy: { createdAt: "desc" }, take: 5000 });
  const tenantCounts = new Map();
  const withTel = sessions.filter(s => {
    const count = tenantCounts.get(s.tenantId) || 0;
    if (count >= 1000 || !sessionTimings(s).length) return false;
    tenantCounts.set(s.tenantId, count + 1); return true;
  });
  const sources = new Map(withTel.map(s => [s.id, s]));
  const { findings, stats } = analyzeTelemetry(withTel, o);
  let written = 0;
  for (const f of findings) {
    const source = sources.get(f.sessionId);
    const key = require("crypto").createHash("sha256").update(JSON.stringify([f.sessionId, source?.attemptId || "legacy", f.flags])).digest("hex");
    const changed = await require("../services/atomic").transaction(db, async tx => {
      if (await tx.analysisReceipt.findFirst({ where: { key } })) return false;
      await tx.analysisReceipt.create({ data: { key } });
      const result = await tx.verificationResult.findFirst({ where: { sessionId: f.sessionId, ...(source?.attemptId ? { attemptId: source.attemptId } : {}) }, orderBy: { createdAt: "desc" } });
      const signal = { flags: f.flags, detail: f.detail, at: new Date().toISOString() };
      if (result) {
        const raw = { ...(result.rawResult || {}) };
        raw.riskSignals = { ...(raw.riskSignals || {}), telemetryAnomaly: signal };
        await tx.verificationResult.update({ where: { id: result.id }, data: { rawResult: raw } });
      }
      await tx.auditLog.create({ data: { tenantId: f.tenantId, sessionId: f.sessionId, actorType: "system", actorId: "telemetry_anomaly", action: "telemetry.anomaly", metadata: signal, riskEvent: true } });
      return true;
    }).catch(err => { if (err.code === "P2002") return false; throw err; });
    if (changed) written++;
  }
  return { sampled: true, maxSessions: 5000, maxPerTenant: 1000, duplicateNeighbourWindow: 64, duplicateLinkCap: 10, analysed: withTel.length, flagged: findings.length, written, actionsFitted: Object.keys(stats).length };
}

module.exports = { analyzeTelemetry, runTelemetryAnomaly, sessionTimings, fitStats, TELEMETRY_ANOMALY_DEFAULTS: DEFAULTS };
