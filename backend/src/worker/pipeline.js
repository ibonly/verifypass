"use strict";

// run_verification pipeline (PRD §13.1 steps 7–10).
// Dependencies are injected so the whole pipeline is testable without
// Prisma or a live Faceplugin container.

const { decide, resolveThresholds, decryptBuffer, resolveEvidenceKey, verifyLivenessChallenge, verifyFrameBinding, storage } = require("@verifypass/shared");
const { computeRiskSignals } = require("./riskSignals");

// Stamped into every rawResult + logged at worker startup. When a decision
// looks impossible, this settles WHICH code produced it — Node caches modules
// at process start, so an unrestarted worker silently runs old logic.
const PIPELINE_VERSION = "2026-07-10.5-idback-screening";

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
/** Default job dispatch: a row in job_queue (polling-worker topology). The
 *  Lambda entry injects an SQS-backed dispatcher instead — follow-up jobs
 *  (webhooks) must reach whatever queue actually has a consumer. */
function dbEnqueue(db) {
  return (type, jobPayload, { runAfter = new Date(), maxAttempts = 5 } = {}) =>
    db.jobQueue.create({ data: { type, payload: jobPayload, status: "pending", runAfter, maxAttempts } });
}

async function runVerification(payload, { db, provider, evidenceKey, env, modelVersion = null, enqueueJob, screen, flashTileMeans }) {
  const tileMeans = flashTileMeans || mosaicTileMeans; // injectable for tests (sharp-free)
  const doScreen = screen || require("./screening").screenCustomer;
  const dispatch = enqueueJob || dbEnqueue(db);
  const { sessionUid } = payload;
  const session = await db.verificationSession.findFirst({ where: { sessionUid } });
  if (!session) throw new Error(`run_verification: session ${sessionUid} not found`);
  if (session.status !== "submitted") return { skipped: true, reason: `status is ${session.status}` };

  const tenant = await db.tenant.findFirst({ where: { id: session.tenantId } });
  const evidence = await db.evidenceFile.findMany({ where: { sessionId: session.id } });

  // Newest first by createdAt — ids are ObjectId STRINGS on MongoDB, so
  // numeric subtraction on them is NaN and would silently not sort.
  const latest = (type) => evidence
    .filter((e) => e.fileType === type)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
  const idFront = latest("id_front");
  const idBack = latest("id_back");
  const selfie = latest("selfie");
  // Screen-flash mosaics share the liveness_frame type (nonce binding, budget
  // fence) but are NOT challenge frames — split them off here.
  const flashMosaics = evidence.filter((e) => e.fileType === "liveness_frame" && e.label === "flash");
  const livenessFrames = evidence.filter((e) => e.fileType === "liveness_frame" && e.label !== "flash");

  async function loadDecrypted(file) {
    // storage-backend aware: local fs path or s3:// URI (Lambda/split deploys)
    const raw = await storage.readStored(file.storagePath);
    return decryptBuffer(raw, evidenceKey);
  }

  // Fail closed: missing captures → failed session, not a crash loop.
  // ID_ONLY has NO selfie step — only the document is required there.
  const needsSelfie = session.verificationType !== "ID_ONLY";
  const needsId = session.verificationType !== "FACE_ONLY";
  if ((needsSelfie && !selfie) || (needsId && !idFront)) {
    await finalize(db, session, {
      dispatch,
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
  const idBackBuf = idBack ? await loadDecrypted(idBack).catch(() => null) : null;

  // --- Provider calls (liveness + match + OCR) ---
  const liveness = selfieBuf ? await provider.checkLiveness(selfieBuf) : null;
  const faceMatch = selfieBuf && idBuf ? await provider.compareFaces(selfieBuf, idBuf) : null;
  let doc = idBuf ? await provider.extractDocument(idBuf) : null;

  // Two-sided documents (voter's card, driver's licence): OCR the back too —
  // it often carries the MRZ/serial. Front fields win; back fills the gaps.
  let docBack = null;
  if (idBackBuf) {
    docBack = await provider.extractDocument(idBackBuf).catch(() => null);
    if (docBack && docBack.available) {
      if (!doc || !doc.available) {
        doc = { ...docBack, side: "back" };
      } else {
        const front = doc.extractedData || {};
        const back = docBack.extractedData || {};
        const frontNonEmpty = Object.fromEntries(
          Object.entries(front).filter(([, v]) => v != null && v !== "")
        );
        doc = {
          ...doc,
          extractedData: { ...back, ...frontNonEmpty },
          ocrConfidence: Math.max(doc.ocrConfidence ?? 0, docBack.ocrConfidence ?? 0) || (doc.ocrConfidence ?? null),
          expired: doc.expired === true || docBack.expired === true
        };
      }
    }
  }

  // Document validation: the "ID front" must actually be a DOCUMENT. A selfie
  // submitted as the ID passes face-compare trivially (it matches itself), so
  // the client capture gate can never be the only defense. Passive liveness on
  // the ID image is the discriminator: a live face shown to the camera scores
  // "Real"; a genuine card's printed portrait scores "Spoof" (it IS a printed
  // photo) or "No face". Only "Real" flags — Spoof/No face are expected here.
  const docLiveness = idBuf ? await provider.checkLiveness(idBuf) : null;

  // --- Decision ---
  // FV-5: thresholds are provider-scale-aware — the ONNX cosine scale and the
  // Faceplugin container scale use different default bands + bounds.
  const thresholds = resolveThresholds(tenant?.settings || {}, provider?.name);
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
  let livenessIdentity = null;   // selfie ↔ challenge-frame similarity (A4)
  let passiveAggregate = null;   // multi-frame passive liveness (C3)
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
    const bindingSecret = require("../config").sdkTokenSecret;
    // Frames whose nonce MATCHES the current challenge but whose HMAC fails
    // are evidence of tampering (relabeled action, swapped body, forged row)
    // — counted and surfaced as LIVENESS_FRAME_BINDING_FAILED below, never
    // silently collapsed into "incomplete".
    let bindingRejected = 0;
    const currentFrames = livenessFrames.filter((fr) => {
      if (fr.challengeNonce) {
        // P0: cryptographic binding — the frame must name THIS challenge's
        // nonce AND carry a valid HMAC over (nonce:action:checksum).
        if (fr.challengeNonce !== session.livenessChallenge.nonce) return false; // superseded attempt
        const bound = verifyFrameBinding(bindingSecret, {
          challengeNonce: fr.challengeNonce,
          action: fr.label,
          checksum: fr.checksum,
          bindingHmac: fr.bindingHmac
        });
        if (!bound) bindingRejected++;
        return bound;
      }
      // P0 follow-up: when the session HAS a challenge nonce, every honest
      // frame went through uploadService and is bound — an unbound frame in
      // production is a row that bypassed the upload path. The time-fence
      // acceptance below is a dev/test affordance for legacy rows only.
      if (env === "production" && session.livenessChallenge.nonce) return false;
      if (!issuedAt || !fr.createdAt) return true; // legacy rows: no fence possible
      return new Date(fr.createdAt).getTime() >= issuedAt;
    });

    const frames = [];
    const frameBufs = []; // parallel to frames — reused for identity/passive aggregation below
    for (const fr of currentFrames) {
      const buf = await loadDecrypted(fr);
      const lv = await provider.checkLiveness(buf);
      // Free geometry signals (v7): five anchor points → rigidity/parallax,
      // EAR/MAR → blink / open-mouth verification. Best-effort per frame.
      let geo = null;
      if (typeof provider.faceLandmarks === "function" && lv.faceCount >= 1) {
        try { geo = await provider.faceLandmarks(buf); } catch (_) { geo = null; }
      }
      frames.push({
        action: fr.label, liveness: { score: lv.score, faceCount: lv.faceCount }, pose: lv.pose || null,
        points: geo ? geo.points : null, expr: geo ? geo.expr : null,
        checksum: fr.checksum || null, createdAt: fr.createdAt || null, captureMode: fr.captureMode || null
      });
      frameBufs.push(buf);
    }

    // --- Identity continuity (v5 A4): the person who performed the challenge
    // must be the person in the selfie. Face match compares selfie↔ID only, so
    // an accomplice could do the movements while the selfie/ID belong to someone
    // else. Compare the selfie with the most FRONTAL single-face challenge
    // frame (smallest |yaw|, else best liveness score).
    if (selfieBuf && frames.length && typeof provider.faceEmbedding === "function") {
      // v7 0.4: identity continuity across EVERY usable frame (|yaw| ≤ 25°
      // where embeddings are reliable): one embedding each, min similarity to
      // the selfie decides. Catches a person swap mid-challenge and face-swap
      // deepfakes that drift between frames.
      try {
        const selfieEmb = await provider.faceEmbedding(selfieBuf);
        if (selfieEmb) {
          const sims = [];
          for (let i = 0; i < frames.length; i++) {
            const f = frames[i];
            if (!f.liveness || f.liveness.faceCount !== 1) continue;
            if (f.pose && Math.abs(Number(f.pose.yaw) || 0) > 25) continue;
            const emb = await provider.faceEmbedding(frameBufs[i]);
            if (emb) sims.push({ action: f.action, score: provider.compareEmbeddings(selfieEmb, emb) });
          }
          if (sims.length) {
            const min = sims.reduce((a, b) => (b.score < a.score ? b : a));
            livenessIdentity = { score: min.score, frameAction: min.action, frames: sims.length, mean: +(sims.reduce((s, x) => s + x.score, 0) / sims.length).toFixed(3), perFrame: sims.map((s) => ({ action: s.action, score: +s.score.toFixed(3) })) };
          }
        }
      } catch (e) {
        livenessIdentity = { score: null, error: String(e && e.message || e).slice(0, 120) };
      }
    }
    if (selfieBuf && frames.length && !livenessIdentity) {
      const candidates = frames
        .map((f, i) => ({ f, i }))
        .filter(({ f }) => f.liveness && f.liveness.faceCount === 1);
      candidates.sort((a, b) => {
        const ya = a.f.pose ? Math.abs(Number(a.f.pose.yaw) || 0) : 90;
        const yb = b.f.pose ? Math.abs(Number(b.f.pose.yaw) || 0) : 90;
        return ya - yb || (b.f.liveness.score || 0) - (a.f.liveness.score || 0);
      });
      const pick = candidates[0];
      if (pick) {
        try {
          const cmp = await provider.compareFaces(selfieBuf, frameBufs[pick.i]);
          livenessIdentity = { score: typeof cmp.score === "number" ? cmp.score : null, frameAction: pick.f.action, frameYaw: pick.f.pose ? Number(pick.f.pose.yaw) || 0 : null };
        } catch (e) {
          livenessIdentity = { score: null, error: String(e && e.message || e).slice(0, 120) };
        }
      }
    }

    // --- Multi-frame passive liveness (v5 C3): judge spoof on the selfie AND
    // the frontal-most challenge frames, aggregated by MEDIAN (robust to one
    // bad frame). Replaces single-frame luck with a multi-frame signal.
    if (liveness && typeof liveness.score === "number") {
      const frontal = frames
        .filter((f) => f.liveness && f.liveness.faceCount === 1 && typeof f.liveness.score === "number")
        .sort((a, b) => (a.pose ? Math.abs(Number(a.pose.yaw) || 0) : 90) - (b.pose ? Math.abs(Number(b.pose.yaw) || 0) : 90))
        .slice(0, 3)
        .map((f) => f.liveness.score);
      const all = [liveness.score, ...frontal].sort((x, y) => x - y);
      const median = all[Math.floor(all.length / 2)];
      passiveAggregate = { selfieScore: liveness.score, frameScores: frontal, median, n: all.length };
    }
    // Pose enforcement + direction strictness are tenant-opt-in flags, meant
    // to be enabled only after calibrating the deployed Faceplugin container's
    // pose output against real sessions (see rawResult perAction maxAbsYaw/Pitch).
    const challengeOpts = {
      // P0: pose-magnitude enforcement is ON by default (a challenge frame
      // must actually reach the movement threshold when the provider reports
      // pose). A tenant can opt out during calibration
      // (settings.challenge.enforcePose = false); ENFORCE_POSE=false is the
      // global kill-switch while calibrating a new model container.
      enforcePose: process.env.ENFORCE_POSE === "false"
        ? false
        : tenant?.settings?.challenge?.enforcePose !== false,
      // Direction consistency + sequence/timing: RECORDED for every session
      // (rawResult.livenessChallenge.consistency / .sequence); ENFORCED once
      // a deployment has looked at a week of data. Env flags are the global
      // switch, tenant settings the per-tenant override.
      enforceConsistency: process.env.CHALLENGE_ENFORCE_CONSISTENCY === "true" || tenant?.settings?.challenge?.enforceConsistency === true,
      enforceSequence: process.env.CHALLENGE_ENFORCE_SEQUENCE === "true" || tenant?.settings?.challenge?.enforceSequence === true,
      // Rigidity (flat-object) check: review by default; reject when enforced
      enforceRigidity: process.env.CHALLENGE_ENFORCE_RIGIDITY === "true" || tenant?.settings?.challenge?.enforceRigidity === true,
      strictDirection: tenant?.settings?.challenge?.strictDirection === true,
      // strong selfie liveness disarms the mid-action spoof floor (a replay
      // can't produce a high selfie score; low action-frame scores then mean
      // pose/lighting, not spoofing)
      selfieScore: liveness ? liveness.score : null
    };
    challenge = verifyLivenessChallenge(session.livenessChallenge, frames, thresholds, challengeOpts);
    if (bindingRejected > 0) {
      challenge = {
        ...challenge,
        ok: false,
        bindingRejected,
        reasonCodes: [...new Set([...challenge.reasonCodes, "LIVENESS_FRAME_BINDING_FAILED"])]
      };
    }
  }

  // v7 0.3: screen/print texture heuristics on the selfie face crop — RECORDED
  // for calibration (rawResult.liveness.texture), not yet a decision input.
  let texture = null;
  if (selfieBuf && liveness && liveness.raw && liveness.raw.box) {
    try { texture = await textureSignals(selfieBuf, liveness.raw.box); } catch (_) { texture = null; }
  }

  // v7 1.1: screen-flash active illumination — the newest mosaic of the
  // current attempt, scored against the colour sequence the widget emitted.
  // Recorded always (rawResult.liveness.flash); routes to review only when
  // CHALLENGE_ENFORCE_FLASH / tenant.settings.challenge.enforceFlash is on.
  let flash = null;
  if (liveness && flashMosaics.length) {
    const nonce = session.livenessChallenge && session.livenessChallenge.nonce;
    const current = flashMosaics
      .filter((m) => !nonce || !m.challengeNonce || m.challengeNonce === nonce)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    if (current && current.meta && Array.isArray(current.meta.sequence)) {
      try {
        const means = await tileMeans(await loadDecrypted(current), current.meta.sequence.length + 1);
        const { scoreFlashResponse } = require("@verifypass/shared");
        flash = {
          ...scoreFlashResponse(means, current.meta.sequence),
          sequence: current.meta.sequence,
          enforced: process.env.CHALLENGE_ENFORCE_FLASH === "true" || tenant?.settings?.challenge?.enforceFlash === true
        };
      } catch (err) {
        flash = { ok: null, reason: `error:${String(err.message).slice(0, 60)}`, enforced: false };
      }
    }
  }

  const risk = await computeRiskSignals(db, session, thresholds, new Date(), { env });
  // Decision liveness score = multi-frame median when available (C3); the raw
  // selfie score is kept in rawResult for calibration.
  const decisionLiveness = liveness
    ? { score: passiveAggregate ? passiveAggregate.median : liveness.score, ...(flash ? { flash: { ok: flash.ok, enforced: flash.enforced === true } } : {}) }
    : null;
  const signals = {
    // ID_ONLY has no selfie: omit selfie/liveness sections entirely — the
    // decision engine treats absent sections as not-applicable (fail-closed
    // paths only trigger on PRESENT-but-bad signals).
    ...(liveness ? { selfie: { faceCount: liveness.faceCount, occluded: liveness.occluded === true }, liveness: decisionLiveness } : {}),
    ...(livenessIdentity ? { livenessIdentity } : {}),
    ...(hasChallenge ? { livenessChallenge: { ok: challenge.ok, reasonCodes: challenge.reasonCodes, motionUnverified: challenge.motionUnverified === true, manualCapture: challenge.manualCapture === true, multiFaceActions: challenge.multiFaceActions || 0, poseProviderUnavailable: challenge.poseProviderUnavailable === true, flatObject: challenge.flatObject === true } } : {}),
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

  // Sanctions/PEP screening (SCREENING_BACKEND, default none/off). Runs AFTER
  // the biometric decision so an outage can't block the pipeline, but a HIT
  // never auto-approves: approved → manual_review (enhanced due diligence).
  const screening = await doScreen({
    fullName: doc?.extractedData?.fullName || session.metadata?.customerName || null,
    customerReference: session.customerReference || null
  });
  if (screening.hit) {
    decision.riskLevel = "high";
    if (!decision.reasonCodes.includes("SANCTIONS_PEP_MATCH")) {
      decision.reasonCodes = [...decision.reasonCodes, "SANCTIONS_PEP_MATCH"];
    }
    if (decision.status === "approved") decision.status = "manual_review";
  }

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
      // Scores are only comparable within one model version — calibration
      // and analytics MUST group by this before aggregating similarity scores.
      modelVersion,
      thresholds,
      liveness: liveness ? { score: liveness.score, faceCount: liveness.faceCount, occluded: liveness.occluded, decisionScore: decisionLiveness ? decisionLiveness.score : null, passiveAggregate, texture, flash } : null,
      livenessIdentity,
      livenessChallenge: hasChallenge
        ? { ok: challenge.ok, aggregateScore: challenge.aggregateScore, reasonCodes: challenge.reasonCodes, perAction: challenge.perAction, actions: session.livenessChallenge.actions, bindingRejected: challenge.bindingRejected || 0, consistency: challenge.consistency || null, sequence: challenge.sequence || null }
        : null,
      faceMatch: faceMatch ? { score: faceMatch.score, idFaceFound: faceMatch.idFaceFound, providerMatch: faceMatch.providerMatch ?? null } : null,
      document: doc ? {
        available: doc.available,
        expired: doc.expired,
        validated: doc.validated !== false,
        ocrEngine: doc.raw?.engine || null,
        liveness: docLiveness ? { verdict: docLiveness.verdict ?? null, score: docLiveness.score, faceCount: docLiveness.faceCount } : null,
        liveFaceAsDocument,
        back: docBack ? {
          available: docBack.available,
          ocrEngine: docBack.raw?.engine || null,
          ocrConfidence: docBack.ocrConfidence ?? null
        } : null
      } : null,
      screening,
      riskSignals: {
        repeatedFailedAttempts: risk.repeatedFailedAttempts,
        deviceSharedAcrossIdentities: risk.deviceSharedAcrossIdentities,
        ipVelocityExceeded: risk.ipVelocityExceeded,
        virtualCameraSuspected: risk.virtualCameraSuspected,
        captureAnomaly: risk.captureAnomaly === true,
        counts: risk.counts
      }
    }
  };

  await finalize(db, session, { decision, resultRow, dispatch });
  return { status: decision.status, reasonCodes: decision.reasonCodes };
}

async function finalize(db, session, { decision, resultRow, dispatch }) {
  const send = dispatch || dbEnqueue(db);
  // Optimistic compare-and-set: claim the session FIRST to prevent duplicate
  // results if the worker dies between result-create and session-update (M2).
  // Only one worker can flip the status away from its current value.
  const claimed = await db.verificationSession.updateMany({
    where: { id: session.id, status: session.status },
    data: {
      status: decision.status,
      riskLevel: decision.riskLevel === "low" || decision.riskLevel === "medium" || decision.riskLevel === "high"
        ? decision.riskLevel : null,
      decisionReason: { reasonCodes: decision.reasonCodes },
      completedAt: ["approved", "rejected", "failed"].includes(decision.status) ? new Date() : null
    }
  });
  if (claimed.count === 0) {
    // Another worker already finalized — skip to avoid duplicate results/webhooks.
    return;
  }
  await db.verificationResult.create({ data: { sessionId: session.id, ...resultRow } });
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
  // M4 webhook dispatcher consumes this (via the injected dispatch in
  // Lambda/SQS topologies, or the job_queue table for the polling worker)
  await send("send_webhook", {
    tenantId: String(session.tenantId),
    sessionUid: session.sessionUid,
    event: `verification.${decision.status}`
  });
}

module.exports = { mosaicTileMeans, runVerification, defaultEvidenceKey, PIPELINE_VERSION };


/**
 * Cheap screen/print texture scalars on the face crop (v7 0.3). No model:
 *   hfRatio     — Laplacian energy / pixel variance (prints and screens are
 *                 either too smooth or carry periodic high-frequency energy)
 *   moire       — mean absolute autocorrelation at lags 2–4 px on the
 *                 Laplacian image (periodic pixel grids raise it)
 *   colorCast   — mean(R) − mean(B) on the crop (screens skew blue/cool)
 *   glowFrac    — fraction of near-saturated pixels in a margin around the
 *                 face box (a bright rectangle around the face = a screen)
 * Recorded for calibration only; thresholds come from calibrate-thresholds.
 */
/**
 * Mean [r,g,b] of each square tile of a horizontal mosaic (v7 1.1). Only the
 * central 60 % of each tile is averaged (the crop's border holds hair and
 * background, which reflect differently from skin).
 */
async function mosaicTileMeans(buf, tiles) {
  const sharp = require("sharp");
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const tw = Math.floor(W / tiles);
  const size = Math.min(tw, H);
  if (!(size >= 8)) throw new Error("flash mosaic too small");
  const out = [];
  for (let t = 0; t < tiles; t++) {
    const x0 = t * tw + Math.floor(size * 0.2), x1 = t * tw + Math.floor(size * 0.8);
    const y0 = Math.floor(size * 0.2), y1 = Math.floor(size * 0.8);
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 3;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
    out.push([r / n, g / n, b / n]);
  }
  return out;
}

async function textureSignals(buf, box) {
  let sharp;
  try { sharp = require("sharp"); } catch (_) { return null; }
  const meta = await sharp(buf).metadata();
  const W = meta.width, H = meta.height;
  if (!W || !H) return null;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
  const bw = box.x2 - box.x1, bh = box.y2 - box.y1;
  const left = clamp(box.x1, 0, W - 2), top = clamp(box.y1, 0, H - 2);
  const width = clamp(bw, 2, W - left), height = clamp(bh, 2, H - top);
  const { data: rgb } = await sharp(buf).extract({ left, top, width, height }).resize(96, 96, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = 96 * 96;
  const gray = new Float32Array(n);
  let sr = 0, sb = 0;
  for (let i = 0; i < n; i++) { const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2]; gray[i] = 0.299 * r + 0.587 * g + 0.114 * b; sr += r; sb += b; }
  const mean = gray.reduce((a, v) => a + v, 0) / n;
  const variance = gray.reduce((a, v) => a + (v - mean) * (v - mean), 0) / n;
  const lap = new Float32Array(n);
  let lapE = 0;
  for (let y = 1; y < 95; y++) for (let x = 1; x < 95; x++) {
    const i = y * 96 + x;
    const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - 96] - gray[i + 96];
    lap[i] = v; lapE += v * v;
  }
  lapE /= n;
  let moire = 0;
  for (const lag of [2, 3, 4]) {
    let acc = 0, cnt = 0;
    for (let y = 1; y < 95; y++) for (let x = 1; x < 95 - lag; x++) { acc += lap[y * 96 + x] * lap[y * 96 + x + lag]; cnt++; }
    moire += Math.abs(acc / cnt) / (lapE || 1);
  }
  moire /= 3;
  // glow: near-saturated pixels in a 25 % margin around the box
  const mL = clamp(box.x1 - bw * 0.25, 0, W - 2), mT = clamp(box.y1 - bh * 0.25, 0, H - 2);
  const mW = clamp(bw * 1.5, 2, W - mL), mH = clamp(bh * 1.5, 2, H - mT);
  const { data: m } = await sharp(buf).extract({ left: mL, top: mT, width: mW, height: mH }).resize(64, 64, { fit: "fill" }).removeAlpha().grayscale().raw().toBuffer({ resolveWithObject: true });
  let sat = 0; for (let i = 0; i < m.length; i++) if (m[i] >= 245) sat++;
  return {
    hfRatio: +(lapE / (variance || 1)).toFixed(4),
    moire: +moire.toFixed(4),
    colorCast: +((sr - sb) / n).toFixed(2),
    glowFrac: +(sat / m.length).toFixed(4)
  };
}
