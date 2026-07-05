"use strict";

// run_verification pipeline (PRD §13.1 steps 7–10).
// Dependencies are injected so the whole pipeline is testable without
// Prisma or a live Faceplugin container.

const fs = require("fs/promises");
const { decide, resolveThresholds, decryptBuffer, resolveEvidenceKey, verifyLivenessChallenge } = require("@verifypass/shared");
const { computeRiskSignals } = require("./riskSignals");

function defaultEvidenceKey(config) {
  return resolveEvidenceKey({
    keyHex: config.evidenceEncryptionKey,
    fallbackSecret: config.sdkTokenSecret,
    production: config.env === "production"
  });
}

/**
 * @param {object} payload {sessionUid}
 * @param {object} deps {db, provider, evidenceKey}
 */
async function runVerification(payload, { db, provider, evidenceKey }) {
  const { sessionUid } = payload;
  const session = await db.verificationSession.findFirst({ where: { sessionUid } });
  if (!session) throw new Error(`run_verification: session ${sessionUid} not found`);
  if (session.status !== "submitted") return { skipped: true, reason: `status is ${session.status}` };

  const tenant = await db.tenant.findFirst({ where: { id: session.tenantId } });
  const evidence = await db.evidenceFile.findMany({ where: { sessionId: session.id } });

  const latest = (type) => evidence.filter((e) => e.fileType === type).sort((a, b) => b.id - a.id)[0] || null;
  const idFront = latest("id_front");
  const selfie = latest("selfie");
  const livenessFrames = evidence.filter((e) => e.fileType === "liveness_frame");

  async function loadDecrypted(file) {
    const raw = await fs.readFile(file.storagePath);
    return decryptBuffer(raw, evidenceKey);
  }

  // Fail closed: missing captures → failed session, not a crash loop
  if (!selfie || (session.verificationType !== "FACE_ONLY" && !idFront)) {
    await finalize(db, session, {
      decision: { status: "failed", riskLevel: "high", reasonCodes: ["MISSING_CAPTURES"] },
      resultRow: {}
    });
    return { status: "failed" };
  }

  const selfieBuf = await loadDecrypted(selfie);
  const idBuf = idFront ? await loadDecrypted(idFront) : null;

  // --- Provider calls (liveness + match + OCR) ---
  const liveness = await provider.checkLiveness(selfieBuf);
  const faceMatch = idBuf ? await provider.compareFaces(selfieBuf, idBuf) : null;
  const doc = idBuf ? await provider.extractDocument(idBuf) : null;

  // --- Decision ---
  const thresholds = resolveThresholds(tenant?.settings || {});

  // Active liveness challenge: score each captured challenge frame server-side
  // and verify the unpredictable, server-issued action sequence. Client scores
  // are never trusted here — only these server-computed results.
  let challenge = { ok: true, aggregateScore: null, reasonCodes: [], perAction: {} };
  const hasChallenge = session.livenessChallenge && Array.isArray(session.livenessChallenge.actions) && session.livenessChallenge.actions.length > 0;
  if (hasChallenge) {
    const frames = [];
    for (const fr of livenessFrames) {
      const buf = await loadDecrypted(fr);
      const lv = await provider.checkLiveness(buf);
      frames.push({ action: fr.label, liveness: { score: lv.score, faceCount: lv.faceCount }, pose: lv.pose || null });
    }
    challenge = verifyLivenessChallenge(session.livenessChallenge, frames, thresholds);
  }

  const risk = await computeRiskSignals(db, session, thresholds);
  const signals = {
    selfie: { faceCount: liveness.faceCount },
    liveness: { score: liveness.score },
    ...(hasChallenge ? { livenessChallenge: { ok: challenge.ok, reasonCodes: challenge.reasonCodes } } : {}),
    ...(faceMatch ? { idFace: { found: faceMatch.idFaceFound }, faceMatch: { score: faceMatch.score } } : {}),
    ...(doc ? { document: { ocrConfidence: doc.ocrConfidence, expired: doc.expired === true } } : {}),
    risk
  };
  const decision = decide(signals, thresholds);

  const resultRow = {
    livenessScore: liveness.score,
    livenessStatus: decision.reasonCodes.includes("LIVENESS_FAILED") ? "failed"
      : decision.reasonCodes.includes("LIVENESS_BORDERLINE") ? "review" : "passed",
    faceMatchScore: faceMatch?.score ?? null,
    faceMatchStatus: !faceMatch ? null
      : decision.reasonCodes.includes("FACE_MATCH_FAILED") ? "not_matched"
      : decision.reasonCodes.includes("FACE_MATCH_BORDERLINE") ? "review" : "matched",
    documentStatus: !doc ? null
      : decision.reasonCodes.includes("DOCUMENT_OCR_FAILED") || decision.reasonCodes.includes("DOCUMENT_EXPIRED")
        ? "review" : "valid",
    ocrConfidence: doc?.ocrConfidence ?? null,
    extractedData: doc?.extractedData ?? null,
    rawResult: {
      provider: provider.name,
      thresholds,
      liveness: { score: liveness.score, faceCount: liveness.faceCount, occluded: liveness.occluded },
      livenessChallenge: hasChallenge
        ? { ok: challenge.ok, aggregateScore: challenge.aggregateScore, reasonCodes: challenge.reasonCodes, perAction: challenge.perAction, actions: session.livenessChallenge.actions }
        : null,
      faceMatch: faceMatch ? { score: faceMatch.score, idFaceFound: faceMatch.idFaceFound } : null,
      document: doc ? { available: doc.available, expired: doc.expired } : null,
      riskSignals: {
        repeatedFailedAttempts: risk.repeatedFailedAttempts,
        deviceSharedAcrossIdentities: risk.deviceSharedAcrossIdentities,
        ipVelocityExceeded: risk.ipVelocityExceeded,
        counts: risk.counts
      }
    }
  };

  await finalize(db, session, { decision, resultRow });
  return { status: decision.status, reasonCodes: decision.reasonCodes };
}

async function finalize(db, session, { decision, resultRow }) {
  await db.verificationResult.create({ data: { sessionId: session.id, ...resultRow } });
  await db.verificationSession.updateMany({
    where: { id: session.id },
    data: {
      status: decision.status,
      riskLevel: decision.riskLevel === "low" || decision.riskLevel === "medium" || decision.riskLevel === "high"
        ? decision.riskLevel : null,
      decisionReason: { reasonCodes: decision.reasonCodes },
      completedAt: ["approved", "rejected", "failed"].includes(decision.status) ? new Date() : null
    }
  });
  await db.auditLog.create({
    data: {
      tenantId: session.tenantId,
      sessionId: session.id,
      actorType: "system",
      action: "verification.decided",
      metadata: { status: decision.status, reasonCodes: decision.reasonCodes },
      riskEvent: decision.status === "rejected" || decision.reasonCodes.some((c) =>
        ["REPEATED_FAILED_ATTEMPTS", "DEVICE_SHARED_ACROSS_IDENTITIES", "IP_VELOCITY_EXCEEDED"].includes(c))
    }
  });
  // M4 webhook dispatcher consumes this
  await db.jobQueue.create({
    data: {
      type: "send_webhook",
      payload: {
        tenantId: String(session.tenantId),
        sessionUid: session.sessionUid,
        event: `verification.${decision.status}`
      },
      status: "pending",
      runAfter: new Date(),
      maxAttempts: 5
    }
  });
}

module.exports = { runVerification, defaultEvidenceKey };
