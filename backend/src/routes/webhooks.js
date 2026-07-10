"use strict";

// Webhook configuration + delivery visibility (PRD §9.11, §12.9).
// Secret-key auth (server-to-server, like session creation).

const crypto = require("crypto");
const { Router } = require("express");
const { AppError } = require("@verifypass/shared");
const { requireApiKey } = require("../middleware/auth");
const { tenantScope } = require("../middleware/tenantScope");
const { getDb } = require("../lib/db");
const { audit } = require("../services/auditLogger");
const { enqueue } = require("../services/jobService");

const router = Router();
router.use(requireApiKey("secret"), tenantScope);

// PUT /v1/webhooks/config {url} — sets URL, rotates signing secret (returned once)
router.put("/config", async (req, res, next) => {
  try {
    const { url } = req.body || {};
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      throw new AppError("VALIDATION_ERROR", "url is not a valid URL");
    }
    if (parsed.protocol !== "https:" && process.env.NODE_ENV === "production") {
      throw new AppError("VALIDATION_ERROR", "webhook url must be https");
    }
    const secret = `whsec_${crypto.randomBytes(24).toString("base64url")}`;
    await getDb().tenant.updateMany({
      where: { id: req.tenant.id },
      data: { webhookUrl: url, webhookSecret: secret }
    });
    await audit({
      tenantId: req.tenant.id, actorType: "api", actorId: `key:${req.apiKey.prefix}`,
      action: "webhook.config_updated", req, metadata: { url }
    });
    res.json({ success: true, url, secret }); // secret shown once — store it now
  } catch (err) {
    next(err);
  }
});

// GET /v1/webhooks/deliveries?status=&limit=
router.get("/deliveries", async (req, res, next) => {
  try {
    const where = req.query.status ? { status: req.query.status } : {};
    const deliveries = await req.scopedDb.webhookDeliveries.list(where, { orderBy: { id: "desc" }, take: 100 });
    res.json({
      success: true,
      deliveries: deliveries.map((d) => ({
        eventId: d.eventUid,
        event: d.event,
        status: d.status,
        attempts: d.attempts,
        lastStatusCode: d.lastStatusCode,
        lastError: d.lastError,
        nextAttemptAt: d.nextAttemptAt ? new Date(d.nextAttemptAt).toISOString() : null,
        deliveredAt: d.deliveredAt ? new Date(d.deliveredAt).toISOString() : null,
        createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null
      }))
    });
  } catch (err) {
    next(err);
  }
});

// POST /v1/webhooks/:eventId/retry (PRD §12.9)
router.post("/:eventId/retry", async (req, res, next) => {
  try {
    const delivery = await req.scopedDb.webhookDeliveries.findByUid(req.params.eventId);
    if (!delivery) throw new AppError("NOT_FOUND", "Delivery not found");
    if (delivery.status === "delivered") throw new AppError("VALIDATION_ERROR", "Already delivered");

    await enqueue("send_webhook", { deliveryId: String(delivery.id) });
    await audit({
      tenantId: req.tenant.id, actorType: "api", actorId: `key:${req.apiKey.prefix}`,
      action: "webhook.manual_retry", req, metadata: { eventId: req.params.eventId }
    });
    res.status(202).json({ success: true, eventId: req.params.eventId, status: "queued" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
