"use strict";

// SDK-facing capture endpoints (public key + per-session SDK token).
// Auth is applied PER ROUTE (not router.use) so unmatched paths fall through
// to the secret-key sessions router mounted at the same base path.

const express = require("express");
const { sdkOrHostedAuth } = require("../middleware/auth");
const { tenantScope } = require("../middleware/tenantScope");
const { handleUpload } = require("../services/uploadService");
const { enqueue } = require("../services/jobService");
const { audit } = require("../services/auditLogger");
const { AppError, DEFAULT_TTL_MS, SEQUENCE_LIMITS } = require("@verifypass/shared");

const router = express.Router();
const { standardLimiters } = require("../middleware/rateLimit");
const captureLimiter = standardLimiters().captures;
const sdkAuth = [sdkOrHostedAuth, tenantScope, captureLimiter];
const bigBody = express.json({ limit: "12mb" }); // base64 inflation headroom over 8MB binary cap

function uploadRoute(kind) {
  return async (req, res, next) => {
    try {
      const { retentionFor } = require("../services/settingsService");
      const result = await handleUpload({
        scopedDb: req.scopedDb,
        tenantUid: req.tenant.tenantUid,
        sessionUid: req.params.sessionId,
        sdkToken: req.headers["x-vp-sdk-token"] || req.body?.sdkToken,
        attemptId: req.body?.attemptId,
        kind,
        side: req.body?.side,
        action: req.body?.action,
        captureMode: req.body?.captureMode,
        meta: req.body?.meta,
        imageBase64: req.body?.imageBase64,
        retentionDays: retentionFor(req.tenant).rawEvidenceDays // per-tenant policy
      });
      await audit({
        tenantId: req.tenant.id, actorType: "api", actorId: `key:${req.apiKey.prefix}`,
        action: `capture.${kind}_uploaded`, req,
        metadata: { sessionId: req.params.sessionId, fileType: result.fileType, label: result.label || null, sizeBytes: result.sizeBytes }
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };
}

// POST /v1/verification-sessions/:sessionId/document (PRD §12.3)
router.post("/:sessionId/document", bigBody, ...sdkAuth, uploadRoute("document"));

// POST /v1/verification-sessions/:sessionId/face (PRD §12.4)
router.post("/:sessionId/face", bigBody, ...sdkAuth, uploadRoute("face"));

// POST /v1/verification-sessions/:sessionId/liveness-frame — active-liveness
// challenge frame; body { sdkToken, action, imageBase64 }.
router.post("/:sessionId/liveness-frame", bigBody, ...sdkAuth, uploadRoute("liveness"));

// POST /v1/verification-sessions/:sessionId/flash — screen-flash mosaic
// (baseline + one face tile per colour); body { sdkToken, imageBase64,
// meta: { sequence: [[r,g,b]×4], tile } }. Record-first liveness signal.
router.post("/:sessionId/flash", bigBody, ...sdkAuth, uploadRoute("flash"));

// POST /v1/verification-sessions/:sessionId/verify (PRD §12.5)
router.post("/:sessionId/verify", bigBody, ...sdkAuth, async (req, res, next) => {
  try {
    const { submitSession } = require("../services/sessionService");
    const result = await submitSession(req.scopedDb, req.params.sessionId, req.body?.sdkToken, req.body?.attemptId, { tenantUid: req.tenant.tenantUid, device: req.body?.device, clientIp: req.ip, capture: req.body?.capture, telemetry: req.body?.telemetry });
    res.status(202).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /v1/verification-sessions/:sessionId/retry — end-user retry after a
// rejected / manual_review / failed outcome. Reopens the SAME session (new
// captures supersede old ones; prior results + evidence stay as the attempt
// log), reissues the liveness challenge, extends expiry, and audit-logs every
// attempt. The attempt count is derived from those audit rows — no schema
// change, and the log IS the counter. After 3 camera attempts the client is
// told to offer manual file upload for the document. Logic lives in
// sessionService.retrySession (unit-tested there).
router.post("/:sessionId/retry", bigBody, ...sdkAuth, async (req, res, next) => {
  try {
    const { retrySession } = require("../services/sessionService");
    const payload = await retrySession(req.scopedDb, req.params.sessionId, req.body?.sdkToken, {
      tenantId: req.tenant.id,
      actorId: `key:${req.apiKey.prefix}`,
      attemptId: req.body?.attemptId,
      req
    });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// POST /v1/verification-sessions/:sessionId/challenge/reissue — the user
// cannot perform an action ("try a different movement"); body
// { sdkToken, excludeActions: [...] }. Capped + audited (sessionService).
router.post("/:sessionId/challenge/reissue", bigBody, ...sdkAuth, async (req, res, next) => {
  try {
    const { reissueChallenge } = require("../services/sessionService");
    const payload = await reissueChallenge(req.scopedDb, req.params.sessionId, req.body?.sdkToken, {
      attemptId: req.body?.attemptId, excludeActions: req.body?.excludeActions, tenantId: req.tenant.id, actorId: `key:${req.apiKey.prefix}`, req
    });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// POST /v1/verification-sessions/:sessionId/challenge/begin — the SDK has
// reached the liveness step: start the challenge clock now. The challenge TTL
// and the issue→first-frame window run from here, not from session creation
// (consent, camera permission and document capture come first). Idempotent
// once a frame exists for the current challenge; returns the deadlines the
// UI should surface. Logic in sessionService.beginChallenge.
router.post("/:sessionId/challenge/begin", bigBody, ...sdkAuth, async (req, res, next) => {
  try {
    const { beginChallenge } = require("../services/sessionService");
    res.json(await beginChallenge(req.scopedDb, req.params.sessionId, req.body?.sdkToken, { attemptId: req.body?.attemptId }));
  } catch (err) {
    next(err);
  }
});

// POST /v1/verification-sessions/:sessionId/consent — record the user's
// biometric-processing consent (set-once, idempotent, audit-logged). In
// production uploads are refused until this has been called.
router.post("/:sessionId/consent", bigBody, ...sdkAuth, async (req, res, next) => {
  try {
    const { recordConsent } = require("../services/sessionService");
    const payload = await recordConsent(req.scopedDb, req.params.sessionId, req.body?.sdkToken, {
      copyVersion: req.body?.copyVersion || null,
      tenantId: req.tenant.id,
      req
    });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// GET /v1/verification-sessions/:sessionId/status?sdkToken=... — SDK polling.
// Returns status only (never scores/extracted data — those need the secret key).
router.get("/:sessionId/status", ...sdkAuth, async (req, res, next) => {
  try {
    const session = await req.scopedDb.sessions.findByUid(req.params.sessionId);
    if (!session) throw new AppError("SESSION_NOT_FOUND");
    const { verifySdkToken } = require("../services/sessionService");
    const sdkTokenIn = req.headers["x-vp-sdk-token"] || req.query.sdkToken;
    if (!sdkTokenIn || !verifySdkToken(session.sessionUid, sdkTokenIn, session.sdkTokenHash)) {
      throw new AppError("INVALID_API_KEY", "invalid SDK token for this session");
    }
    // Terminal outcomes carry the USER-ACTIONABLE reason codes only: things
    // the person can fix (lighting, framing, doing the movement). Fraud and
    // integrity signals are deliberately withheld from the SDK — telling an
    // attacker which signal caught them is a free oracle. Tenants see the
    // full set via the secret-key result endpoint.
    const terminal = ["approved", "rejected", "manual_review", "failed", "expired"].includes(session.status);
    const codes = terminal ? (session.decisionReason?.reasonCodes || []).filter((c) => USER_SAFE_REASON_CODES.has(c)) : [];
    let liveness = null;
    if (terminal) {
      try {
        const r = await req.scopedDb.verificationResults.findBySessionId(session.id);
        if (r) {
          const lScore = r.livenessScore != null ? Number(r.livenessScore) : null;
          const sScore = r.rawResult?.liveness?.passiveAggregate?.selfieScore ?? (r.livenessScore != null ? Number(r.livenessScore) : null);
          liveness = {
            score: lScore,
            selfieScore: sScore != null ? Number(sScore) : null
          };
        }
      } catch (_) {}
    }
    res.json({
      success: true,
      sessionId: session.sessionUid,
      status: session.status,
      attemptId: session.attemptId || null,
      release: require("../lib/release").releaseIdentity(),
      ...(terminal ? { decision: { status: session.status, reasonCodes: codes } } : {}),
      ...(liveness ? { liveness } : {})
    });
  } catch (err) {
    next(err);
  }
});

// Reason codes an END USER may see (they describe something the user can act
// on). Everything else — device/IP/velocity/integrity/screening/binding —
// stays server-side.
const USER_SAFE_REASON_CODES = new Set([
  "LIVENESS_FAILED", "LIVENESS_BORDERLINE",
  "LIVENESS_CHALLENGE_FAILED", "LIVENESS_CHALLENGE_INCOMPLETE", "LIVENESS_CHALLENGE_EXPIRED",
  "LIVENESS_POSE_UNAVAILABLE",
  // Sequence timing is usually a genuine user who was slow or paused, not a
  // fraud signal worth hiding — tell them to try again.
  "LIVENESS_CHALLENGE_SEQUENCE_INVALID",
  "FACE_MATCH_FAILED", "FACE_MATCH_BORDERLINE",
  "NO_FACE_ON_SELFIE", "NO_FACE_ON_DOCUMENT", "MULTIPLE_FACES_DETECTED",
  "DOCUMENT_IMAGE_LOW_QUALITY", "DOCUMENT_OCR_FAILED", "DOCUMENT_EXPIRED", "DOCUMENT_IS_LIVE_FACE",
  "SESSION_TIMEOUT"
]);

// GET /v1/verification-sessions/:sessionId/challenge?sdkToken=... — SDK fetches
// the server-issued active-liveness actions to prompt the user through. The
// actions are instructions (not secrets); verification is still server-side.
router.get("/:sessionId/challenge", ...sdkAuth, async (req, res, next) => {
  try {
    const session = await req.scopedDb.sessions.findByUid(req.params.sessionId);
    if (!session) throw new AppError("SESSION_NOT_FOUND");
    const { verifySdkToken } = require("../services/sessionService");
    const sdkTokenIn = req.headers["x-vp-sdk-token"] || req.query.sdkToken;
    if (!sdkTokenIn || !verifySdkToken(session.sessionUid, sdkTokenIn, session.sdkTokenHash)) {
      throw new AppError("INVALID_API_KEY", "invalid SDK token for this session");
    }
    // Attempt state travels with the challenge so a page refresh mid-retry
    // doesn't lose the counter / manual-upload eligibility client-side.
    const { RETRY_MAX_ATTEMPTS, RETRY_MANUAL_UPLOAD_AFTER } = require("../services/sessionService");
    const priorRetries = (await req.scopedDb.auditLogs.list({
      sessionId: session.id, action: "session.retry"
    })).length;
    res.json({
      success: true,
      sessionId: session.sessionUid,
      verificationType: session.verificationType || "ID_AND_FACE",
      hostedBaseUrl: require("../config").hostedBaseUrl,
      // Two-sided document types (voter's card, driver's licence) tell the
      // SDK to add a back-of-ID capture step.
      documentTypes: Array.isArray(session.documentTypes) ? session.documentTypes : [],
      livenessActions: Array.isArray(session.livenessChallenge?.actions) ? session.livenessChallenge.actions : [],
      attemptId: session.attemptId || null,
      flashSequence: session.livenessChallenge?.flashSequence || null,
      challengeNonce: session.livenessChallenge?.nonce || null,
      // Both clocks, so the UI can show them together: the challenge TTL and
      // the first-frame window count from challengeIssuedAt (refreshed by
      // POST /challenge/begin); expiresAt is the session's own deadline.
      challengeIssuedAt: session.livenessChallenge?.issuedAt || null,
      challengeTtlMs: DEFAULT_TTL_MS,
      firstFrameWindowMs: SEQUENCE_LIMITS.maxIssueToFirstMs,
      expiresAt: session.expiresAt,
      attempts: session.attemptNumber || priorRetries + 1,
      maxAttempts: RETRY_MAX_ATTEMPTS,
      manualUploadSuggested: (session.attemptNumber || priorRetries + 1) > RETRY_MANUAL_UPLOAD_AFTER
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
