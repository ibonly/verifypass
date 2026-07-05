"use strict";

// Tenant dashboard data (PRD §9.13). Counts computed in JS at MVP scale;
// swap to SQL GROUP BY when volume warrants.

const { Router } = require("express");
const { AppError } = require("@verifypass/shared");
const { requireUser } = require("../middleware/userAuth");
const { tenantScope } = require("../middleware/tenantScope");

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
    const sessions = await req.scopedDb.sessions.list(where, { orderBy: { id: "desc" }, take: limit });
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

module.exports = router;
