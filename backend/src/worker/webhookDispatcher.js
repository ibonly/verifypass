"use strict";

// send_webhook job handler (PRD §9.11). Retry schedule: 1m, 5m, 30m, 2h, 12h.
// Each attempt is recorded on the webhook_deliveries row; retries are new
// queue jobs referencing the same delivery (idempotent, survives restarts).

const crypto = require("crypto");
const { webhookHeaders } = require("@verifypass/shared");

const RETRY_SCHEDULE_SECONDS = [60, 300, 1800, 7200, 43200];
const MAX_ATTEMPTS = RETRY_SCHEDULE_SECONDS.length;
const TIMEOUT_MS = 10000;

/**
 * @param {object} payload job payload:
 *   fresh event: {tenantId, sessionUid, event}
 *   retry:       {deliveryId}
 * @param {object} deps {db, fetchImpl, now}
 */
async function sendWebhook(payload, { db, fetchImpl, now = () => new Date(), enqueueJob } = {}) {
  const doFetch = fetchImpl || fetch;
  // Retry scheduling goes through the injected dispatch in Lambda/SQS
  // topologies; the polling worker keeps using job_queue rows.
  const dispatch = enqueueJob || ((type, jobPayload, { runAfter = now(), maxAttempts = 1 } = {}) =>
    db.jobQueue.create({ data: { type, payload: jobPayload, status: "pending", runAfter, maxAttempts } }));

  let delivery;
  if (payload.deliveryId) {
    delivery = await db.webhookDelivery.findFirst({ where: { id: payload.deliveryId } });
    if (!delivery) throw new Error(`webhook delivery ${payload.deliveryId} not found`);
    if (delivery.status === "delivered") return { skipped: true };
  } else {
    delivery = await createDelivery(payload, { db, now });
    if (!delivery) return { skipped: true, reason: "tenant has no webhook configured" };
  }

  const tenant = await db.tenant.findFirst({ where: { id: delivery.tenantId } });
  if (!tenant?.webhookUrl || !tenant?.webhookSecret) {
    await db.webhookDelivery.updateMany({ where: { id: delivery.id }, data: { status: "failed", lastError: "webhook not configured" } });
    return { skipped: true };
  }

  const body = JSON.stringify(delivery.payload);
  const attempts = (delivery.attempts || 0) + 1;

  let statusCode = null;
  let error = null;
  try {
    const res = await doFetch(tenant.webhookUrl, {
      method: "POST",
      headers: webhookHeaders(body, tenant.webhookSecret, { event: delivery.event }),
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    statusCode = res.status;
    if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
  } catch (err) {
    error = err.message;
  }

  if (!error) {
    await db.webhookDelivery.updateMany({
      where: { id: delivery.id },
      data: { status: "delivered", attempts, lastStatusCode: statusCode, lastError: null, deliveredAt: now(), nextAttemptAt: null }
    });
    return { delivered: true, attempts };
  }

  const exhausted = attempts >= MAX_ATTEMPTS;
  const nextAt = exhausted ? null : new Date(now().getTime() + RETRY_SCHEDULE_SECONDS[attempts - 1] * 1000);
  await db.webhookDelivery.updateMany({
    where: { id: delivery.id },
    data: {
      status: exhausted ? "exhausted" : "failed",
      attempts,
      lastStatusCode: statusCode,
      lastError: String(error).slice(0, 500),
      nextAttemptAt: nextAt
    }
  });
  if (!exhausted) {
    // scheduling is managed here, not by generic job retry
    await dispatch("send_webhook", { deliveryId: delivery.id }, { runAfter: nextAt, maxAttempts: 1 });
  }
  return { delivered: false, attempts, exhausted };
}

async function createDelivery({ tenantId, sessionUid, event }, { db, now }) {
  // tenantId travels through job payloads as a string — MongoDB ObjectId ids
  // are strings end to end, no coercion needed.
  const tenant = await db.tenant.findFirst({ where: { id: String(tenantId) } });
  if (!tenant?.webhookUrl || !tenant?.webhookSecret) return null;

  const session = await db.verificationSession.findFirst({ where: { sessionUid } });
  const eventUid = `evt_${crypto.randomBytes(12).toString("hex")}`;

  // Attempt number: the end-user retry flow re-verifies the SAME session, so
  // consumers can receive several terminal events for one sessionId (e.g.
  // verification.rejected then verification.approved). `attempt` lets them
  // order and de-duplicate; the latest attempt always supersedes.
  let attempt = 1;
  if (session) {
    const retries = await db.auditLog.findMany({
      where: { sessionId: session.id, action: "session.retry" }
    });
    attempt = retries.length + 1;
  }

  // Payload per PRD §9.11
  const body = {
    event,
    tenantId: tenant.tenantUid,
    sessionId: sessionUid,
    customerReference: session?.customerReference || null,
    status: session?.status || null,
    riskLevel: session?.riskLevel || null,
    attempt,
    createdAt: session?.createdAt ? new Date(session.createdAt).toISOString() : null,
    completedAt: session?.completedAt ? new Date(session.completedAt).toISOString() : null
  };

  return db.webhookDelivery.create({
    data: {
      eventUid,
      tenantId: tenant.id,
      sessionId: session?.id || null,
      event,
      payload: body,
      url: tenant.webhookUrl,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now()
    }
  });
}

module.exports = { sendWebhook, RETRY_SCHEDULE_SECONDS, MAX_ATTEMPTS };
