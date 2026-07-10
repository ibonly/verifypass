"use strict";

// Advanced audit reports (PRD §22). Dashboard-user auth; auditor role has
// read access by design (PRD §21 read-only auditor). Every export is
// audit-logged with report type and parameters. Formats: json | csv.
// (PDF export lands with the evidence-PDF generator, which shares a renderer.)

const { Router } = require("express");
const { AppError } = require("@verifypass/shared");
const { requireUser } = require("../middleware/userAuth");
const { tenantScope } = require("../middleware/tenantScope");
const { audit } = require("../services/auditLogger");
const { toCsv } = require("../services/csv");
const reports = require("../services/reportService");

const router = Router();
const readers = requireUser("super_admin", "tenant_admin", "compliance_reviewer", "auditor");

function requireTenant(req, _res, next) {
  if (!req.tenant) return next(new AppError("VALIDATION_ERROR", "X-Tenant-Id header required for super admin"));
  next();
}
router.use(readers, requireTenant, tenantScope);

function send(res, req, { name, rows, columns, wrap }) {
  const format = String(req.query.format || "json").toLowerCase();
  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="verifypass-${name}-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send(toCsv(rows, columns));
  }
  return res.json({ success: true, ...(wrap ? { [wrap]: rows } : rows) });
}

async function logExport(req, name) {
  await audit({
    tenantId: req.tenant.id, actorType: "tenant_user", actorId: `user:${req.user.id}`,
    action: "report.exported", req,
    metadata: { report: name, format: req.query.format || "json", days: req.query.days || null }
  });
}

// GET /v1/reports/volume?days=30&format=csv
router.get("/volume", async (req, res, next) => {
  try {
    const rows = await reports.dailyVolume(req.scopedDb, { days: req.query.days });
    await logExport(req, "volume");
    send(res, req, {
      name: "volume", rows, wrap: "days",
      columns: ["date", "total", "approved", "rejected", "manual_review", "expired", "failed", "abandoned"]
        .map((k) => ({ key: k, header: k }))
    });
  } catch (err) { next(err); }
});

// GET /v1/reports/rejection-reasons?days=30
router.get("/rejection-reasons", async (req, res, next) => {
  try {
    const rows = await reports.topReasons(req.scopedDb, { days: req.query.days });
    await logExport(req, "rejection-reasons");
    send(res, req, {
      name: "rejection-reasons", rows, wrap: "reasons",
      columns: [{ key: "reasonCode", header: "reasonCode" }, { key: "count", header: "count" }]
    });
  } catch (err) { next(err); }
});

// GET /v1/reports/webhook-failures
router.get("/webhook-failures", async (req, res, next) => {
  try {
    const rows = await reports.webhookFailures(req.scopedDb);
    await logExport(req, "webhook-failures");
    send(res, req, {
      name: "webhook-failures", rows, wrap: "deliveries",
      columns: ["eventId", "event", "status", "attempts", "lastStatusCode", "lastError", "createdAt"]
        .map((k) => ({ key: k, header: k }))
    });
  } catch (err) { next(err); }
});

// GET /v1/reports/risk-events?days=30
router.get("/risk-events", async (req, res, next) => {
  try {
    const rows = await reports.riskEvents(req.scopedDb, { days: req.query.days });
    await logExport(req, "risk-events");
    send(res, req, {
      name: "risk-events", rows, wrap: "events",
      columns: ["createdAt", "action", "actorType", "actorId", "sessionId", "ipAddress", "metadata"]
        .map((k) => ({ key: k, header: k }))
    });
  } catch (err) { next(err); }
});

// GET /v1/reports/audit-log?days=30
router.get("/audit-log", async (req, res, next) => {
  try {
    const rows = await reports.auditExport(req.scopedDb, { days: req.query.days });
    await logExport(req, "audit-log");
    send(res, req, {
      name: "audit-log", rows, wrap: "entries",
      columns: ["createdAt", "action", "actorType", "actorId", "sessionId", "ipAddress", "riskEvent", "metadata"]
        .map((k) => ({ key: k, header: k }))
    });
  } catch (err) { next(err); }
});

// GET /v1/reports/sessions/:sessionId/evidence.pdf — full case file
router.get("/sessions/:sessionId/evidence.pdf", async (req, res, next) => {
  try {
    const { buildEvidencePdf } = require("../services/evidencePdfService");
    const pdf = await buildEvidencePdf(req.scopedDb, req.tenant, req.params.sessionId);
    await audit({
      tenantId: req.tenant.id, actorType: "tenant_user", actorId: `user:${req.user.id}`,
      action: "report.evidence_pdf_exported", req,
      metadata: { sessionId: req.params.sessionId, bytes: pdf.length }
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="verifypass-case-${req.params.sessionId}.pdf"`);
    res.send(pdf);
  } catch (err) { next(err); }
});

// GET /v1/reports/customers/:customerReference/history — compliance export
router.get("/customers/:customerReference/history", async (req, res, next) => {
  try {
    const data = await reports.customerHistory(req.scopedDb, req.params.customerReference);
    await audit({
      tenantId: req.tenant.id, actorType: "tenant_user", actorId: `user:${req.user.id}`,
      action: "report.customer_history_exported", req,
      metadata: { customerReference: req.params.customerReference, format: req.query.format || "json" }
    });
    if (String(req.query.format).toLowerCase() === "csv") {
      return send(res, req, {
        name: `customer-${req.params.customerReference}`, rows: data.sessions,
        columns: [
          { key: "sessionId", header: "sessionId" }, { key: "status", header: "status" },
          { key: "riskLevel", header: "riskLevel" }, { key: "reasonCodes", header: "reasonCodes" },
          { key: "scores.liveness", header: "livenessScore" }, { key: "scores.faceMatch", header: "faceMatchScore" },
          { key: "createdAt", header: "createdAt" }, { key: "completedAt", header: "completedAt" }
        ]
      });
    }
    res.json({ success: true, ...data });
  } catch (err) { next(err); }
});

module.exports = router;
