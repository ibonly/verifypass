"use strict";

// End-to-end pipeline test: real encryption, mock DB, stub provider.
// Encrypted files on disk → provider scores → decision → persisted outcome.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const { encryptBuffer } = require("@verifypass/shared");
const { createMockDb } = require("./helpers/mockDb");
const { runVerification } = require("../src/worker/pipeline");

const KEY = crypto.randomBytes(32);
// STRICT = the liveness auto-approve rule switched off (tenant knobs). The
// contracts below describe how each signal routes when nothing waives it;
// the default rule (score > autoApprove OR challenge passed → waive liveness
// quality codes) is covered by its own tests.
const STRICT = { thresholds: { liveness: { autoApprove: 1, challengePassApproves: false } } };

function stubProvider(overrides = {}) {
  return {
    name: "stub",
    checkLiveness: async (buf) => ({ pose: buf.toString("utf8", 0, 8) === '{"pose":' ? JSON.parse(buf.toString()).pose : null, score: 0.95, faceCount: 1, occluded: false, raw: {}, ...(overrides.liveness || {}) }),
    compareFaces: async () => ({ score: 0.9, idFaceFound: true, raw: {}, ...(overrides.faceMatch || {}) }),
    extractDocument: async () => ({
      available: true, ocrConfidence: 0.94,
      extractedData: { fullName: "ADEBAYO JOHN", documentNumber: "A12345678" },
      expired: false, raw: {}, ...(overrides.document || {})
    })
  };
}

async function seed({ settings = {}, withSelfie = true, withId = true, type = "ID_AND_FACE", withChallenge = false } = {}) {
  const db = createMockDb();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vp-pipe-"));
  const tenant = await db.tenant.create({ data: { tenantUid: "tnt_p", companyName: "P", status: "active", settings } });
  const session = await db.verificationSession.create({
    data: {
      sessionUid: "vps_PIPE1", tenantId: tenant.id, status: "submitted",
      verificationType: type, isLive: false,
      livenessChallenge: withChallenge ? { actions: ["turn_left"], nonce: "nonce" } : type === "ID_ONLY" ? null : { actions: ["turn_left", "turn_right"], nonce: "baseline", issuedAt: new Date(Date.now() - 10000).toISOString() }
    }
  });

  let fileNo = 0;
  async function addEvidence(fileType, extra = {}) {
    const p = path.join(dir, `${++fileNo}.enc`);
    const plain = extra.plain || (extra.checksum ? Buffer.from(extra.checksum.repeat(2000)) : crypto.randomBytes(2000));
    const checksum = crypto.createHash("sha256").update(plain).digest("hex");
    const row = { ...extra, checksum };
    delete row.plain;
    if (row.bindingHmac && row.bindingHmac !== "0".repeat(64)) row.bindingHmac = require("@verifypass/shared").computeFrameBinding(require("../src/config").sdkTokenSecret, row.challengeNonce, row.label, checksum);
    await fs.writeFile(p, encryptBuffer(plain, KEY));
    await db.evidenceFile.create({ data: { sessionId: session.id, fileType, storagePath: p, encrypted: true, ...row } });
  }
  if (!withChallenge && type !== "ID_ONLY") {
    let i = 0;
    for (const action of ["turn_left", "turn_right"]) for (const yaw of [0, 10, 20]) {
      await addEvidence("liveness_frame", { label: action, captureMode: "auto", challengeNonce: "baseline", bindingHmac: "auto", createdAt: new Date(Date.now() - 9000 + i++ * 500), plain: Buffer.from(JSON.stringify({ pose: { yaw: action === "turn_left" ? -yaw : yaw, pitch: 0 }, i })) });
    }
  }
  if (withId) await addEvidence("id_front");
  if (withSelfie) await addEvidence("selfie");

  return { db, tenant, session, addEvidence };
}

test("approved path: result persisted, session approved, webhook enqueued", async () => {
  const { db, session } = await seed();
  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider: stubProvider(), evidenceKey: KEY });

  assert.equal(out.status, "approved");

  const s = await db.verificationSession.findFirst({ where: { id: session.id } });
  assert.equal(s.status, "approved");
  assert.equal(s.riskLevel, "low");
  assert.ok(s.completedAt instanceof Date);

  const r = await db.verificationResult.findFirst({ where: { sessionId: session.id } });
  assert.equal(r.livenessScore, 0.95);
  assert.equal(r.livenessStatus, "passed");
  assert.equal(r.faceMatchStatus, "matched");
  assert.equal(r.documentStatus, "valid");
  assert.equal(r.extractedData.fullName, "ADEBAYO JOHN");

  const jobs = await db.jobQueue.findMany({ where: { type: "send_webhook" } });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].payload.event, "verification.approved");
  assert.equal(jobs[0].payload.sessionUid, "vps_PIPE1");
  assert.equal(jobs[0].payload.snapshot.serviceId, "vps_PIPE1");
  assert.ok(Array.isArray(jobs[0].payload.snapshot.selfieIds));
  assert.ok(jobs[0].payload.snapshot.selfieIds.length > 0);
  assert.equal(jobs[0].payload.snapshot.minimalPayload, true);
});

