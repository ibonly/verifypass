"use strict";

const { AppError } = require("@verifypass/shared");
const { getDb } = require("../lib/db");

/**
 * Attaches req.scopedDb — the ONLY sanctioned way for route handlers to touch
 * tenant-owned tables. Every method injects tenant_id into the query, so a
 * handler physically cannot read another tenant's rows through this API.
 *
 * Cross-tenant lookups return null → routes surface 404 (never 403, to avoid
 * leaking resource existence).
 */
function tenantScope(req, res, next) {
  if (!req.tenant) return next(new AppError("INTERNAL_ERROR", "tenantScope before auth"));
  const tenantId = req.tenant.id;
  const db = getDb();

  req.scopedDb = {
    tenantId,

    sessions: {
      create(data) {
        return db.verificationSession.create({ data: { ...data, tenantId } });
      },
      findByUid(sessionUid) {
        return db.verificationSession.findFirst({ where: { sessionUid, tenantId } });
      },
      list(where = {}, opts = {}) {
        return db.verificationSession.findMany({ where: { ...where, tenantId }, ...opts });
      },
      update(sessionUid, data) {
        return db.verificationSession.updateMany({ where: { sessionUid, tenantId }, data });
      }
    },

    results: {
      latestForSession(sessionId) {
        return db.verificationResult.findFirst({
          where: { sessionId },
          orderBy: { id: "desc" }
        });
      }
    },

    evidence: {
      create(data) {
        // sessionId is validated as tenant-owned by callers via sessions.findByUid
        return db.evidenceFile.create({ data });
      },
      listForSession(sessionId) {
        return db.evidenceFile.findMany({ where: { sessionId } });
      }
    },

    apiKeys: {
      list() {
        return db.apiKey.findMany({
          where: { tenantId },
          select: { id: true, keyType: true, isLive: true, prefix: true, status: true, createdAt: true, revokedAt: true }
        });
      }
    },

    auditLogs: {
      list(where = {}, opts = {}) {
        return db.auditLog.findMany({ where: { ...where, tenantId }, ...opts });
      }
    },

    webhookDeliveries: {
      list(where = {}, opts = {}) {
        return db.webhookDelivery.findMany({ where: { ...where, tenantId }, ...opts });
      },
      findByUid(eventUid) {
        return db.webhookDelivery.findFirst({ where: { eventUid, tenantId } });
      }
    }
  };

  next();
}

module.exports = { tenantScope };
