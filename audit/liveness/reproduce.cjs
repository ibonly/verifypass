"use strict";
// Desired-behaviour regressions for audit findings L01–L13 and L16 (converted
// from the 2026-09-06 diagnostic reproductions, which asserted the DEFECTS).
// Each block now asserts the corrected behaviour and the script exits non-zero
// on any regression. No network / real DB / real model; synthetic buffers.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const shared = require("../../backend/shared/src");
const { runVerification } = require("../../backend/src/worker/pipeline");
const { createMockDb } = require("../../backend/tests/helpers/mockDb");
const { VerifyPassClient } = require("../../frontend/sdk/core/src/client");
const config = require("../../backend/src/config");
const findings = [];
function proof(id, evidence) { findings.push({ id, evidence }); }
const now = Date.now();
const ch = actions => ({ actions, nonce: "audit-nonce", issuedAt: new Date(now).toISOString() });
const frame = (action, i, extra = {}) => ({ action, checksum: `checksum-${i}`, captureMode: "auto", liveness: { score: .95, faceCount: 1 }, pose: { yaw: 20, pitch: 15 }, createdAt: new Date(now + i * 100), ...extra });
const verify = (actions, frames) => shared.verifyLivenessChallenge(ch(actions), frames, shared.DEFAULT_THRESHOLDS, { enforcePose: true, now: () => now });
(async () => {
  let r = verify(["blink"], [frame("blink", 0)]);
  assert.equal(r.evidenceInsufficient, true); assert.notEqual(shared.decide({ livenessChallenge: r }).status, "approved");
  assert.ok(Array.from({ length: 50 }, () => shared.generateLivenessChallenge().actions).every(a => !a.includes("blink") && !a.includes("open_mouth")));
  proof("L01", "Blink without expression evidence is evidenceInsufficient → review; expressions are not issued unless the provider supports landmarks.");
  r = verify(["turn_left", "turn_right"], [frame("turn_left", 0), frame("turn_left", 2), frame("turn_right", 1), frame("turn_right", 3)]);
  assert.equal(r.directionInconsistent, true); assert.equal(r.evidenceInsufficient, true);
  assert.notEqual(shared.decide({ livenessChallenge: r }).status, "approved");
  assert.ok(shared.verifyLivenessChallenge(ch(["turn_left", "turn_right"]), [frame("turn_left", 0), frame("turn_left", 2), frame("turn_right", 1), frame("turn_right", 3)], shared.DEFAULT_THRESHOLDS, { enforcePose: true, enforceConsistency: true, now: () => now }).reasonCodes.includes("LIVENESS_DIRECTION_INCONSISTENT"));
  proof("L02/L03", "Same-sign turns are reviewed by default and rejected when consistency is enforced; two frames per action is insufficient evidence.");
  r = verify(["turn_left"], [frame("turn_left", 0, { pose: { yaw: 0 } }), frame("turn_left", 1, { liveness: { score: 0, faceCount: 1 }, pose: { yaw: 25 } })]);
  assert.equal(r.ok, false);
  proof("L04", "A frontal live frame cannot vouch for a zero-liveness turned frame — pose is judged on frames that clear the spoof floor.");
  assert.equal(shared.decide({ selfie: { faceCount: 1 }, liveness: { score: NaN } }).status, "rejected");
  assert.equal(shared.decide({ selfie: { faceCount: 1 }, liveness: { score: .95 }, livenessIdentity: { score: null, error: "provider unavailable" } }).status, "manual_review");
  proof("L05/L06", "NaN passive score rejects; unavailable identity routes to review.");
  assert.throws(() => shared.generateLivenessChallenge({ excludeActions: ["turn_left", "turn_right", "look_up", "look_down"] }), /no verifiable/);
  proof("L07", "Excluding every head movement throws instead of issuing an expression-only or empty challenge.");
  assert.equal(shared.isChallengeFresh({ issuedAt: new Date(now + 86400000).toISOString() }, { now: () => now }), false);
  proof("L08", "A challenge issued in the future is not fresh.");
  const seq = shared.FLASH.palette.slice(0, 4);
  assert.equal(shared.validFlashSequence(seq), true);
  proof("L09", "Flash sequences are server-issued (challenge.flashSequence); the upload rejects any other sequence and the worker verifies HMAC, dimensions and per-tile identity before scoring (see pipeline scenario below).");
  let body;
  const client = new VerifyPassClient({ baseUrl: "https://example.invalid", sessionId: "vps_audit", sdkToken: "sdk_audit", fetchImpl: async (_, opts) => { body = JSON.parse(opts.body); return { ok: true, json: async () => ({ success: true }) }; } });
  await client.uploadLivenessFrame("blink", "dummy");
  assert.equal(body.captureMode, "unknown");
  proof("L10", "Two-argument uploadLivenessFrame reports captureMode 'unknown' (server treats it as manual → review), never 'auto'.");

  // Production-mode pipeline with a realistic burst: 3 distinct frames per
  // action, opposite-signed yaw starting near frontal, v2 binding, attemptId.
  async function pipelineScenario({ selfieScore = .95, enforceFlash = false, identityError = false, resultError = false, attemptRace = false, deps: extraDeps = {} } = {}) {
    const db = createMockDb();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vp-liveness-audit-"));
    const key = crypto.randomBytes(32);
    const attemptId = "att-A";
    try {
      const tenant = await db.tenant.create({ data: { tenantUid: "tnt_audit", status: "active", settings: { challenge: { enforceFlash } } } });
      const session = await db.verificationSession.create({ data: { tenantId: tenant.id, sessionUid: "vps_audit", status: "submitted", verificationType: "FACE_ONLY", isLive: false, attemptId, submittedAt: new Date(now + 20000), livenessChallenge: ch(["turn_left", "turn_right"]) } });
      let n = 0;
      async function add(fileType, label, plainObj, createdAt) {
        const plain = Buffer.from(JSON.stringify({ ...plainObj, n: ++n }));
        const checksum = crypto.createHash("sha256").update(plain).digest("hex");
        const storagePath = path.join(dir, `${n}.enc`);
        await fs.writeFile(storagePath, shared.encryptBuffer(plain, key));
        const mode = fileType === "liveness_frame" ? "auto" : null;
        await db.evidenceFile.create({ data: { sessionId: session.id, fileType, label, attemptId, challengeNonce: "audit-nonce", captureMode: mode, storagePath, checksum, encrypted: true, createdAt, bindingHmac: shared.computeFrameBinding(config.sdkTokenSecret, "audit-nonce", label || fileType, checksum, [session.tenantId, session.id, attemptId, fileType, mode, null]) } });
      }
      await add("selfie", null, { score: selfieScore }, new Date(now + 1000));
      let t = 5000;
      for (const action of ["turn_left", "turn_right"]) { for (const yaw of [0, 10, 20]) { await add("liveness_frame", action, { pose: { yaw: action === "turn_left" ? -yaw : yaw, pitch: 0 } }, new Date(now + t)); t += 400; } t += 1500; }
      let moved = false;
      const provider = { name: "stub",
        checkLiveness: async buf => { let d = {}; try { d = JSON.parse(buf.toString()); } catch (_) {} if (attemptRace && !moved) { moved = true; await db.verificationSession.update({ where: { id: session.id }, data: { status: "submitted", attemptId: "att-B", livenessChallenge: { ...ch(["look_down"]), nonce: "attempt-B" } } }); } return { score: d.score ?? .95, faceCount: 1, pose: d.pose || null, raw: {} }; },
        compareFaces: async () => { if (identityError) throw new Error("simulated identity outage"); return { score: .99, idFaceFound: true }; } };
      if (resultError) db.verificationResult.create = async () => { throw new Error("simulated result write failure"); };
      const deps = { db, provider, evidenceKey: key, env: "production", screen: async () => ({ hit: false }), ...extraDeps };
      let out = null, error = null;
      try { out = await runVerification({ sessionUid: session.sessionUid, attemptId }, deps); } catch (e) { error = e.message; }
      const stored = await db.verificationSession.findFirst({ where: { id: session.id } });
      return { out, error, status: stored.status, attempt: stored.attemptId, results: db.verificationResult.rows.length, result: db.verificationResult.rows[0] || null, outbox: db.outbox.rows.map(r => r.status) };
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
  const validated = process.env.LIVENESS_VALIDATED_POLICY;
  process.env.LIVENESS_VALIDATED_POLICY = require("../../backend/src/lib/release").policyVersion;
  try {
    let p = await pipelineScenario();
    assert.equal(p.out.status, "approved", JSON.stringify(p.out));
    proof("baseline", "A genuine burst (3 distinct frames per action, opposite-signed yaw) approves in production with the policy declared validated.");
    p = await pipelineScenario({ selfieScore: .01 });
    assert.notEqual(p.out.status, "approved"); assert.equal(p.out.status, "manual_review"); assert.ok(p.out.reasonCodes.includes("LIVENESS_BORDERLINE")); assert.equal(p.result.livenessScore, .01);
    proof("L11", "Selfie 0.01 with 0.95 frontal frames is contradictory evidence → manual review, never approval; the persisted score is the selfie's.");
    p = await pipelineScenario({ enforceFlash: true });
    assert.equal(p.out.status, "manual_review"); assert.ok(p.out.reasonCodes.includes("LIVENESS_FLASH_UNVERIFIED")); assert.equal(p.result.rawResult.liveness.flash.enforced, true);
    proof("L12", "enforceFlash with no mosaic keeps enforced:true and routes to review.");
    p = await pipelineScenario({ identityError: true });
    assert.equal(p.out.status, "manual_review"); assert.ok(p.out.reasonCodes.includes("LIVENESS_IDENTITY_UNAVAILABLE"));
    proof("L06", "Identity comparison failure routes to review, never approval.");
    p = await pipelineScenario({ resultError: true });
    assert.match(p.error, /simulated result/); assert.equal(p.status, "submitted"); assert.equal(p.results, 0); assert.deepEqual(p.outbox, []);
    proof("L13", "Result write failure rolls back the status CAS, audit and outbox; the session stays submitted for retry.");
    p = await pipelineScenario({ attemptRace: true });
    assert.equal(p.out.skipped, true); assert.equal(p.results, 0); assert.equal(p.attempt, "att-B"); assert.equal(p.status, "submitted");
    proof("L16", "A worker holding attempt A evidence cannot finalize attempt B submitted during inference.");
  } finally { if (validated === undefined) delete process.env.LIVENESS_VALIDATED_POLICY; else process.env.LIVENESS_VALIDATED_POLICY = validated; }
  const results = { date: new Date().toISOString(), mode: "desired-behaviour regressions", proofs: findings.length, findings };
  await fs.writeFile(path.join(__dirname, "reproduction-results.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify(results, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });
