"use strict";

const { AppError } = require("@verifypass/shared");
const { verifyToken } = require("../services/authTokens");
const { getDb } = require("../lib/db");
const { audit } = require("../services/auditLogger");

/**
 * Dashboard user auth + RBAC (PRD §21).
 * Attaches req.user and req.tenant. Super admins act on a tenant by passing
 * X-Tenant-Id (tenantUid); every impersonation is audit-logged.
 */
function requireUser(...allowedRoles) {
  return async function userAuth(req, res, next) {
    try {
      const [scheme, token] = String(req.headers.authorization || "").split(" ");
      const payload = scheme === "Bearer" ? verifyToken(token) : null;
      if (!payload) throw new AppError("FORBIDDEN", "Sign in required");

      const db = getDb();
      const user = await db.user.findFirst({ where: { id: Number(payload.userId), status: "active" } });
      if (!user) throw new AppError("FORBIDDEN", "Sign in required");
      if (allowedRoles.length && !allowedRoles.includes(user.role)) {
        throw new AppError("FORBIDDEN", "Insufficient role");
      }

      let tenant = null;
      if (user.role === "super_admin") {
        const tenantUid = req.headers["x-tenant-id"];
        if (tenantUid) {
          tenant = await db.tenant.findFirst({ where: { tenantUid: String(tenantUid) } });
          if (!tenant) throw new AppError("NOT_FOUND", "Tenant not found");
          await audit({
            tenantId: tenant.id, actorType: "admin", actorId: `user:${user.id}`,
            action: "admin.impersonated_tenant", req
          });
        }
      } else {
        tenant = await db.tenant.findFirst({ where: { id: user.tenantId } });
        if (!tenant || ["suspended", "disabled"].includes(tenant.status)) {
          throw new AppError("FORBIDDEN", "Tenant unavailable");
        }
      }

      req.user = user;
      req.tenant = tenant;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireUser };
