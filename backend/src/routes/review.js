"use strict";

// Manual review queue (PRD §9.10, §12.7). Dashboard-user auth (not API keys).

const { Router } = require("express");
const { AppError } = require("@verifypass/shared");
const { requireUser } = require("../middleware/userAuth");
const { tenantScope } = require("../middleware/tenantScope");
const { getDb } = require("../lib/db");
const { audit } = require("../services/auditLogger");
const { enqueue } = require("../services/jobService");

const router = Router();
const reviewers = requireUser("super_admin", "tenant_admin", "compliance_reviewer");

function requireTenant(req, _res, next) {
  if (!req.tenant) return next(new AppError("VALIDATION_ERROR", "X-Tenant-Id header required for super admin"));
  next();
}

// GET /v1/manual-review?status=manual_review&limit=50
router.get("/", reviewers, requireTenant, tenantScope, async (req, res, next) => {
  try {
    const status = req.query.status || "manual_review";
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const sessions = await req.scopedDb.sessions.list({ status }, { orderBy: { createdAt: "desc" }, take: limit });

    const cases = await Promise.all(sessions.map(async (s) => {
      const r = await req.scopedDb.results.latestForSession(s.id);
      return {
        sessionId: s.sessionUid,
        customerReference: s.customerReference,
        status: s.status,
        riskLevel: s.riskLevel,
        reasonCodes: s.decisionReason?.reasonCodes || [],
        scores: r ? {
          liveness: r.livenessScore != null ? Number(r.livenessScore) : null,
          faceMatch: r.faceMatchScore != null ? Number(r.faceMatchScore) : null,
          ocrConfidence: r.ocrConfidence != null ? Number(r.ocrConfidence) : null
        } : null,
        extractedData: r?.extractedData || null,
        createdAt: s.createdAt ? new Date(s.createdAt).toISOString() : null
      };
    }));

    await audit({
      tenantId: req.tenant.id, actorType: "tenant_user", actorId: `user:${req.user.id}`,
      action: "review.queue_viewed", req, metadata: { status, count: cases.length }
    });
    res.json({ success: true, cases });
  } catch (err) {
    next(err);
  }
});

// POST /v1/manual-review/:sessionId/decision {decision: approved|rejected|recapture, note}
router.post("/:sessionId/decision", reviewers, requireTenant, tenantScope, async (req, res, next) => {
  try {
    const { decision, note } = req.body || {};
    if (!["approved", "rejected", "recapture"].includes(decision)) {
      throw new AppError("VALIDATION_ERROR", "decision must be approved, rejected, or recapture");
    }
    const session = await req.scopedDb.sessions.findByUid(req.params.sessionId);
    if (!session) throw new AppError("SESSION_NOT_FOUND");
    if (session.status !== "manual_review") {
      throw new AppError("VALIDATION_ERROR", `session is '${session.status}', not manual_review`);
    }

    const db = getDb();
    await db.manualReviewNote.create({
      data: { sessionId: session.id, userId: req.user.id, decision, note: note || null }
    });

    if (decision === "recapture") {
      // Re-open for new captures; extend expiry window
      await req.scopedDb.sessions.update(session.sessionUid, {
        status: "started",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000)
      });
    } else {
      await req.scopedDb.sessions.update(session.sessionUid, {
        status: decision,
        completedAt: new Date()
      });
      await enqueue("send_webhook", {
        tenantId: String(req.tenant.id),
        sessionUid: session.sessionUid,
        event: `verification.${decision}`
      });
    }

    await audit({
      tenantId: req.tenant.id, sessionId: session.id, actorType: "tenant_user",
      actorId: `user:${req.user.id}`, action: `review.${decision}`, req,
      metadata: { note: note || null }, riskEvent: decision === "rejected"
    });
    res.json({ success: true, sessionId: session.sessionUid, status: decision === "recapture" ? "started" : decision });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
