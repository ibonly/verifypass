"use strict";

// Threshold calibration from REAL sessions (v5 C1).
//
//   node scripts/calibrate-thresholds.js [--tenant tnt_xxx] [--days 30] [--json]
//
// Ground truth: a session counts as GENUINE when a reviewer approved it or it
// was auto-approved and never disputed; IMPOSTOR when a reviewer rejected it or
// it was rejected with a fraud/binding/screening code. Sessions still in
// review are excluded. For each score (passive liveness, face match, active
// challenge aggregate) the script prints the score distribution per class,
// FAR/FRR at candidate thresholds, and a recommended reject / review / pass
// band: reject at the threshold where FAR ≤ 0.5 %, pass where FRR ≤ 2 %, with
// the band between routed to manual review. Group by model version — scores
// from different model containers are not comparable (v2 §4.2).
//
// This prints recommendations; it never writes tenant settings.

const { getDb } = require("../src/lib/db");

const FRAUD_CODES = new Set([
  "LIVENESS_FRAME_BINDING_FAILED", "LIVENESS_DIRECTION_INCONSISTENT", "LIVENESS_CHALLENGE_SEQUENCE_INVALID",
  "DEVICE_SHARED_ACROSS_IDENTITIES", "CAPTURE_INTEGRITY_RISK", "SANCTIONS_PEP_MATCH", "LIVENESS_IDENTITY_MISMATCH"
]);

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  return { tenant: get("--tenant", null), days: Number(get("--days", 30)), json: a.includes("--json") };
}

function quantiles(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null;
  return { n: s.length, min: s[0] ?? null, p5: q(0.05), p25: q(0.25), median: q(0.5), p75: q(0.75), p95: q(0.95), max: s[s.length - 1] ?? null };
}

/** FAR = impostors accepted at threshold t; FRR = genuines rejected at t (score >= t accepts). */
function rates(genuine, impostor, t) {
  const far = impostor.length ? impostor.filter((s) => s >= t).length / impostor.length : null;
  const frr = genuine.length ? genuine.filter((s) => s < t).length / genuine.length : null;
  return { t, far, frr };
}

function recommend(genuine, impostor) {
  if (genuine.length < 30 || impostor.length < 10) {
    return { note: `insufficient data (genuine ${genuine.length}, impostor ${impostor.length}); need ≥30 genuine and ≥10 impostor` };
  }
  const grid = []; for (let t = 0.3; t <= 0.98; t += 0.01) grid.push(+t.toFixed(2));
  const table = grid.map((t) => rates(genuine, impostor, t));
  // reject: lowest t with FAR <= 0.5%   pass: lowest t with FRR <= 2% but never below reject
  const reject = table.find((r) => r.far !== null && r.far <= 0.005)?.t ?? null;
  let pass = table.filter((r) => r.frr !== null && r.frr <= 0.02).map((r) => r.t).pop() ?? null;
  if (reject !== null && pass !== null && pass < reject) pass = reject;
  const eer = table.reduce((best, r) => (r.far !== null && r.frr !== null && Math.abs(r.far - r.frr) < Math.abs(best.far - best.frr) ? r : best), table[0]);
  return { preliminary: true, note: "Reviewer labels are proxies; validate on an independently labeled held-out dataset before deployment. These empirical rates are not certified error bounds.", reject, pass, eer: { t: eer.t, far: +eer.far.toFixed(4), frr: +eer.frr.toFixed(4) }, table: table.filter((_, i) => i % 5 === 0) };
}

async function main() {
  const { tenant, days, json } = parseArgs();
  const db = getDb();
  const since = new Date(Date.now() - days * 86400 * 1000);
  const where = { createdAt: { gte: since }, status: { in: ["approved", "rejected"] } };
  if (tenant) {
    const t = await db.tenant.findFirst({ where: { tenantUid: tenant } });
    if (!t) throw new Error(`tenant ${tenant} not found`);
    where.tenantId = t.id;
  }
  const sessions = await db.verificationSession.findMany({ where });
  const ids = sessions.map((s) => s.id);
  const results = await db.verificationResult.findMany({ where: { sessionId: { in: ids } } });
  const notes = await db.manualReviewNote.findMany({ where: { sessionId: { in: ids } } });
  const latestResult = new Map();
  for (const r of results.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))) latestResult.set(r.sessionId, r);
  const reviewerDecision = new Map();
  for (const n of notes.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))) if (n.decision) reviewerDecision.set(n.sessionId, n.decision);

  const groups = new Map(); // modelVersion → { genuine: {liveness[], faceMatch[], challenge[]}, impostor: {...} }
  for (const s of sessions) {
    const r = latestResult.get(s.id); if (!r) continue;
    const codes = s.decisionReason?.reasonCodes || [];
    const rd = reviewerDecision.get(s.id);
    let cls = null;
    if (rd === "approved") cls = "genuine";
    else if (rd === "rejected") cls = "impostor";
    if (!cls) continue;
    const mv = r.rawResult?.modelVersion || "unknown";
    if (!groups.has(mv)) groups.set(mv, { genuine: { liveness: [], faceMatch: [], challenge: [] }, impostor: { liveness: [], faceMatch: [], challenge: [] } });
    const g = groups.get(mv)[cls];
    if (Number.isFinite(r.livenessScore)) g.liveness.push(Number(r.livenessScore));
    if (Number.isFinite(r.faceMatchScore)) g.faceMatch.push(Number(r.faceMatchScore));
    const agg = r.rawResult?.livenessChallenge?.aggregateScore;
    if (Number.isFinite(agg)) g.challenge.push(agg);
  }

  const out = { tenant: tenant || "(all)", days, sessionsConsidered: sessions.length, labeling: "reviewer-only; independent biometric ground truth still required", groups: {} };
  for (const [mv, g] of groups) {
    out.groups[mv] = {};
    for (const key of ["liveness", "faceMatch", "challenge"]) {
      out.groups[mv][key] = {
        genuine: quantiles(g.genuine[key]),
        impostor: quantiles(g.impostor[key]),
        recommendation: recommend(g.genuine[key], g.impostor[key])
      };
    }
  }
  if (json) { console.log(JSON.stringify(out, null, 2)); }
  else {
    console.log(`Calibration — tenant ${out.tenant}, last ${days} days, ${sessions.length} terminal sessions`);
    for (const [mv, g] of Object.entries(out.groups)) {
      console.log(`\n== model ${mv} ==`);
      for (const [key, v] of Object.entries(g)) {
        console.log(`  ${key}: genuine n=${v.genuine.n} median=${v.genuine.median} p5=${v.genuine.p5} | impostor n=${v.impostor.n} median=${v.impostor.median} p95=${v.impostor.p95}`);
        const r = v.recommendation;
        if (r.note) console.log(`    → ${r.note}`);
        else console.log(`    → reject < ${r.reject}, review ${r.reject}–${r.pass}, pass ≥ ${r.pass}   (EER at ${r.eer.t}: FAR ${r.eer.far}, FRR ${r.eer.frr})`);
      }
    }
    console.log("\nApply per tenant via settings.thresholds after review; re-run after every model upgrade.");
  }
  await db.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
