"use strict";

const { getDb } = require("../lib/db");

/**
 * Append an audit event (PRD §9.12). Never throws — audit failure must not
 * break the request, but is logged loudly for ops.
 */
async function audit({ tenantId = null, sessionId = null, actorType, actorId = null, action, req = null, metadata = null, riskEvent = false }) {
  try {
    await getDb().auditLog.create({
      data: {
        tenantId,
        sessionId,
        actorType,
        actorId,
        action,
        ipAddress: req ? (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null) : null,
        userAgent: req ? (req.headers["user-agent"] || null) : null,
        metadata,
        riskEvent
      }
    });
  } catch (err) {
    console.error("AUDIT_WRITE_FAILED", { action, tenantId: String(tenantId), err: err.message });
  }
}

module.exports = { audit };
