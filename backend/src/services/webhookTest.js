"use strict";

const crypto = require("crypto");
const { AppError } = require("@verifypass/shared");
const { transaction } = require("./atomic");
const { addOutbox, flushOutbox } = require("./outbox");

// Persist the visible delivery and its dispatch intent together. A queue outage
// leaves a pending outbox row for the worker to recover, never an invisible test.
async function queueWebhookTest(tenant, { db, enqueue }) {
  if (!tenant.webhookUrl || !tenant.webhookSecret) {
    throw new AppError("VALIDATION_ERROR", "Configure a webhook endpoint first");
  }
  const eventUid = `evt_${crypto.randomBytes(12).toString("hex")}`;
  await transaction(db, async tx => {
    const delivery = await tx.webhookDelivery.create({ data: {
      eventUid, tenantId: tenant.id, event: "webhook.test",
      payload: { event: "webhook.test", eventId: eventUid, tenantId: tenant.tenantUid, test: true, createdAt: new Date().toISOString() },
      url: tenant.webhookUrl, status: "pending", attempts: 0, nextAttemptAt: new Date()
    } });
    await addOutbox(tx, "send_webhook", { deliveryId: delivery.id });
  });
  await flushOutbox(db, enqueue);
  return { success: true, eventId: eventUid, status: "queued" };
}

module.exports = { queueWebhookTest };