test("spoof: rejected with LIVENESS_FAILED, risk audit logged", async () => {
  const { db, session } = await seed();
  const out = await runVerification(
    { sessionUid: "vps_PIPE1" },
    { db, provider: stubProvider({ liveness: { score: 0.2 } }), evidenceKey: KEY }
  );
  assert.equal(out.status, "rejected");
  assert.ok(out.reasonCodes.includes("LIVENESS_FAILED"));

  const s = await db.verificationSession.findFirst({ where: { id: session.id } });
  assert.equal(s.riskLevel, "high");

  const audits = await db.auditLog.findMany({ where: { action: "verification.decided" } });
  assert.equal(audits[0].riskEvent, true);

  const jobs = await db.jobQueue.findMany({ where: { type: "send_webhook" } });
  assert.equal(jobs[0].payload.event, "verification.rejected");
});

test("borderline match: manual_review, no completedAt", async () => {
  const { db, session } = await seed();
  const out = await runVerification(
    { sessionUid: "vps_PIPE1" },
    { db, provider: stubProvider({ faceMatch: { score: 0.7 } }), evidenceKey: KEY }
  );
  assert.equal(out.status, "manual_review");

  const s = await db.verificationSession.findFirst({ where: { id: session.id } });
  assert.equal(s.completedAt, null);
  const r = await db.verificationResult.findFirst({ where: { sessionId: session.id } });
  assert.equal(r.faceMatchStatus, "review");
});

test("ID_ONLY: verifies WITHOUT a selfie — document-only signals", async () => {
  const { db, session } = await seed({ withSelfie: false, type: "ID_ONLY" });
  const provider = stubProvider();
  const calls = [];
  const orig = provider.checkLiveness;
  provider.checkLiveness = async (buf) => { calls.push("liveness"); return orig(buf); };

  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider, evidenceKey: KEY });
  assert.equal(out.status, "approved", `got ${out.reasonCodes}`);
  assert.equal(calls.length, 1, "liveness runs ONCE — on the document image only");

  const r = await db.verificationResult.findFirst({ where: { sessionId: session.id } });
  assert.equal(r.livenessScore, null);
  assert.equal(r.livenessStatus, null);
  assert.equal(r.faceMatchStatus, null);
  assert.equal(r.documentStatus, "valid");
  assert.equal(r.extractedData.fullName, "ADEBAYO JOHN");
});

test("ID_ONLY: ignores stored liveness challenge because no selfie is required", async () => {
  const { db, session } = await seed({ withSelfie: false, type: "ID_ONLY", withChallenge: true });

  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider: stubProvider(), evidenceKey: KEY });

  assert.equal(out.status, "approved", `got ${out.reasonCodes}`);
  assert.ok(!out.reasonCodes?.includes("LIVENESS_CHALLENGE_INCOMPLETE"));

  const r = await db.verificationResult.findFirst({ where: { sessionId: session.id } });
  assert.equal(r.rawResult.livenessChallenge, null);
});

test("legacy ID_ONLY session WITH a stored challenge must NOT reject INCOMPLETE", async () => {
  // Sessions created before the fix carry a liveness challenge they can never
  // complete (ID_ONLY has no liveness step). The pipeline must ignore it.
  const { db } = await seed({ withSelfie: false, type: "ID_ONLY" });
  await db.verificationSession.updateMany({
    where: { sessionUid: "vps_PIPE1" },
    data: { livenessChallenge: { version: 1, actions: ["smile", "turn_left"], nonce: "n", issuedAt: new Date().toISOString() } }
  });

  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider: stubProvider(), evidenceKey: KEY });
  assert.ok(!out.reasonCodes.includes("LIVENESS_CHALLENGE_INCOMPLETE"), `got ${out.reasonCodes}`);
  assert.equal(out.status, "approved");
});

test("ID_ONLY: live face submitted as the document → DOCUMENT_IS_LIVE_FACE (no selfie to cross-check)", async () => {
  const { db } = await seed({ withSelfie: false, type: "ID_ONLY" });
  const provider = stubProvider();
  provider.checkLiveness = async () => ({ score: 0.95, verdict: "Real", faceCount: 1, occluded: false, raw: {} });

  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider, evidenceKey: KEY });
  assert.equal(out.status, "manual_review");
  assert.ok(out.reasonCodes.includes("DOCUMENT_IS_LIVE_FACE"));
});

