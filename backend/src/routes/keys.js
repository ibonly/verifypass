"use strict";

const { Router } = require("express");
const { requireApiKey } = require("../middleware/auth");
const { tenantScope } = require("../middleware/tenantScope");
const { rotateKey, revokeKey } = require("../services/apiKeyService");
const { audit } = require("../services/auditLogger");

const router = Router();

router.use(requireApiKey("secret"), tenantScope);

// GET /v1/api-keys — list key metadata (never plaintext)
router.get("/", async (req, res, next) => {
  try {
    const keys = await req.scopedDb.apiKeys.list();
    res.json({ success: true, keys: keys.map((k) => ({ ...k, id: String(k.id) })) });
  } catch (err) {
    next(err);
  }
});

// POST /v1/api-keys/:id/rotate
router.post("/:id/rotate", async (req, res, next) => {
  try {
    const issued = await rotateKey(req.tenant.id, String(req.params.id));
    await audit({
      tenantId: req.tenant.id, actorType: "api", actorId: `key:${req.apiKey.prefix}`,
      action: "api_key.rotated", req, metadata: { oldKeyId: req.params.id }
    });
    res.json({ success: true, key: issued.key, prefix: issued.prefix, id: String(issued.id) });
  } catch (err) {
    next(err);
  }
});

// POST /v1/api-keys/:id/revoke
router.post("/:id/revoke", async (req, res, next) => {
  try {
    await revokeKey(req.tenant.id, String(req.params.id));
    await audit({
      tenantId: req.tenant.id, actorType: "api", actorId: `key:${req.apiKey.prefix}`,
      action: "api_key.revoked", req, metadata: { keyId: req.params.id }
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
