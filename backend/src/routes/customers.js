"use strict";

// Biometric data deletion (PRD §12.8, NDPA data-subject rights).

const { Router } = require("express");
const { requireApiKey } = require("../middleware/auth");
const { tenantScope } = require("../middleware/tenantScope");
const { deleteBiometricData } = require("../services/deletionService");
const { audit } = require("../services/auditLogger");
const email = require("../services/emailService");
const { getDb } = require("../lib/db");
const crypto = require("crypto");

const router = Router();
router.use(requireApiKey("secret"), tenantScope);

// DELETE /v1/customers/:customerReference/biometric-data
router.delete("/:customerReference/biometric-data", async (req, res, next) => {
  try {
    const ref = req.params.customerReference;
    const result = await deleteBiometricData(req.scopedDb, ref);
    const auditRef = `del_${crypto.randomBytes(8).toString("hex")}`;
    await audit({
      tenantId: req.tenant.id, actorType: "api", actorId: `key:${req.apiKey.prefix}`,
      action: "customer.biometric_data_deleted", req,
      metadata: { auditRef, customerReference: ref, ...result }
    });
    // D1: confirm fulfilment to the tenant's admins with the audit reference.
    if (email.enabled()) {
      (async () => {
        const admins = await getDb().user.findMany({ where: { tenantId: String(req.tenant.id), role: "tenant_admin", status: "active" } });
        for (const admin of admins) {
          await email.sendDeletionCompleted(admin, { auditRef, sessionsAffected: result.sessionsAffected, filesDeleted: result.filesDeleted });
        }
      })().catch(err => console.error("deletion-completed email failed:", err.message));
    }
    res.json({ success: true, customerReference: ref, auditRef, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
