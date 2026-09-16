"use strict";

// send_webhook job handler (PRD §9.11). Retry schedule: 1m, 5m, 30m, 2h, 12h.
// Each attempt is recorded on the webhook_deliveries row; retries are new
// queue jobs referencing the same delivery (idempotent, survives restarts).

const crypto = require("crypto");
const { webhookHeaders } = require("@verifypass/shared");


const { validateWebhookTarget, isPrivateIp } = require("../lib/webhookTarget");

const RETRY_SCHEDULE_SECONDS = [60, 300, 1800, 7200, 43200];
const MAX_ATTEMPTS = RETRY_SCHEDULE_SECONDS.length + 1;
const TIMEOUT_MS = 10000;

// C3: alert tenant admins when delivery is exhausted — the primary channel
// (webhook) is the thing that broke, so email is the fallback. Throttled
// per-tenant via the queue's idempotency; fire-and-forget.
function notifyWebhookExhausted(tenant, delivery, attempts, error) {
  const email = require("../services/emailService");
  if (!email.enabled()) return;
  (async () => {
    const { getDb } = require("../lib/db");
    const host = tenant.webhookUrl ? new URL(tenant.webhookUrl).host : "unknown";
    const errorClass = /SSRF/.test(error) ? "blocked address" : /HTTP/.test(error) ? error : "connection/timeout";
    const admins = await getDb().user.findMany({ where: { tenantId: String(tenant.id), role: "tenant_admin", status: "active" } });
    for (const admin of admins) {
      await email.sendWebhookFailing(admin, { endpointHost: host, errorClass, attempts });
    }
  })().catch(err => console.error("webhook-exhausted email failed:", err.message));
}

/**
 * @param {object} payload job payload:
 *   fresh event: {tenantId, sessionUid, event}
 *   retry:       {deliveryId}
 * @param {object} deps {db, fetchImpl, now}
 */
async function sendWebhook(payload, deps = {}) {
  const { db, fetchImpl, now = () => new Date(), enqueueJob } = deps;
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

  if (delivery.status === "delivered") return { skipped: true };
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
    await (deps.validateTarget || validateWebhookTarget)(tenant.webhookUrl);
    const res = await doFetch(tenant.webhookUrl, {
      method: "POST",
      redirect: "error",
      headers: webhookHeaders(body, tenant.webhookSecret, { event: delivery.event }),
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    statusCode = res.status;
    if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
  } catch (err) {
    if (err.code === "WEBHOOK_TARGET_BLOCKED") {
      await db.webhookDelivery.updateMany({
        where: { id: delivery.id },
        data: { status: "failed", attempts, lastStatusCode: null, nextAttemptAt: null, lastError: `SSRF blocked: ${err.message}` }
      });
      return { delivered: false, attempts, blocked: true, reason: err.message };
    }
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
  } else {
    notifyWebhookExhausted(tenant, delivery, attempts, error || "unknown");
  }
  return { delivered: false, attempts, exhausted };
}

async function createDelivery({ tenantId, sessionUid, event, eventUid: suppliedEventUid, snapshot }, { db, now }) {
  // tenantId travels through job payloads as a string — MongoDB ObjectId ids
  // are strings end to end, no coercion needed.
  const tenant = await db.tenant.findFirst({ where: { id: String(tenantId) } });
  if (!tenant?.webhookUrl || !tenant?.webhookSecret) return null;

  const session = sessionUid ? await db.verificationSession.findFirst({ where: { sessionUid, tenantId: tenant.id } }) : null;
  const eventUid = suppliedEventUid || `evt_${crypto.randomBytes(12).toString("hex")}`;
  const existing = await db.webhookDelivery.findFirst({ where: { eventUid } });
  if (existing) return existing;

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

  // When minimalPayload is set on passed verification, send service id and all selfie ids only.
  // Additional details will be added later once tested per consumer requirements.
  let body;
  if (snapshot?.minimalPayload && (event === "verification.approved" || snapshot?.status === "approved")) {
    body = {
      serviceId: snapshot.serviceId || sessionUid,
      service_id: snapshot.serviceId || sessionUid,
      sessionId: sessionUid,
      selfieId: snapshot.selfieId || (snapshot.selfieIds && snapshot.selfieIds[0]) || null,
      selfieIds: snapshot.selfieIds || [],
      selfie_ids: snapshot.selfieIds || []
    };
  } else {
    // Payload per PRD §9.11
    body = {
      event,
      tenantId: tenant.tenantUid,
      sessionId: sessionUid,
      customerReference: session?.customerReference || null,
      status: session?.status || null,
      riskLevel: session?.riskLevel || null,
      attempt,
      createdAt: session?.createdAt ? new Date(session.createdAt).toISOString() : null,
      completedAt: session?.completedAt ? new Date(session.completedAt).toISOString() : null,
      ...(snapshot || {})
    };
  }

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
  }).catch(async err => {
    if (err.code === "P2002") return db.webhookDelivery.findFirst({ where: { eventUid } });
    throw err;
  });
}

module.exports = { sendWebhook, validateWebhookTarget, isPrivateIp, RETRY_SCHEDULE_SECONDS, MAX_ATTEMPTS };