test("selfie submitted as 'ID front' → DOCUMENT_IS_LIVE_FACE manual_review", async () => {
  const { db, session } = await seed();
  const provider = stubProvider();
  // Both images are live-face captures: the liveness container returns "Real"
  // for the "document" too. A genuine card's printed portrait scores "Spoof".
  provider.checkLiveness = async () => ({ score: 0.95, verdict: "Real", faceCount: 1, occluded: false, raw: {} });

  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider, evidenceKey: KEY });
  assert.equal(out.status, "manual_review");
  assert.ok(out.reasonCodes.includes("DOCUMENT_IS_LIVE_FACE"));

  const r = await db.verificationResult.findFirst({ where: { sessionId: session.id } });
  assert.equal(r.documentStatus, "review");
  assert.equal(r.rawResult.document.liveFaceAsDocument, true);
  assert.equal(r.rawResult.document.liveness.verdict, "Real");
});

test("genuine card: doc image scores Spoof (it IS a printed photo) → no flag", async () => {
  const { db } = await seed();
  const provider = stubProvider();
  let call = 0;
  const original = provider.checkLiveness;
  provider.checkLiveness = async (buf) => {
    call++;
    // 1st call = selfie (Real), later call = ID image (Spoof — expected!)
    if (call > 2) return original(buf);
    return call === 1
      ? { score: 0.95, verdict: "Real", faceCount: 1, occluded: false, raw: {} }
      : { score: 0.1, verdict: "Spoof", faceCount: 1, occluded: false, raw: {} };
  };

  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider, evidenceKey: KEY });
  assert.equal(out.status, "approved", `Spoof verdict on the CARD is normal; got ${out.reasonCodes}`);
});

test("extraction-only OCR (tesseract): PASSES with fields persisted — verification is a later phase", async () => {
  const { db, session } = await seed({ withSelfie: false, type: "ID_ONLY" });
  const provider = stubProvider();
  // What the tesseract adapter returns for a readable card
  provider.extractDocument = async () => ({
    available: true,
    ocrConfidence: 0.82,
    extractedData: { fullNameCandidate: "ADENIYI IBRAHEEM", idNumberCandidates: ["12345678901"], rawText: "..." },
    expired: null,
    validated: false,
    raw: { engine: "tesseract.js" }
  });

  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider, evidenceKey: KEY });
  assert.equal(out.status, "approved", `extraction-only must not block: got ${out.reasonCodes}`);
  assert.ok(!out.reasonCodes.includes("DOCUMENT_OCR_FAILED"), "extraction worked");

  const r = await db.verificationResult.findFirst({ where: { sessionId: session.id } });
  assert.equal(r.documentStatus, "valid");
  assert.equal(r.ocrConfidence, 0.82);
  assert.equal(r.extractedData.idNumberCandidates[0], "12345678901", "extracted fields persisted for later verification");
  assert.equal(r.rawResult.document.validated, false, "unvalidated status still recorded for the verification phase");
  assert.equal(r.rawResult.document.ocrEngine, "tesseract.js");
});

test("MRZ-proven expiry (the one trustworthy heuristic) still flags DOCUMENT_EXPIRED", async () => {
  const { db } = await seed({ withSelfie: false, type: "ID_ONLY" });
  const provider = stubProvider();
  provider.extractDocument = async () => ({
    available: true, ocrConfidence: 0.95,
    extractedData: { mrz: { valid: true }, expiryDate: "2012-04-15" },
    expired: true, validated: false, raw: { engine: "tesseract.js" }
  });

  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider, evidenceKey: KEY });
  assert.equal(out.status, "manual_review");
  assert.ok(out.reasonCodes.includes("DOCUMENT_EXPIRED"));
});

test("liveness misfire on a card photo: Real verdict + SMALL face ratio → NOT flagged as live face", async () => {
  const { db } = await seed({ withSelfie: false, type: "ID_ONLY" });
  const provider = stubProvider();
  // onnx liveness sometimes calls a clean printed portrait "Real" — but the
  // portrait spans only ~20-25% of the card-cropped image width.
  provider.checkLiveness = async () => ({ score: 0.9, verdict: "Real", faceRatio: 0.22, faceCount: 1, occluded: false, raw: {} });

  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider, evidenceKey: KEY });
  assert.ok(!out.reasonCodes.includes("DOCUMENT_IS_LIVE_FACE"), `small portrait must not flag: got ${out.reasonCodes}`);
});

test("real live face as 'document': Real verdict + DOMINANT face ratio → flagged", async () => {
  const { db } = await seed({ withSelfie: false, type: "ID_ONLY" });
  const provider = stubProvider();
  provider.checkLiveness = async () => ({ score: 0.9, verdict: "Real", faceRatio: 0.55, faceCount: 1, occluded: false, raw: {} });

  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider, evidenceKey: KEY });
  assert.equal(out.status, "manual_review");
  assert.ok(out.reasonCodes.includes("DOCUMENT_IS_LIVE_FACE"));
});

