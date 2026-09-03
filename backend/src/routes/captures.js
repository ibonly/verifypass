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
const { AppError } = require("@verifypass/shared");

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
        sdkToken: req.body?.sdkToken,
        kind,
        side: req.body?.side,
        action: req.body?.action,
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

// POST /v1/verification-sessions/:sessionId/verify (PRD §12.5)
router.post("/:sessionId/verify", bigBody, ...sdkAuth, async (req, res, next) => {
  try {
    const session = await req.scopedDb.sessions.findByUid(req.params.sessionId);
    if (!session) throw new AppError("SESSION_NOT_FOUND");
    if (session.status !== "started") {
      throw new AppError("VALIDATION_ERROR", `cannot verify a session in status '${session.status}' (upload captures first)`);
    }
    const { verifySdkToken, attachDeviceInfo } = require("../services/sessionService");
    if (!req.body?.sdkToken || !verifySdkToken(session.sessionUid, req.body.sdkToken, session.sdkTokenHash)) {
      throw new AppError("INVALID_API_KEY", "invalid SDK token for this session");
    }

    // Device fingerprint + client IP for fraud-signal checks (Phase 2)
    const clientIp = req.ip || req.socket?.remoteAddress || null;
    await attachDeviceInfo(req.scopedDb, req.tenant.tenantUid, session.sessionUid, req.body?.device, clientIp);

    await req.scopedDb.sessions.update(session.sessionUid, { status: "submitted" });
    await enqueue("run_verification", { sessionUid: session.sessionUid, tenantId: String(req.tenant.id) });
    await audit({
      tenantId: req.tenant.id, sessionId: session.id, actorType: "api",
      actorId: `key:${req.apiKey.prefix}`, action: "session.submitted", req
    });
    res.status(202).json({ success: true, sessionId: session.sessionUid, status: "submitted" });
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
      req
    });
    res.json(payload);
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
    if (!req.query.sdkToken || !verifySdkToken(session.sessionUid, req.query.sdkToken, session.sdkTokenHash)) {
      throw new AppError("INVALID_API_KEY", "invalid SDK token for this session");
    }
    res.json({ success: true, sessionId: session.sessionUid, status: session.status });
  } catch (err) {
    next(err);
  }
});

// GET /v1/verification-sessions/:sessionId/challenge?sdkToken=... — SDK fetches
// the server-issued active-liveness actions to prompt the user through. The
// actions are instructions (not secrets); verification is still server-side.
router.get("/:sessionId/challenge", ...sdkAuth, async (req, res, next) => {
  try {
    const session = await req.scopedDb.sessions.findByUid(req.params.sessionId);
    if (!session) throw new AppError("SESSION_NOT_FOUND");
    const { verifySdkToken } = require("../services/sessionService");
    if (!req.query.sdkToken || !verifySdkToken(session.sessionUid, req.query.sdkToken, session.sdkTokenHash)) {
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
      // Two-sided document types (voter's card, driver's licence) tell the
      // SDK to add a back-of-ID capture step.
      documentTypes: Array.isArray(session.documentTypes) ? session.documentTypes : [],
      livenessActions: Array.isArray(session.livenessChallenge?.actions) ? session.livenessChallenge.actions : [],
      attempts: priorRetries + 1,
      maxAttempts: RETRY_MAX_ATTEMPTS,
      manualUploadSuggested: priorRetries + 1 > RETRY_MANUAL_UPLOAD_AFTER
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
