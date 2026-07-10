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

const router = Router();
const anyUser = requireUser(); // all roles may view

function requireTenant(req, _res, next) {
  if (!req.tenant) return next(new AppError("VALIDATION_ERROR", "X-Tenant-Id header required for super admin"));
  next();
}

// GET /v1/dashboard/stats
router.get("/stats", anyUser, requireTenant, tenantScope, async (req, res, next) => {
  try {
    const sessions = await req.scopedDb.sessions.list({});
    const byStatus = {};
    let totalCompletionMs = 0;
    let completedCount = 0;
    for (const s of sessions) {
      byStatus[s.status] = (byStatus[s.status] || 0) + 1;
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
    const where = req.query.status ? { status: req.query.status } : {};
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const sessions = await req.scopedDb.sessions.list(where, { orderBy: { createdAt: "desc" }, take: limit });
    res.json({
      success: true,
      sessions: sessions.map((s) => ({
        sessionId: s.sessionUid,
        customerReference: s.customerReference,
        status: s.status,
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
    const r = await req.scopedDb.results.latestForSession(session.id);
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
      status: session.status,
      riskLevel: session.riskLevel || null,
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
          status: r.faceMatchStatus,
          similarityScore: r.faceMatchScore != null ? Number(r.faceMatchScore) : null
        } : null
      } : {}),
      decision: {
        status: session.status,
        reasonCodes: session.decisionReason?.reasonCodes || []
      },
      // NDPA consent proof — when the user accepted, and which copy version
      consent: session.consentAt ? {
        at: new Date(session.consentAt).toISOString(),
        copyVersion: session.consentMeta?.copyVersion || null
      } : null,
      // Which pipeline judged this session + what evidence it saw — settles
      // "the photo is right there!" confusion (stale worker, type mismatch).
      diagnostics: r ? {
        pipelineVersion: r.rawResult?.pipelineVersion || null,
        missing: r.rawResult?.missing || null,
        evidenceTypesSeen: r.rawResult?.evidenceTypesSeen || null,
        document: r.rawResult?.document || null
      } : null,
      createdAt: session.createdAt ? new Date(session.createdAt).toISOString() : null,
      completedAt: session.completedAt ? new Date(session.completedAt).toISOString() : null,
      expiresAt: session.expiresAt ? new Date(session.expiresAt).toISOString() : null
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/dashboard/webhook-deliveries?status= — delivery log (JWT auth, Option A)
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
    const files = await getDb().evidenceFile.findMany({
      where: { sessionId: session.id },
      select: { id: true, fileType: true, label: true, createdAt: true, cloudinaryUrl: true, storagePath: true },
      orderBy: { createdAt: "asc" }
    });
    const evidence = files.map((f) => {
      const { token } = signEvidenceAccess(String(f.id), { ttlSeconds: 15 * 60 });
      return {
        evidenceId: String(f.id),
        fileType: f.fileType,
        label: f.label || null,
        createdAt: f.createdAt ? new Date(f.createdAt).toISOString() : null,
        cloudinaryUrl: f.cloudinaryUrl || null,
        // Signed URL to fetch decrypted image from the server
        serveUrl: `/v1/dashboard/evidence/${f.id}/image?token=${token}`
      };
    });
    res.json({ success: true, sessionId: req.params.sessionId, evidence });
  } catch (err) { next(err); }
});

// GET /v1/dashboard/evidence/:evidenceId/image?token=... — decrypt and serve an evidence image
// Token is HMAC-signed and expires in 15 min (signed in the /evidence listing above).
// No JWT required here — the signed token IS the auth (safe to embed in <img src>).
router.get("/evidence/:evidenceId/image", async (req, res, next) => {
  try {
    const evidenceId = req.params.evidenceId;
    const token = req.query.token;
    if (!verifyEvidenceAccess(evidenceId, token)) {
      return res.status(403).json({ success: false, error: "Invalid or expired evidence token" });
    }
    const { getDb } = require("../lib/db");
    const file = await getDb().evidenceFile.findFirst({ where: { id: String(evidenceId) } });
    if (!file) return res.status(404).json({ success: false, error: "Evidence file not found" });

    // readEvidence calls resolveKey(key) internally, so key must be a hex string (not a Buffer).
    // Try primary key (from .env), then SDK-derived fallback, then hard-coded dev fallback.
    const keysToTry = [
      config.evidenceEncryptionKey,              // 64-char hex from EVIDENCE_ENCRYPTION_KEY
      null                                       // null → resolveKey uses config.evidenceEncryptionKey itself
    ].filter((k, i, a) => a.indexOf(k) === i);  // deduplicate

    let imageBuffer = null;
    let lastErr;
    // First, try letting evidenceStore resolve the key normally (uses config values)
    try {
      imageBuffer = await readEvidence(file.storagePath);
    } catch (_) {
      // If that fails, the file was encrypted with a different key (e.g. missing env).
      // Try the SDK-token-derived fallback explicitly
      const crypto = require("crypto");
      const sdkDerivedHex = crypto.createHash("sha256").update(`evidence:${config.sdkTokenSecret}`).digest("hex");
      const devHex = crypto.createHash("sha256").update("evidence:dev-only-secret").digest("hex");
      for (const keyHex of [sdkDerivedHex, devHex]) {
        try {
          imageBuffer = await readEvidence(file.storagePath, { key: keyHex });
          break;
        } catch (e) { lastErr = e; }
      }
    }
    if (!imageBuffer) throw lastErr || new Error("Could not decrypt evidence with any known key");



    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "private, max-age=900");
    res.set("X-Content-Type-Options", "nosniff");
    res.send(imageBuffer);
  } catch (err) { next(err); }
});


// GET /v1/dashboard/sessions/:sessionId/attempts — end-user attempt history.
// Derived from the audit trail (the audit rows ARE the attempt counter — the
// same source the retry endpoint enforces its limit with, so they can't drift).
router.get("/sessions/:sessionId/attempts", async (req, res, next) => {
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
      currentStatus: session.status,
      attemptCount: attempts.length,
      attempts
    });
  } catch (err) { next(err); }
});

module.exports = router;