test("OCR service missing: degrades to manual_review, not crash", async () => {
  const { db, session } = await seed();
  const provider = stubProvider();
  provider.extractDocument = async () => ({ available: false, ocrConfidence: null, extractedData: null, expired: null, raw: null });

  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider, evidenceKey: KEY });
  assert.equal(out.status, "manual_review");
  assert.ok(out.reasonCodes.includes("DOCUMENT_OCR_FAILED"));

  const r = await db.verificationResult.findFirst({ where: { sessionId: session.id } });
  assert.equal(r.rawResult.document.available, false);
});

test("challenge frames from a PREVIOUS attempt cannot satisfy a reissued challenge", async () => {
  const { db, session, addEvidence } = await seed({ settings: STRICT });
  const now = Date.now();
  // Reissued challenge (as retrySession does): fresh issuedAt = now
  await db.verificationSession.updateMany({
    where: { id: session.id },
    data: { livenessChallenge: { version: 1, actions: ["smile"], nonce: "n2", issuedAt: new Date(now).toISOString() } }
  });
  // Frame from attempt 1: right ACTION label, uploaded before the reissue
  await addEvidence("liveness_frame", { label: "smile", createdAt: new Date(now - 60 * 60 * 1000) });

  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider: stubProvider(), evidenceKey: KEY });
  assert.equal(out.status, "rejected");
  assert.ok(out.reasonCodes.includes("LIVENESS_CHALLENGE_INCOMPLETE"),
    `old frames must not count toward the new challenge: got ${out.reasonCodes}`);
});

test("challenge frames uploaded AFTER the reissue verify normally", async () => {
  const { db, session, addEvidence } = await seed({ settings: STRICT });
  const now = Date.now();
  await db.verificationSession.updateMany({
    where: { id: session.id },
    data: { livenessChallenge: { version: 1, actions: ["smile"], nonce: "n2", issuedAt: new Date(now).toISOString() } }
  });
  await addEvidence("liveness_frame", { label: "smile", createdAt: new Date(now + 30 * 1000) });

  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider: stubProvider(), evidenceKey: KEY });
  assert.equal(out.status, "manual_review", `got ${out.reasonCodes}`);
});

test("liveness auto-approve (default): a selfie in the old review band approves, and the waiver is persisted end to end", async () => {
  // Selfie scores 0.75: inside the faceplugin review band (0.70–0.85), which
  // the old policy routed to manual review. 0.75 > autoApprove 0.6 → approved,
  // with LIVENESS_BORDERLINE recorded as waived on session, result and webhook.
  const { db, session } = await seed();
  const provider = stubProvider();
  const original = provider.checkLiveness;
  let n = 0;
  provider.checkLiveness = async buf => ({ ...await original(buf), ...(n++ === 0 ? { score: 0.75 } : {}) });
  const out = await runVerification({ sessionUid: session.sessionUid }, { db, provider, evidenceKey: KEY });
  assert.equal(out.status, "approved", `got ${out.reasonCodes}`);
  assert.deepEqual(out.reasonCodes, []);
  const s = await db.verificationSession.findFirst({ where: { id: session.id } });
  assert.equal(s.status, "approved");
  assert.ok(s.decisionReason.waivedReasonCodes.includes("LIVENESS_BORDERLINE"), JSON.stringify(s.decisionReason));
  assert.equal(s.decisionReason.livenessWaiver, "score");
  const r = db.verificationResult.rows[0];
  assert.equal(r.livenessScore, 0.75);
  assert.ok(r.rawResult.decision.waivedReasonCodes.includes("LIVENESS_BORDERLINE"));
  // webhook: same event name as before, plus who decided and why
  const hook = db.outbox.rows.find((o) => o.type === "send_webhook");
  assert.equal(hook.payload.event, "verification.approved");
  assert.equal(hook.payload.snapshot.decisionSource, "automatic");
  assert.deepEqual(hook.payload.snapshot.reasonCodes, []);
  assert.ok(hook.payload.snapshot.waivedReasonCodes.includes("LIVENESS_BORDERLINE"));
});

test("liveness auto-approve (default): a rejected outcome still sends verification.rejected with its reason codes", async () => {
  const { db, session } = await seed();
  const provider = stubProvider();
  provider.checkLiveness = async () => ({ score: 0.2, faceCount: 1 });
  const out = await runVerification({ sessionUid: session.sessionUid }, { db, provider, evidenceKey: KEY });
  assert.equal(out.status, "rejected", `got ${out.reasonCodes}`);
  const hook = db.outbox.rows.find((o) => o.type === "send_webhook");
  assert.equal(hook.payload.event, "verification.rejected");
  assert.equal(hook.payload.snapshot.decisionSource, "automatic");
  assert.ok(hook.payload.snapshot.reasonCodes.includes("LIVENESS_FAILED"), JSON.stringify(hook.payload.snapshot));
});

