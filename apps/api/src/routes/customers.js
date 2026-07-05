"use strict";

// Biometric data deletion (PRD §12.8, NDPA data-subject rights).

const { Router } = require("express");
const { requireApiKey } = require("../middleware/auth");
const { tenantScope } = require("../middleware/tenantScope");
const { deleteBiometricData } = require("../services/deletionService");
const { audit } = require("../services/auditLogger");

const router = Router();
router.use(requireApiKey("secret"), tenantScope);

// DELETE /v1/customers/:customerReference/biometric-data
router.delete("/:customerReference/biometric-data", async (req, res, next) => {
  try {
    const ref = req.params.customerReference;
    const result = await deleteBiometricData(req.scopedDb, ref);
    await audit({
      tenantId: req.tenant.id, actorType: "api", actorId: `key:${req.apiKey.prefix}`,
      action: "customer.biometric_data_deleted", req,
      metadata: { customerReference: ref, ...result }
    });
    res.json({ success: true, customerReference: ref, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
