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
    const clientIp = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim() || null;
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
    res.json({
      success: true,
      sessionId: session.sessionUid,
      verificationType: session.verificationType || "ID_AND_FACE",
      livenessActions: Array.isArray(session.livenessChallenge?.actions) ? session.livenessChallenge.actions : []
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