test("tenant thresholds from settings are applied", async () => {
  const { db } = await seed({ settings: { thresholds: { faceMatch: { pass: 0.95 } } } });
  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider: stubProvider(), evidenceKey: KEY });
  assert.equal(out.status, "manual_review"); // 0.9 < tenant's stricter 0.95
});

test("missing selfie: session failed, no provider calls", async () => {
  const { db, session } = await seed({ withSelfie: false });
  const provider = stubProvider();
  provider.checkLiveness = async () => { throw new Error("should not be called"); };

  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider, evidenceKey: KEY });
  assert.equal(out.status, "failed");
  const s = await db.verificationSession.findFirst({ where: { id: session.id } });
  assert.equal(s.status, "failed");
});

test("non-submitted session is skipped (idempotent retries)", async () => {
  const { db } = await seed();
  await db.verificationSession.updateMany({ where: { sessionUid: "vps_PIPE1" }, data: { status: "approved" } });
  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider: stubProvider(), evidenceKey: KEY });
  assert.equal(out.skipped, true);
});

test("risk signals: prior failures push a clean case to manual_review", async () => {
  const { db, session } = await seed();
  // three prior rejected attempts for the same customer in the last 24h
  for (let i = 0; i < 3; i++) {
    await db.verificationSession.create({
      data: {
        sessionUid: `vps_PRIOR${i}`, tenantId: session.tenantId, customerReference: session.customerReference || "C1",
        status: "rejected", createdAt: new Date(Date.now() - (i + 1) * 3600 * 1000)
      }
    });
  }
  await db.verificationSession.updateMany({
    where: { sessionUid: "vps_PIPE1" },
    data: { customerReference: session.customerReference || "C1" }
  });

  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider: stubProvider(), evidenceKey: KEY });
  assert.equal(out.status, "manual_review");
  assert.ok(out.reasonCodes.includes("REPEATED_FAILED_ATTEMPTS"));

  // risk signals recorded in raw result + audit flagged as risk event
  const r = await db.verificationResult.findFirst({ where: { sessionId: session.id } });
  assert.equal(r.rawResult.riskSignals.repeatedFailedAttempts, true);
  const audits = await db.auditLog.findMany({ where: { action: "verification.decided" } });
  assert.equal(audits[0].riskEvent, true);
});

test("wrong evidence key fails loudly (tamper/misconfig protection)", async () => {
  const { db } = await seed();
  await assert.rejects(() =>
    runVerification({ sessionUid: "vps_PIPE1" }, { db, provider: stubProvider(), evidenceKey: crypto.randomBytes(32) })
  );
});

test("id_back: back-side OCR merges into the front (front fields win, gaps filled)", async () => {
  const { db, session, addEvidence } = await seed();
  await addEvidence("id_back");
  let calls = 0;
  const provider = stubProvider();
  provider.extractDocument = async () => {
    calls++;
    return calls === 1
      ? { available: true, ocrConfidence: 0.6, extractedData: { fullName: "ADEBAYO JOHN", documentNumber: null }, expired: false, raw: { engine: "tess" } }
      : { available: true, ocrConfidence: 0.9, extractedData: { fullName: "WRONG BACK NAME", documentNumber: "A99", dateOfBirth: "1990-01-01" }, expired: false, raw: { engine: "tess" } };
  };
  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider, evidenceKey: KEY });
  assert.equal(calls, 2, "both sides OCRed");
  const r = await db.verificationResult.findFirst({ where: { sessionId: session.id } });
  assert.equal(r.extractedData.fullName, "ADEBAYO JOHN", "front wins");
  assert.equal(r.extractedData.documentNumber, "A99", "back fills the gap");
  assert.equal(r.extractedData.dateOfBirth, "1990-01-01");
  assert.equal(r.rawResult.document.back.available, true);
  assert.equal(out.status, "approved");
});

test("screening hit: approved escalates to manual_review with SANCTIONS_PEP_MATCH", async () => {
  const { db, session } = await seed();
  const out = await runVerification({ sessionUid: "vps_PIPE1" }, {
    db, provider: stubProvider(), evidenceKey: KEY,
    screen: async () => ({ performed: true, backend: "webhook", hit: true, sanctions: true, pep: false, matchCount: 1 })
  });
  assert.equal(out.status, "manual_review");
  assert.ok(out.reasonCodes.includes("SANCTIONS_PEP_MATCH"));
  const s = await db.verificationSession.findFirst({ where: { id: session.id } });
  assert.equal(s.status, "manual_review");
  assert.equal(s.riskLevel, "high");
  const r = await db.verificationResult.findFirst({ where: { sessionId: session.id } });
  assert.equal(r.rawResult.screening.hit, true);
});

