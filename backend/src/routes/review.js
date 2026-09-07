"use strict";

// Manual review queue (PRD §9.10, §12.7). Dashboard-user auth (not API keys).

const { Router } = require("express");
const { AppError } = require("@verifypass/shared");
const { requireUser } = require("../middleware/userAuth");
const { tenantScope } = require("../middleware/tenantScope");
const { getDb } = require("../lib/db");
const { audit } = require("../services/auditLogger");
const { enqueue } = require("../services/jobService");
const email = require("../services/emailService");

const router = Router();
const reviewers = requireUser("super_admin", "tenant_admin", "compliance_reviewer");

function notify(promise) { Promise.resolve(promise).catch(err => console.error("email trigger failed:", err.message)); }

// C1: notify tenant reviewers when a case enters manual_review.
function notifyReviewWaiting(tenant, pendingCount, oldestWait) {
  if (!email.enabled()) return;
  (async () => {
    const reviewersList = await getDb().user.findMany({ where: { tenantId: String(tenant.id), role: { in: ["tenant_admin", "compliance_reviewer"] }, status: "active" } });
    for (const user of reviewersList) {
      await email.sendReviewWaiting(user, { companyName: tenant.companyName, pendingCount, oldestWait });
    }
  })().catch(err => console.error("review-waiting email failed:", err.message));
}

// C2: notify OTHER reviewers that a dual-approval proposal needs confirmation.
function notifySecondConfirmation(tenant, proposer, proposedDecision, caseAge) {
  if (!email.enabled()) return;
  (async () => {
    const others = await getDb().user.findMany({ where: { tenantId: String(tenant.id), role: { in: ["tenant_admin", "compliance_reviewer"] }, status: "active" } });
    for (const user of others) {
      if (String(user.id) === String(proposer.id)) continue; // not the proposer
      await email.sendReviewSecondConfirmation(user, { proposer: proposer.email, proposedDecision, caseAge });
    }
  })().catch(err => console.error("second-confirmation email failed:", err.message));
}

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
        waivedReasonCodes: s.decisionReason?.waivedReasonCodes || [],
        verificationType: s.verificationType || "ID_AND_FACE",
        attemptNumber: s.attemptNumber || 1,
        submittedAt: s.submittedAt ? new Date(s.submittedAt).toISOString() : null,
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

    // Maker-checker (four-eyes, tenant opt-in): terminal decisions need a
    // SECOND, DIFFERENT reviewer. The first reviewer's decision is recorded
    // as a proposal; the session stays in manual_review until confirmed.
    // Recapture is non-terminal and applies immediately.
    const { dualApprovalFor } = require("../services/settingsService");
    if (dualApprovalFor(req.tenant) && decision !== "recapture") {
      const notes = await db.manualReviewNote.findMany({ where: { sessionId: session.id } });
      const proposal = [...notes]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .find((n) => typeof n.decision === "string" && n.decision.startsWith("proposed:"));
      const proposedDecision = proposal ? proposal.decision.slice("proposed:".length) : null;

      if (!proposal || proposedDecision !== decision) {
        // First reviewer, or a different decision → (re)propose, don't apply.
        await db.manualReviewNote.create({
          data: { sessionId: session.id, userId: req.user.id, decision: `proposed:${decision}`, note: note || null }
        });
        await audit({
          tenantId: req.tenant.id, sessionId: session.id, actorType: "tenant_user",
          actorId: `user:${req.user.id}`, action: "review.proposed", req,
          metadata: { decision, note: note || null, superseded: proposedDecision || null }
        });
        const caseAge = session.createdAt ? `${Math.round((Date.now() - new Date(session.createdAt)) / 60000)} min` : "unknown";
        notifySecondConfirmation(req.tenant, req.user, decision === "approved" ? "approval" : "rejection", caseAge);
        return res.json({
          success: true, sessionId: session.sessionUid,
          status: "pending_second_approval", proposedDecision: decision
        });
      }
      if (String(proposal.userId) === String(req.user.id)) {
        throw new AppError("FORBIDDEN", "maker-checker: a different reviewer must confirm this decision");
      }
      // Second, distinct reviewer confirming the same decision → mark the
      // proposal consumed (a later re-review must not inherit it), then apply.
      await db.manualReviewNote.updateMany({
        where: { id: proposal.id },
        data: { decision: `applied:${decision}` }
      });
    }

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
      // verification.approved / verification.rejected — same event names as
      // the automatic path so consumers handle both identically; the
      // snapshot says a human decided and carries the original reason codes.
      await enqueue("send_webhook", {
        tenantId: String(req.tenant.id),
        sessionUid: session.sessionUid,
        attemptId: session.attemptId || null,
        event: `verification.${decision}`,
        snapshot: {
          status: decision,
          riskLevel: session.riskLevel || null,
          decisionSource: "manual_review",
          reasonCodes: session.decisionReason?.reasonCodes || [],
          attempt: session.attemptNumber || 1,
          attemptId: session.attemptId || null,
          completedAt: new Date().toISOString()
        }
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
