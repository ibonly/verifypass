"use strict";

// Tenant dashboard data (PRD §9.13). Counts computed in JS at MVP scale;
// swap to SQL GROUP BY when volume warrants.

const { Router } = require("express");
const fs = require("fs/promises");
const { AppError } = require("@verifypass/shared");
const { requireUser } = require("../middleware/userAuth");
const { tenantScope } = require("../middleware/tenantScope");
const { readEvidence, signEvidenceAccess, verifyEvidenceAccess } = require("../services/evidenceStore");
const { resolveEvidenceKey } = require("@verifypass/shared");
const config = require("../config");
const { effectiveSessionStatus, isSessionOverdue } = require("../services/sessionExpiry");
const { getDb } = require("../lib/db");

const router = Router();
const anyUser = requireUser(); // all roles may view

function requireTenant(req, _res, next) {
  if (!req.tenant) return next(new AppError("VALIDATION_ERROR", "X-Tenant-Id header required for super admin"));
  next();
}

async function selectedResult(session, resultId) {
  if (typeof resultId !== "string" || !/^[a-f0-9]{24}$/i.test(resultId)) throw new AppError("VALIDATION_ERROR", "Invalid result ID");
  const result = await getDb().verificationResult.findFirst({ where: { id: resultId, sessionId: session.id } });
  if (!result) throw new AppError("NOT_FOUND", "Result not found for this session");
  return result;
}

async function resultDecision(session, result) {
  if (result.rawResult?.decision) return result.rawResult.decision;
  if (!result.attemptId) return { status: "unknown", reasonCodes: [] };
  const logs = await getDb().auditLog.findMany({ where: { sessionId: session.id, action: "verification.decided" }, orderBy: { createdAt: "asc" } });
  const event = logs.find(log => log.metadata?.attemptId === result.attemptId);
  return event ? { status: event.metadata.status, reasonCodes: event.metadata.reasonCodes || [] } : { status: "unknown", reasonCodes: [] };
}