test("screening outage: fail-open, decision unaffected, outcome recorded", async () => {
  const { db, session } = await seed();
  const out = await runVerification({ sessionUid: "vps_PIPE1" }, {
    db, provider: stubProvider(), evidenceKey: KEY,
    screen: async () => ({ performed: false, backend: "webhook", hit: false, error: "ECONNREFUSED" })
  });
  assert.equal(out.status, "approved", "provider outage must not block onboarding");
  const r = await db.verificationResult.findFirst({ where: { sessionId: session.id } });
  assert.equal(r.rawResult.screening.performed, false);
  assert.match(r.rawResult.screening.error, /ECONNREFUSED/);
});

test("FV-1: one frame relabeled across two challenge actions → rejected DUPLICATE_FRAME", async () => {
  const { db, session, addEvidence } = await seed();
  const now = Date.now();
  await db.verificationSession.updateMany({
    where: { id: session.id },
    data: { livenessChallenge: { version: 1, actions: ["turn_left", "smile"], nonce: "n", issuedAt: new Date(now).toISOString() } }
  });
  // Same checksum uploaded under BOTH actions (the classic bypass).
  await addEvidence("liveness_frame", { label: "turn_left", checksum: "dup", createdAt: new Date(now + 1000) });
  await addEvidence("liveness_frame", { label: "smile", checksum: "dup", createdAt: new Date(now + 2000) });

  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider: stubProvider(), evidenceKey: KEY });
  assert.equal(out.status, "rejected");
  assert.ok(out.reasonCodes.includes("LIVENESS_CHALLENGE_DUPLICATE_FRAME"), `got ${out.reasonCodes}`);
});

test("FV-1: distinct frame per action verifies normally", async () => {
  const { db, session, addEvidence } = await seed({ settings: STRICT });
  const now = Date.now();
  await db.verificationSession.updateMany({
    where: { id: session.id },
    data: { livenessChallenge: { version: 1, actions: ["turn_left", "smile"], nonce: "n", issuedAt: new Date(now).toISOString() } }
  });
  await addEvidence("liveness_frame", { label: "turn_left", checksum: "a", createdAt: new Date(now + 1000) });
  await addEvidence("liveness_frame", { label: "smile", checksum: "b", createdAt: new Date(now + 2000) });

  // Pose enforcement is on by default: the head-movement step needs a pose
  // signal reaching the movement threshold (smile is exempt — no pose flag).
  const provider = stubProvider({ liveness: { pose: { yaw: -20, pitch: 0 } } });
  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider, evidenceKey: KEY });
  assert.equal(out.status, "manual_review", `got ${out.reasonCodes}`);
});

test("P0 binding: nonce-matching frame with a bad HMAC → LIVENESS_FRAME_BINDING_FAILED (not INCOMPLETE)", async (t) => {
  const { db, session, addEvidence } = await seed();
  const now = Date.now();
  await db.verificationSession.updateMany({
    where: { id: session.id },
    data: { livenessChallenge: { version: 1, actions: ["turn_left"], nonce: "n-bind", issuedAt: new Date(now).toISOString() } }
  });
  // Tampered row: names the current nonce but the HMAC doesn't verify.
  await addEvidence("liveness_frame", {
    label: "turn_left", checksum: "a", createdAt: new Date(now + 1000),
    challengeNonce: "n-bind", bindingHmac: "0".repeat(64)
  });

  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider: stubProvider(), evidenceKey: KEY });
  assert.equal(out.status, "rejected");
  assert.ok(out.reasonCodes.includes("LIVENESS_FRAME_BINDING_FAILED"), `got ${out.reasonCodes}`);
  const r = await db.verificationResult.findFirst({ where: { sessionId: session.id } });
  assert.equal(r.rawResult.livenessChallenge.bindingRejected, 1);
});

test("P0 binding: correctly bound frame verifies end-to-end", async (t) => {
  const { computeFrameBinding } = require("@verifypass/shared");
  const secret = require("../src/config").sdkTokenSecret;
  const { db, session, addEvidence } = await seed({ settings: STRICT });
  const now = Date.now();
  await db.verificationSession.updateMany({
    where: { id: session.id },
    data: { livenessChallenge: { version: 1, actions: ["turn_left"], nonce: "n-ok", issuedAt: new Date(now).toISOString() } }
  });
  await addEvidence("liveness_frame", {
    label: "turn_left", checksum: "chk-1", createdAt: new Date(now + 1000),
    challengeNonce: "n-ok", bindingHmac: computeFrameBinding(secret, "n-ok", "turn_left", "chk-1")
  });

  const provider = stubProvider({ liveness: { pose: { yaw: -20, pitch: 0 } } });
  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider, evidenceKey: KEY });
  assert.equal(out.status, "manual_review", `got ${out.reasonCodes}`);
  assert.ok(out.reasonCodes.includes("LIVENESS_EVIDENCE_INSUFFICIENT"));
  const r = await db.verificationResult.findFirst({ where: { sessionId: session.id } });
  assert.equal(r.rawResult.livenessChallenge.bindingRejected, 0);
});

