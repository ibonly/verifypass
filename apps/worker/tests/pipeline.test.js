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

async function seed({ settings = {}, withSelfie = true, withId = true } = {}) {
  const db = createMockDb();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vp-pipe-"));
  const tenant = await db.tenant.create({ data: { tenantUid: "tnt_p", companyName: "P", status: "active", settings } });
  const session = await db.verificationSession.create({
    data: {
      sessionUid: "vps_PIPE1", tenantId: tenant.id, status: "submitted",
      verificationType: "ID_AND_FACE", isLive: false
    }
  });

  async function addEvidence(fileType) {
    const p = path.join(dir, `${fileType}.enc`);
    await fs.writeFile(p, encryptBuffer(crypto.randomBytes(2000), KEY));
    await db.evidenceFile.create({ data: { sessionId: session.id, fileType, storagePath: p, encrypted: true } });
  }
  if (withId) await addEvidence("id_front");
  if (withSelfie) await addEvidence("selfie");

  return { db, tenant, session };
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

test("OCR service missing: degrades to manual_review, not crash", async () => {
  const { db } = await seed();
  const provider = stubProvider();
  provider.extractDocument = async () => ({ available: false, ocrConfidence: null, extractedData: null, expired: null, raw: null });

  const out = await runVerification({ sessionUid: "vps_PIPE1" }, { db, provider, evidenceKey: KEY });
  assert.equal(out.status, "manual_review");
  assert.ok(out.reasonCodes.includes("DOCUMENT_OCR_FAILED"));
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
