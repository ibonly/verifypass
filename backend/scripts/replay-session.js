"use strict";
// Replay a stored session through the CURRENT worker code without writing
// anything: loads the session, tenant and evidence rows from the database,
// mirrors them into the in-memory mock database used by the test suite, and
// runs runVerification with the real provider against the real encrypted
// evidence files. Prints the decision and the liveness diagnostics so
// threshold changes can be evaluated on captured sessions before a deploy.
//
//   node scripts/replay-session.js vps_... [vps_...]      # one or more sessions
//   node scripts/replay-session.js --since 2026-09-06     # every submitted/terminal session since a date
//   node scripts/replay-session.js --json ...             # machine-readable output
//
// Only the current attempt's evidence is replayed (rows carrying the session's
// attemptId, or every row for legacy sessions). Nothing is persisted.
require("../src/env");
const { getDb } = require("../src/lib/db");
const { createMockDb } = require("../tests/helpers/mockDb");
const { runVerification, defaultEvidenceKey, PIPELINE_VERSION } = require("../src/worker/pipeline");
const { createProviderForLambda } = require("../worker");
const config = require("../src/config");

async function replayOne(db, provider, session) {
  const tenant = await db.tenant.findFirst({ where: { id: session.tenantId } });
  const evidence = await db.evidenceFile.findMany({ where: { sessionId: session.id, ...(session.attemptId ? { attemptId: session.attemptId } : {}) } });
  const mock = createMockDb();
  const t = await mock.tenant.create({ data: { ...tenant, id: tenant.id } });
  // Legacy sessions have no submittedAt; freshness is judged at the time the
  // last evidence arrived (queue latency never counted against the user).
  const lastEvidenceAt = evidence.reduce((m, e) => (e.createdAt > m ? e.createdAt : m), new Date(0));
  const submittedAt = session.submittedAt || (lastEvidenceAt.getTime() ? lastEvidenceAt : session.completedAt) || new Date();
  const s = await mock.verificationSession.create({ data: { ...session, id: session.id, tenantId: t.id, status: "submitted", submittedAt, completedAt: null, decisionReason: null } });
  for (const e of evidence) await mock.evidenceFile.create({ data: { ...e, id: e.id, sessionId: s.id } });
  const out = await runVerification({ sessionUid: session.sessionUid, attemptId: session.attemptId || undefined, policyVersion: PIPELINE_VERSION }, {
    db: mock, provider, evidenceKey: defaultEvidenceKey(config), env: process.env.NODE_ENV || "development", screen: async () => ({ hit: false })
  });
  const r = mock.verificationResult.rows[0];
  return { session, out, result: r, evidence: evidence.length };
}

function summarise({ session, out, result }) {
  const rr = result?.rawResult || {}; const lc = rr.livenessChallenge; const lv = rr.liveness;
  const per = Object.fromEntries(Object.entries(lc?.perAction || {}).map(([a, p]) => [a, { poseOk: p.poseOk, peakYaw: p.peakYaw, peakPitch: p.peakPitch, sign: p.yawSign ?? p.pitchSign ?? null, traj: p.trajectoryChecked ? p.trajectoryOk : null, rigidity: p.rigidity ? { ok: p.rigidity.ok, residual: p.rigidity.maxResidual, motion: p.rigidity.motion } : null, score: p.score }]));
  return {
    session: session.sessionUid, storedStatus: session.status, storedCodes: session.decisionReason?.reasonCodes || [],
    replay: out.status || out.reason, replayCodes: out.reasonCodes || [],
    liveness: lv ? { selfie: lv.score, decision: lv.decisionScore, frontalFrames: lv.passiveAggregate?.frameScores || [] } : null,
    identity: rr.livenessIdentity ? { score: rr.livenessIdentity.score, min: rr.livenessIdentity.min, frames: rr.livenessIdentity.frames, considered: rr.livenessIdentity.considered, reason: rr.livenessIdentity.reason || rr.livenessIdentity.error } : null,
    challenge: lc ? { ok: lc.ok, codes: lc.reasonCodes, consistency: lc.consistency?.ok, directionInconsistent: lc.directionInconsistent, sequence: lc.sequence && { ok: lc.sequence.ok, spans: lc.sequence.actions }, motionUnverified: lc.motionUnverified, evidenceInsufficient: lc.evidenceInsufficient, flat: lc.flatObject, perAction: per } : null,
    flash: lv?.flash ? { ok: lv.flash.ok, reason: lv.flash.reason } : null
  };
}

(async () => {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const sinceIdx = args.indexOf("--since");
  const db = getDb();
  try {
    let sessions;
    if (sinceIdx >= 0) {
      sessions = await db.verificationSession.findMany({ where: { createdAt: { gte: new Date(args[sinceIdx + 1]) }, status: { in: ["submitted", "approved", "rejected", "manual_review", "failed"] } }, orderBy: { createdAt: "asc" } });
    } else {
      const uids = args.filter(a => a.startsWith("vps_"));
      if (!uids.length) throw new Error("Usage: node scripts/replay-session.js <sessionUid…> | --since <date> [--json]");
      sessions = await db.verificationSession.findMany({ where: { sessionUid: { in: uids } } });
    }
    if (!sessions.length) throw new Error("No matching sessions");
    const provider = createProviderForLambda();
    const rows = [];
    for (const session of sessions) {
      try { rows.push(summarise(await replayOne(db, provider, session))); }
      catch (err) { rows.push({ session: session.sessionUid, storedStatus: session.status, error: err.message }); }
    }
    if (json) console.log(JSON.stringify({ pipeline: PIPELINE_VERSION, rows }, null, 2));
    else for (const r of rows) {
      console.log(`\n${r.session}  stored=${r.storedStatus} [${(r.storedCodes || []).join(",")}]  →  replay=${r.replay} [${(r.replayCodes || []).join(",")}]${r.error ? "  ERROR " + r.error : ""}`);
      if (r.liveness) console.log(`  liveness selfie=${r.liveness.selfie?.toFixed?.(3)} decision=${r.liveness.decision?.toFixed?.(3)} frontalFrames=${JSON.stringify(r.liveness.frontalFrames.map(v => +v.toFixed(2)))}`);
      if (r.identity) console.log(`  identity best=${r.identity.score?.toFixed?.(3) ?? "-"} min=${r.identity.min ?? "-"} frames=${r.identity.frames ?? 0}/${r.identity.considered ?? "-"}${r.identity.reason ? " " + r.identity.reason : ""}`);
      if (r.challenge) { console.log(`  challenge ok=${r.challenge.ok} codes=${JSON.stringify(r.challenge.codes)} consistency=${r.challenge.consistency} directionInconsistent=${r.challenge.directionInconsistent} sequence=${JSON.stringify(r.challenge.sequence)} motionUnverified=${r.challenge.motionUnverified} evidenceInsufficient=${r.challenge.evidenceInsufficient} flat=${r.challenge.flat}`); for (const [a, p] of Object.entries(r.challenge.perAction)) console.log(`    ${a.padEnd(10)} ${JSON.stringify(p)}`); }
      if (r.flash) console.log(`  flash ${JSON.stringify(r.flash)}`);
    }
  } finally { await db.$disconnect(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