test("P0 binding: PRODUCTION ignores unbound liveness frames when a challenge nonce exists", async (t) => {
  const { db, session, addEvidence } = await seed({ settings: STRICT });
  const now = Date.now();
  await db.verificationSession.updateMany({
    where: { id: session.id },
    data: { livenessChallenge: { version: 1, actions: ["turn_left"], nonce: "n-prod", issuedAt: new Date(now).toISOString() } }
  });
  // Fresh-but-unbound frame (bypassed uploadService): dev accepts via the
  // time fence; production must not.
  await addEvidence("liveness_frame", { label: "turn_left", checksum: "a", createdAt: new Date(now + 1000) });

  const provider = stubProvider({ liveness: { pose: { yaw: -20, pitch: 0 } } });
  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider, evidenceKey: KEY, env: "production" });
  assert.equal(out.status, "rejected");
  assert.ok(out.reasonCodes.includes("LIVENESS_CHALLENGE_INCOMPLETE"), `got ${out.reasonCodes}`);
});

test("v5 A4/C3: challenge performer must match the selfie; decision liveness uses the multi-frame median", async () => {
  const { computeFrameBinding } = require("@verifypass/shared");
  const secret = require("../src/config").sdkTokenSecret;
  const { db, session, addEvidence } = await seed();
  const now = Date.now();
  await db.verificationSession.updateMany({ where: { id: session.id }, data: { livenessChallenge: { version: 1, actions: ["turn_left"], nonce: "n-id", issuedAt: new Date(now).toISOString() } } });
  await addEvidence("liveness_frame", { label: "turn_left", checksum: "c1", createdAt: new Date(now + 1000), challengeNonce: "n-id", bindingHmac: computeFrameBinding(secret, "n-id", "turn_left", "c1") });
  // provider: selfie↔ID matches (first compareFaces call), selfie↔challenge frame does NOT (second call).
  // The frame is frontal (|yaw| ≤ 15°) so it qualifies for identity continuity.
  const provider = stubProvider({ liveness: { pose: { yaw: -10, pitch: 0 } } });
  let calls = 0;
  provider.compareFaces = async () => ({ score: ++calls === 1 ? 0.9 : 0.2, idFaceFound: true, raw: {} });
  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider, evidenceKey: KEY });
  assert.equal(out.status, "rejected", `got ${out.reasonCodes}`);
  assert.ok(out.reasonCodes.includes("LIVENESS_IDENTITY_MISMATCH"));
  const r = await db.verificationResult.findFirst({ where: { sessionId: session.id } });
  assert.equal(r.rawResult.livenessIdentity.score, 0.2);
  assert.ok(r.rawResult.liveness.passiveAggregate && r.rawResult.liveness.passiveAggregate.n >= 2);
});

test("screen-flash: unsigned mosaic cannot satisfy an enforced flash policy", async () => {
  const { db, session, addEvidence } = await seed({ settings: { ...STRICT, challenge: { enforceFlash: true } } });
  await addEvidence("liveness_frame", { label: "flash", challengeNonce: "baseline", meta: { sequence: [[255,0,0],[0,255,0],[0,0,255],[255,255,255]], tile: 96 } });
  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider: stubProvider(), evidenceKey: KEY });
  assert.equal(out.status, "manual_review");
  assert.ok(out.reasonCodes.includes("LIVENESS_FLASH_UNVERIFIED"));
  const r = await db.verificationResult.findFirst({ where: { sessionId: session.id } });
  assert.equal(r.rawResult.liveness.flash.ok, null);
});

test("hardening: result insertion failure rolls back decision, audit and outbox", async () => {
  const { db, session } = await seed();
  const original = db.verificationResult.create;
  db.verificationResult.create = async () => { throw new Error("injected result failure"); };
  await assert.rejects(runVerification({ sessionUid: session.sessionUid }, { db, provider: stubProvider(), evidenceKey: KEY }), /injected result failure/);
  assert.equal((await db.verificationSession.findFirst({ where: { id: session.id } })).status, "submitted");
  assert.equal(db.verificationResult.rows.length, 0);
  assert.equal(db.outbox.rows.length, 0);
  assert.equal(db.auditLog.rows.filter(r => r.action === "verification.decided").length, 0);
  db.verificationResult.create = original;
  assert.equal((await runVerification({ sessionUid: session.sessionUid }, { db, provider: stubProvider(), evidenceKey: KEY })).status, "approved");
});

test("hardening: stale worker payload cannot touch a new submitted attempt", async () => {
  const { db, session } = await seed();
  await db.verificationSession.update({ where: { id: session.id }, data: { attemptId: "new-attempt" } });
  const out = await runVerification({ sessionUid: session.sessionUid, attemptId: "old-attempt" }, { db, provider: stubProvider(), evidenceKey: KEY });
  assert.equal(out.skipped, true);
  assert.equal(db.verificationResult.rows.length, 0);
  assert.equal(session.status, "submitted");
});

test("hardening: identity provider failure reviews instead of approving", async () => {
  const { db, session } = await seed({ type: "FACE_ONLY", withId: false });
  const provider = stubProvider();
  provider.compareFaces = async () => { throw new Error("identity unavailable"); };
  const out = await runVerification({ sessionUid: session.sessionUid }, { db, provider, evidenceKey: KEY });
  assert.equal(out.status, "manual_review");
  assert.ok(out.reasonCodes.includes("LIVENESS_IDENTITY_UNAVAILABLE"));
});

test("hardening: good challenge frames cannot replace a failed selfie score", async () => {
  const { db, session } = await seed({ settings: STRICT });
  const provider = stubProvider();
  const original = provider.checkLiveness;
  let n = 0;
  provider.checkLiveness = async buf => ({ ...await original(buf), ...(n++ === 0 ? { score: 0.1 } : {}) });
  const out = await runVerification({ sessionUid: session.sessionUid }, { db, provider, evidenceKey: KEY });
  // Frames can never lift a failed selfie to approval. Passing frontal frames
  // contradict it, so a reviewer decides; the persisted score is the selfie's.
  assert.notEqual(out.status, "approved");
  assert.equal(out.status, "manual_review");
  assert.ok(out.reasonCodes.includes("LIVENESS_BORDERLINE"));
  assert.equal(db.verificationResult.rows[0].livenessScore, 0.1);
});

test("hardening: plaintext checksum substitution is detected", async () => {
  const { db, session } = await seed();
  db.evidenceFile.rows.find(r => r.fileType === "selfie").checksum = "f".repeat(64);
  await assert.rejects(runVerification({ sessionUid: session.sessionUid }, { db, provider: stubProvider(), evidenceKey: KEY }), /CHECKSUM_MISMATCH/);
  assert.equal(session.status, "submitted");
  assert.equal(db.verificationResult.rows.length, 0);
});

test("hardening: dispatch failure leaves one recoverable outbox record", async () => {
  const { db, session } = await seed();
  const out = await runVerification({ sessionUid: session.sessionUid }, { db, provider: stubProvider(), evidenceKey: KEY, enqueueJob: async () => { throw new Error("queue offline"); } });
  assert.equal(out.status, "approved");
  assert.equal(db.verificationResult.rows.length, 1);
  assert.equal(db.outbox.rows[0].status, "pending");
  assert.equal(db.outbox.rows[0].payload.snapshot.status, "approved");
  const { flushOutbox } = require("../src/services/outbox");
  const sent = [];
  await flushOutbox(db, async (type, payload) => sent.push({ type, payload }));
  await flushOutbox(db, async (type, payload) => sent.push({ type, payload }));
  assert.equal(sent.length, 1);
  assert.equal(db.outbox.rows[0].status, "sent");
});

test("hardening: a late inference result cannot finalize after the total deadline", async () => {
  const { db, session } = await seed();
  const provider = stubProvider();
  const original = provider.checkLiveness;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  provider.checkLiveness = async buf => { await gate; return original(buf); };
  await assert.rejects(runVerification({ sessionUid: session.sessionUid }, { db, provider, evidenceKey: KEY, budgetMs: 10 }), /DEADLINE_EXCEEDED/);
  release();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(session.status, "submitted");
  assert.equal(db.verificationResult.rows.length, 0);
});

test("hardening: an in-flight legacy worker cannot overwrite a retry submitted during inference", async () => {
  const { db, session } = await seed();
  const provider=stubProvider(), original=provider.checkLiveness;
  let entered, release;
  const begun=new Promise(r=>{entered=r;});
  const gate=new Promise(r=>{release=r;});
  provider.checkLiveness=async buf=>{entered();await gate;return original(buf);};
  const work=runVerification({sessionUid:session.sessionUid},{db,provider,evidenceKey:KEY});
  await begun;
  await db.verificationSession.update({where:{id:session.id},data:{attemptId:"replacement",status:"submitted"}});
  release();
  assert.equal((await work).skipped,true);
  assert.equal(session.status,"submitted");
  assert.equal(db.verificationResult.rows.length,0);
});