// GET /v1/dashboard/stats
router.get("/stats", anyUser, requireTenant, tenantScope, async (req, res, next) => {
  try {
    // L6 fix: cap unbounded query to prevent OOM on large tenants
    const sessions = await req.scopedDb.sessions.list({}, { take: 50000 });
    const byStatus = {};
    let totalCompletionMs = 0;
    let completedCount = 0;
    const now = new Date();
    for (const s of sessions) {
      const status = effectiveSessionStatus(s, now);
      byStatus[status] = (byStatus[status] || 0) + 1;
      if (s.completedAt && s.createdAt) {
        totalCompletionMs += new Date(s.completedAt) - new Date(s.createdAt);
        completedCount++;
      }
    }
    res.json({
      success: true,
      total: sessions.length,
      byStatus,
      avgCompletionSeconds: completedCount ? Math.round(totalCompletionMs / completedCount / 1000) : null
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/dashboard/sessions?status=&limit=
router.get("/sessions", anyUser, requireTenant, tenantScope, async (req, res, next) => {
  try {
    const now = new Date();
    const status = req.query.status;
    let where = status ? { status } : {};
    if (status === "expired") where = { OR: [{ status: "expired" }, { status: { in: ["created", "started"] }, expiresAt: { lte: now } }] };
    if (["created", "started"].includes(status)) where = { status, OR: [{ expiresAt: { gt: now } }, { expiresAt: null }, { expiresAt: { isSet: false } }] };
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
    const sessions = await req.scopedDb.sessions.list(where, { orderBy: { createdAt: "desc" }, take: limit });
    res.json({
      success: true,
      sessions: sessions.map((s) => ({
        sessionId: s.sessionUid,
        customerReference: s.customerReference,
        status: effectiveSessionStatus(s, now),
        storedStatus: s.status,
        overdue: isSessionOverdue(s, now),
        riskLevel: s.riskLevel,
        isLive: s.isLive,
        createdAt: s.createdAt ? new Date(s.createdAt).toISOString() : null,
        completedAt: s.completedAt ? new Date(s.completedAt).toISOString() : null
      }))
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/dashboard/sessions/:sessionId — full detail (JWT auth)
router.get("/sessions/:sessionId", anyUser, requireTenant, tenantScope, async (req, res, next) => {
  try {
    const session = await req.scopedDb.sessions.findByUid(req.params.sessionId);
    if (!session) throw new AppError("SESSION_NOT_FOUND", "Verification session not found");
    const latest = await req.scopedDb.results.latestForSession(session.id);
    const r = req.query.resultId ? await selectedResult(session, req.query.resultId)
      : latest && (!session.attemptId || latest.attemptId === session.attemptId) ? latest : null;
    const currentStatus = effectiveSessionStatus(session);
    const decision = req.query.resultId ? await resultDecision(session, r)
      : { status: currentStatus, reasonCodes: isSessionOverdue(session) ? ["SESSION_EXPIRED"] : session.decisionReason?.reasonCodes || [],
          waivedReasonCodes: session.decisionReason?.waivedReasonCodes || [], livenessWaiver: session.decisionReason?.livenessWaiver || null };
    // Independent products: FACE_ONLY has no document to show, ID_ONLY runs
    // no liveness/face checks. Omit non-applicable sections entirely so the
    // dashboard never renders "—" rows for checks that don't exist.
    const vType = session.verificationType || "ID_AND_FACE";
    const hasFace = vType !== "ID_ONLY";
    const hasDocument = vType !== "FACE_ONLY";
    res.json({
      success: true,
      sessionId: session.sessionUid,
      customerReference: session.customerReference,
      status: decision.status,
      currentStatus,
      currentAttemptId: session.attemptId || null,
      attemptNumber: session.attemptNumber || 1,
      resultId: r?.id || null,
      resultAttemptId: r?.attemptId || null,
      resultAt: r?.createdAt ? new Date(r.createdAt).toISOString() : null,
      historicalResult: !!req.query.resultId,
      legacyResult: !!r && !r.attemptId,
      overdue: isSessionOverdue(session),
      riskLevel: req.query.resultId ? decision.riskLevel || null : session.riskLevel || null,
      isLive: session.isLive,
      verificationType: vType,
      ...(hasDocument ? {
        document: r ? {
          status: r.documentStatus,
          ocrConfidence: r.ocrConfidence != null ? Number(r.ocrConfidence) : null,
          extractedData: r.extractedData || null
        } : null
      } : {}),
      ...(hasFace ? {
        liveness: r ? {
          status: r.livenessStatus,
          score: r.livenessScore != null ? Number(r.livenessScore) : null
        } : null
      } : {}),
      ...(hasFace && hasDocument ? {
        faceMatch: r ? {
          status: r.faceMatchStatus === "matched" && r.faceMatchScore == null ? "review" : r.faceMatchStatus,
          similarityScore: r.faceMatchScore != null ? Number(r.faceMatchScore) : null
        } : null
      } : {}),
      decision,
      // NDPA consent proof — when the user accepted, and which copy version
      consent: session.consentAt ? {
        at: new Date(session.consentAt).toISOString(),
        copyVersion: session.consentMeta?.copyVersion || null
      } : null,
      // Which pipeline judged this session + what evidence it saw — settles
      // "the photo is right there!" confusion (stale worker, type mismatch).
      // Active-challenge detail for reviewers (v5 E2): per-action
      // present/live/pose/peaks/trajectory/manual + consistency & sequence.
      livenessChallenge: r?.rawResult?.livenessChallenge || null,
      livenessIdentity: r?.rawResult?.livenessIdentity || null,
      captureTelemetry: req.query.resultId ? null : session.deviceMeta?.telemetry || null,
      // v7 free anti-spoof signals: flash response, texture heuristics,
      // nightly telemetry anomaly flags (all record-first)
      livenessSignals: r ? {
        passive: r.rawResult?.liveness || null,
        flash: r.rawResult?.liveness?.flash || null,
        texture: r.rawResult?.liveness?.texture || null,
        telemetryAnomaly: r.rawResult?.riskSignals?.telemetryAnomaly || null
      } : null,
      policy: r?.rawResult?.policy || null,
      release: r?.rawResult?.release || null,
      diagnostics: r ? {
        pipelineVersion: r.rawResult?.pipelineVersion || null,
        missing: r.rawResult?.missing || null,
        evidenceTypesSeen: r.rawResult?.evidenceTypesSeen || null,
        document: r.rawResult?.document || null
      } : null,
      createdAt: session.createdAt ? new Date(session.createdAt).toISOString() : null,
      completedAt: req.query.resultId ? null : session.completedAt ? new Date(session.completedAt).toISOString() : null,
      expiresAt: session.expiresAt ? new Date(session.expiresAt).toISOString() : null
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/dashboard/webhook-deliveries?status= — delivery log (JWT auth, Option A)
router.get("/sessions/:sessionId/results", anyUser, requireTenant, tenantScope, async (req, res, next) => {
  try {
    const session = await req.scopedDb.sessions.findByUid(req.params.sessionId);
    if (!session) throw new AppError("SESSION_NOT_FOUND");
    const results = await getDb().verificationResult.findMany({ where: { sessionId: session.id }, orderBy: { createdAt: "desc" } });
    res.json({ success: true, currentAttemptId: session.attemptId || null, results: results.map(result => ({
      resultId: result.id, attemptId: result.attemptId || null, legacy: !result.attemptId,
      createdAt: new Date(result.createdAt).toISOString(),
      decision: result.rawResult?.decision || null,
      release: result.rawResult?.release || null
    })) });
  } catch (err) { next(err); }
});

// Proxies webhook delivery data without requiring the secret API key from the browser.
router.get("/webhook-deliveries", anyUser, requireTenant, tenantScope, async (req, res, next) => {
  try {
    const where = req.query.status ? { status: req.query.status } : {};
    const deliveries = await req.scopedDb.webhookDeliveries.list(where, { orderBy: { createdAt: "desc" }, take: 100 });
    // Fetch webhook URL from tenant record (signing secret is never exposed to dashboard)
    const { getDb } = require("../lib/db");
    const tenant = await getDb().tenant.findFirst({ where: { id: req.tenant.id } });
    res.json({
      success: true,
      webhookUrl: tenant?.webhookUrl || null,
      deliveries: deliveries.map((d) => ({
        eventId: d.eventUid,
        event: d.event,
        status: d.status,
        attempts: d.attempts,
        lastStatusCode: d.lastStatusCode,
        lastError: d.lastError,
        nextAttemptAt: d.nextAttemptAt ? new Date(d.nextAttemptAt).toISOString() : null,
        deliveredAt: d.deliveredAt ? new Date(d.deliveredAt).toISOString() : null,
        createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null
      }))
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/dashboard/sessions/:sessionId/evidence — list evidence files with signed serve tokens
router.get("/sessions/:sessionId/evidence", anyUser, requireTenant, tenantScope, async (req, res, next) => {
  try {
    const session = await req.scopedDb.sessions.findByUid(req.params.sessionId);
    if (!session) throw new AppError("SESSION_NOT_FOUND", "Verification session not found");
    const { getDb } = require("../lib/db");
    const result = req.query.resultId ? await selectedResult(session, req.query.resultId) : null;
    const attemptId = result ? result.attemptId : session.attemptId;
    const exactIds = result?.rawResult?.consumedEvidenceIds;
    const attribution = Array.isArray(exactIds) ? "consumed" : attemptId ? "attempt" : "legacy-unbound";
    const files = await getDb().evidenceFile.findMany({
      where: { sessionId: session.id, ...(Array.isArray(exactIds) ? { id: { in: exactIds } }
        : attemptId ? { attemptId } : { OR: [{ attemptId: null }, { attemptId: { isSet: false } }] }) },
      select: { id: true, fileType: true, label: true, createdAt: true, cloudinaryUrl: true, attemptId: true, captureMode: true },
      orderBy: { createdAt: "asc" }
    });
    const evidence = files.map((f) => {
      const { token } = signEvidenceAccess(String(f.id), { ttlSeconds: 15 * 60, tenantId: String(req.tenant.id) });
      return {
        evidenceId: String(f.id),
        fileType: f.fileType,
        label: f.label || null,
        attemptId: f.attemptId || null,
        captureMode: f.captureMode || null,
        createdAt: f.createdAt ? new Date(f.createdAt).toISOString() : null,
        cloudinaryUrl: f.cloudinaryUrl || null,
        // Signed URL to fetch decrypted image from the server
        serveUrl: `/v1/dashboard/evidence/${f.id}/image?token=${token}`
      };
    });
    res.json({ success: true, sessionId: req.params.sessionId, attemptId: attemptId || null, attribution, evidence });
  } catch (err) { next(err); }
});

// GET /v1/dashboard/evidence/:evidenceId/image?token=... — decrypt and serve an evidence image
// Token is HMAC-signed and expires in 15 min (signed in the /evidence listing above).
// No JWT required here — the signed token IS the auth (safe to embed in <img src>).
router.get("/evidence/:evidenceId/image", async (req, res, next) => {
  try {
    const evidenceId = req.params.evidenceId;
    const token = req.query.token;
    const { getDb } = require("../lib/db");
    const file = await getDb().evidenceFile.findFirst({ where: { id: String(evidenceId) } });
    if (!file) return res.status(404).json({ success: false, error: "Evidence file not found" });
    // M5 fix: bind the token to the tenant — look up via the evidence's session
    const evidenceSession = await getDb().verificationSession.findFirst({ where: { id: file.sessionId } });
    const fileTenantId = evidenceSession ? String(evidenceSession.tenantId) : null;
    if (!verifyEvidenceAccess(evidenceId, token, { tenantId: fileTenantId })) {
      return res.status(403).json({ success: false, error: "Invalid or expired evidence token" });
    }

    // Decrypt with the configured evidence key. In production, fail immediately
    // on key mismatch — never fall back to well-known dev keys (M4 fix).
    let imageBuffer = null;
    try {
      imageBuffer = await readEvidence(file.storagePath);
    } catch (primaryErr) {
      if (config.env === "production") {
        console.error("evidence decrypt failed in production — check EVIDENCE_ENCRYPTION_KEY", { evidenceId, err: primaryErr.message });
        throw new AppError("INTERNAL_ERROR", "Could not decrypt evidence (key mismatch)");
      }
      // Dev/test only: try SDK-token-derived fallback for locally-encrypted evidence
      const crypto = require("crypto");
      const sdkDerivedHex = crypto.createHash("sha256").update(`evidence:${config.sdkTokenSecret}`).digest("hex");
      try {
        imageBuffer = await readEvidence(file.storagePath, { key: sdkDerivedHex });
      } catch (e) {
        throw primaryErr; // surface the original error
      }
    }



    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "private, max-age=900");
    res.set("X-Content-Type-Options", "nosniff");
    res.send(imageBuffer);
  } catch (err) { next(err); }
});


// GET /v1/dashboard/sessions/:sessionId/attempts — end-user attempt history.
// Derived from the audit trail (the audit rows ARE the attempt counter — the
// same source the retry endpoint enforces its limit with, so they can't drift).
router.get("/sessions/:sessionId/attempts", anyUser, requireTenant, tenantScope, async (req, res, next) => {
  try {
    const session = await req.scopedDb.sessions.findByUid(req.params.sessionId);
    if (!session) throw new AppError("SESSION_NOT_FOUND");
    const logs = await req.scopedDb.auditLogs.list({ sessionId: session.id }, { take: 500 });
    const sorted = [...logs].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    const attempts = [{
      attempt: 1,
      startedAt: session.createdAt ? new Date(session.createdAt).toISOString() : null,
      trigger: "initial",
      events: []
    }];
    for (const l of sorted) {
      if (l.action === "session.retry") {
        attempts.push({
          attempt: attempts.length + 1,
          startedAt: l.createdAt ? new Date(l.createdAt).toISOString() : null,
          trigger: l.metadata?.manualUpload ? "retry_manual_upload" : "retry",
          events: []
        });
      } else if (["session.submitted", "verification.decided", "review.recapture", "review.approved", "review.rejected", "review.proposed"].includes(l.action)) {
        attempts[attempts.length - 1].events.push({
          action: l.action,
          at: l.createdAt ? new Date(l.createdAt).toISOString() : null,
          ...(l.metadata?.status ? { status: l.metadata.status } : {}),
          ...(l.metadata?.reasonCodes ? { reasonCodes: l.metadata.reasonCodes } : {})
        });
      }
    }

    res.json({
      success: true,
      sessionId: session.sessionUid,
      currentStatus: effectiveSessionStatus(session),
      attemptCount: attempts.length,
      attempts
    });
  } catch (err) { next(err); }
});

module.exports = router;
