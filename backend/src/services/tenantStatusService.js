"use strict";

// Tenant status transitions with an email notification (C5). Any path that
// suspends/disables/reactivates a tenant should go through here so the
// tenant's admins are told why their integration changed.

const { getDb } = require("../lib/db");
const email = require("./emailService");
const { audit } = require("./auditLogger");

const ALLOWED = ["sandbox", "active", "suspended", "disabled"];

async function setTenantStatus(tenantUid, status, { reasonCategory = "policy", actor = "platform" } = {}) {
  if (!ALLOWED.includes(status)) throw new Error(`status must be one of ${ALLOWED.join(", ")}`);
  const db = getDb();
  const tenant = await db.tenant.findFirst({ where: { tenantUid } });
  if (!tenant) throw new Error(`tenant ${tenantUid} not found`);
  if (tenant.status === status) return { changed: false, status };

  await db.tenant.updateMany({ where: { id: tenant.id }, data: { status } });
  await audit({ tenantId: tenant.id, actorType: "admin", actorId: actor, action: "tenant.status_changed", metadata: { from: tenant.status, to: status, reasonCategory } });

  if (email.enabled()) {
    (async () => {
      const admins = await db.user.findMany({ where: { tenantId: String(tenant.id), role: "tenant_admin", status: "active" } });
      for (const admin of admins) {
        await email.sendWorkspaceStatus(admin, { companyName: tenant.companyName, statusChange: status, reasonCategory });
      }
    })().catch(err => console.error("workspace-status email failed:", err.message));
  }
  return { changed: true, from: tenant.status, status };
}

module.exports = { setTenantStatus, ALLOWED };
