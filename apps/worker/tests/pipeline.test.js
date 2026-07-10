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
const { createMockDb } = require("../../api/tests/helpers/mockDb");
const { runVerification } = require("../src/pipeline");

const KEY = crypto.randomBytes(32);

function stubProvider(overrides = {}) {
  return {
    name: "stub",
    checkLiveness: async () => ({ score: 0.95, faceCount: 1, occluded: false, raw: {}, ...(overrides.liveness || {}) }),
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
      livenessChallenge: withChallenge ? { actions: ["turn_left"], nonce: "nonce" } : null
    }
  });

  async function addEvidence(fileType, extra = {}) {
    const p = path.join(dir, `${fileType}${extra.label || ""}${extra.createdAt ? extra.createdAt.getTime() : ""}.enc`);
    await fs.writeFile(p, encryptBuffer(crypto.randomBytes(2000), KEY));
    await db.evidenceFile.create({ data: { sessionId: session.id, fileType, storagePath: p, encrypted: true, ...extra } });
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
  provider.checkLiveness = async () => {
    call++;
    // 1st call = selfie (Real), later call = ID image (Spoof — expected!)
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
  const { db, session, addEvidence } = await seed();
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
  const { db, session, addEvidence } = await seed();
  const now = Date.now();
  await db.verificationSession.updateMany({
    where: { id: session.id },
    data: { livenessChallenge: { version: 1, actions: ["smile"], nonce: "n2", issuedAt: new Date(now).toISOString() } }
  });
  await addEvidence("liveness_frame", { label: "smile", createdAt: new Date(now + 30 * 1000) });

  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider: stubProvider(), evidenceKey: KEY });
  assert.equal(out.status, "approved", `got ${out.reasonCodes}`);
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
