"use strict";

// run_verification pipeline (PRD §13.1 steps 7–10).
// Dependencies are injected so the whole pipeline is testable without
// Prisma or a live Faceplugin container.

const fs = require("fs/promises");
const { decide, resolveThresholds, decryptBuffer, resolveEvidenceKey, verifyLivenessChallenge } = require("@verifypass/shared");
const { computeRiskSignals } = require("./riskSignals");

// Stamped into every rawResult + logged at worker startup. When a decision
// looks impossible, this settles WHICH code produced it — Node caches modules
// at process start, so an unrestarted worker silently runs old logic.
const PIPELINE_VERSION = "2026-07-06.4-id-only";

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
async function runVerification(payload, { db, provider, evidenceKey, env }) {
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

  // Fail closed: missing captures → failed session, not a crash loop.
  // ID_ONLY has NO selfie step — only the document is required there.
  const needsSelfie = session.verificationType !== "ID_ONLY";
  const needsId = session.verificationType !== "FACE_ONLY";
  if ((needsSelfie && !selfie) || (needsId && !idFront)) {
    await finalize(db, session, {
      decision: { status: "failed", riskLevel: "high", reasonCodes: ["MISSING_CAPTURES"] },
      // Record WHICH capture was missing — "MISSING_CAPTURES" alone told a
      // reviewer nothing when the evidence gallery clearly showed a photo.
      resultRow: {
        rawResult: {
          pipelineVersion: PIPELINE_VERSION,
          missing: {
            selfie: needsSelfie && !selfie,
            idFront: needsId && !idFront
          },
          verificationType: session.verificationType,
          evidenceTypesSeen: evidence.map((e) => e.fileType)
        }
      }
    });
    return { status: "failed" };
  }

  const selfieBuf = needsSelfie ? await loadDecrypted(selfie) : null;
  const idBuf = idFront ? await loadDecrypted(idFront) : null;

  // --- Provider calls (liveness + match + OCR) ---
  const liveness = selfieBuf ? await provider.checkLiveness(selfieBuf) : null;
  const faceMatch = selfieBuf && idBuf ? await provider.compareFaces(selfieBuf, idBuf) : null;
  const doc = idBuf ? await provider.extractDocument(idBuf) : null;

  // Document validation: the "ID front" must actually be a DOCUMENT. A selfie
  // submitted as the ID passes face-compare trivially (it matches itself), so
  // the client capture gate can never be the only defense. Passive liveness on
  // the ID image is the discriminator: a live face shown to the camera scores
  // "Real"; a genuine card's printed portrait scores "Spoof" (it IS a printed
  // photo) or "No face". Only "Real" flags — Spoof/No face are expected here.
  const docLiveness = idBuf ? await provider.checkLiveness(idBuf) : null;

  // --- Decision ---
  const thresholds = resolveThresholds(tenant?.settings || {});
  // A LIVE FACE shown as the "document" must satisfy BOTH signals when the
  // provider reports face size: (1) passive liveness says Real, (2) the face
  // DOMINATES the image. A genuine card's printed portrait is a small
  // fraction of the (card-cropped) image, so a liveness misfire on a clean
  // card photo can't flag on its own. Providers without faceRatio (Faceplugin
  // returns no image dims) rely on their true anti-spoof verdict alone.
  const liveFaceAsDocument = !!docLiveness && docLiveness.verdict === "Real"
    && (typeof docLiveness.score === "number" ? docLiveness.score : 0) >= thresholds.liveness.reject
    && (typeof docLiveness.faceRatio !== "number" || docLiveness.faceRatio >= 0.35);

  // Active liveness challenge: score each captured challenge frame server-side
  // and verify the unpredictable, server-issued action sequence. Client scores
  // are never trusted here — only these server-computed results.
  let challenge = { ok: true, aggregateScore: null, reasonCodes: [], perAction: {} };
  const hasChallenge = needsSelfie && session.livenessChallenge && Array.isArray(session.livenessChallenge.actions) && session.livenessChallenge.actions.length > 0;
  if (hasChallenge) {
    // Only frames uploaded FOR THIS CHALLENGE count. Retries reissue the
    // challenge (fresh nonce + issuedAt) exactly so an earlier attempt's
    // frames can't be replayed — but the verifier matches by action label,
    // so without this time fence attempt-1 frames would satisfy attempt-2's
    // actions. 5s grace covers issue/upload ordering on the same box.
    const issuedAt = session.livenessChallenge.issuedAt
      ? new Date(session.livenessChallenge.issuedAt).getTime() - 5000
      : 0;
    const currentFrames = livenessFrames.filter((fr) => {
      if (!issuedAt || !fr.createdAt) return true; // legacy rows: no fence possible
      return new Date(fr.createdAt).getTime() >= issuedAt;
    });

    const frames = [];
    for (const fr of currentFrames) {
      const buf = await loadDecrypted(fr);
      const lv = await provider.checkLiveness(buf);
      frames.push({ action: fr.label, liveness: { score: lv.score, faceCount: lv.faceCount }, pose: lv.pose || null });
    }
    // Pose enforcement + direction strictness are tenant-opt-in flags, meant
    // to be enabled only after calibrating the deployed Faceplugin container's
    // pose output against real sessions (see rawResult perAction maxAbsYaw/Pitch).
    const challengeOpts = {
      enforcePose: tenant?.settings?.challenge?.enforcePose === true,
      strictDirection: tenant?.settings?.challenge?.strictDirection === true,
      // strong selfie liveness disarms the mid-action spoof floor (a replay
      // can't produce a high selfie score; low action-frame scores then mean
      // pose/lighting, not spoofing)
      selfieScore: liveness ? liveness.score : null
    };
    challenge = verifyLivenessChallenge(session.livenessChallenge, frames, thresholds, challengeOpts);
  }

  const risk = await computeRiskSignals(db, session, thresholds, new Date(), { env });
  const signals = {
    // ID_ONLY has no selfie: omit selfie/liveness sections entirely — the
    // decision engine treats absent sections as not-applicable (fail-closed
    // paths only trigger on PRESENT-but-bad signals).
    ...(liveness ? { selfie: { faceCount: liveness.faceCount }, liveness: { score: liveness.score } } : {}),
    ...(hasChallenge ? { livenessChallenge: { ok: challenge.ok, reasonCodes: challenge.reasonCodes } } : {}),
    ...(faceMatch ? { idFace: { found: faceMatch.idFaceFound }, faceMatch: { score: faceMatch.score } } : {}),
    ...(doc ? {
      document: {
        ocrConfidence: doc.ocrConfidence,
        expired: doc.expired === true,
        liveFaceAsDocument,
        // false = extraction-only OCR (data read, never verified) → review
        validated: doc.validated !== false
      }
    } : {}),
    risk
  };
  const decision = decide(signals, thresholds);

  const resultRow = {
    livenessScore: liveness ? liveness.score : null,
    livenessStatus: !liveness ? null
      : decision.reasonCodes.includes("LIVENESS_FAILED") ? "failed"
      : decision.reasonCodes.includes("LIVENESS_BORDERLINE") ? "review" : "passed",
    faceMatchScore: faceMatch?.score ?? null,
    faceMatchStatus: !faceMatch ? null
      : decision.reasonCodes.includes("FACE_MATCH_FAILED") ? "not_matched"
      : decision.reasonCodes.includes("FACE_MATCH_BORDERLINE") ? "review" : "matched",
    documentStatus: !doc ? null
      : decision.reasonCodes.includes("DOCUMENT_OCR_FAILED") || decision.reasonCodes.includes("DOCUMENT_EXPIRED")
        || decision.reasonCodes.includes("DOCUMENT_IS_LIVE_FACE")
        ? "review" : "valid",
    ocrConfidence: doc?.ocrConfidence ?? null,
    extractedData: doc?.extractedData ?? null,
    rawResult: {
      pipelineVersion: PIPELINE_VERSION,
      provider: provider.name,
      thresholds,
      liveness: liveness ? { score: liveness.score, faceCount: liveness.faceCount, occluded: liveness.occluded } : null,
      livenessChallenge: hasChallenge
        ? { ok: challenge.ok, aggregateScore: challenge.aggregateScore, reasonCodes: challenge.reasonCodes, perAction: challenge.perAction, actions: session.livenessChallenge.actions }
        : null,
      faceMatch: faceMatch ? { score: faceMatch.score, idFaceFound: faceMatch.idFaceFound, providerMatch: faceMatch.providerMatch ?? null } : null,
      document: doc ? {
        available: doc.available,
        expired: doc.expired,
        validated: doc.validated !== false,
        ocrEngine: doc.raw?.engine || null,
        liveness: docLiveness ? { verdict: docLiveness.verdict ?? null, score: docLiveness.score, faceCount: docLiveness.faceCount } : null,
        liveFaceAsDocument
      } : null,
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

module.exports = { runVerification, defaultEvidenceKey, PIPELINE_VERSION };
