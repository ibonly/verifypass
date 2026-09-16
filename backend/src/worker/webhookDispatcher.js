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

  // Fence old queued events too, not only newly generated outcomes.
  if (!payload.deliveryId && payload.event !== "verification.approved" && payload.event !== "webhook.test") {
    return { skipped: true, reason: "only approved verifications send webhooks" };
  }

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
  if (delivery.event !== "verification.approved" && delivery.event !== "webhook.test") {
    await db.webhookDelivery.updateMany({ where: { id: delivery.id }, data: {
      status: "skipped", nextAttemptAt: null, lastError: "Only approved verifications send webhooks"
    } });
    return { skipped: true, reason: "only approved verifications send webhooks" };
  }
  const tenant = await db.tenant.findFirst({ where: { id: delivery.tenantId } });
  if (!tenant?.webhookUrl || !tenant?.webhookSecret) {
    await db.webhookDelivery.updateMany({ where: { id: delivery.id }, data: { status: "failed", lastError: "webhook not configured" } });
    return { skipped: true };
  }

  const attempts = (delivery.attempts || 0) + 1;

  let statusCode = null;
  let error = null;
  try {
    await (deps.validateTarget || validateWebhookTarget)(tenant.webhookUrl);
    const body = await serializeDelivery(delivery, db);
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

async function createDelivery({ tenantId, sessionUid, event, eventUid: suppliedEventUid, attemptId, snapshot }, { db, now }) {
  // tenantId travels through job payloads as a string — MongoDB ObjectId ids
  // are strings end to end, no coercion needed.
  const tenant = await db.tenant.findFirst({ where: { id: String(tenantId) } });
  if (!tenant?.webhookUrl || !tenant?.webhookSecret) return null;

  const session = sessionUid ? await db.verificationSession.findFirst({ where: { sessionUid, tenantId: tenant.id } }) : null;
  const eventUid = suppliedEventUid || `evt_${crypto.randomBytes(12).toString("hex")}`;
  const existing = await db.webhookDelivery.findFirst({ where: { eventUid } });
  if (existing) return existing;

  // Pin a single selfie from the event's attempt. Never substitute a document
  // or liveness frame, or read a newer attempt when an old event is delayed.
  const eventAttempt = snapshot && Object.hasOwn(snapshot, "attemptId")
    ? snapshot.attemptId : attemptId !== undefined ? attemptId : session?.attemptId;
  const selfie = session && session.verificationType !== "ID_ONLY"
    ? (await db.evidenceFile.findMany({
      where: {
        sessionId: session.id, fileType: "selfie",
        ...(eventAttempt ? { attemptId: eventAttempt } : { OR: [{ attemptId: null }, { attemptId: { isSet: false } }] }),
        ...(snapshot?.selfieId ? { id: snapshot.selfieId } : {})
      },
      orderBy: { createdAt: "desc" }, take: 1
    }))[0] : null;
  const body = {
    event,
    sessionId: sessionUid || null,
    status: snapshot?.status || (event.startsWith("verification.") ? event.slice("verification.".length) : session?.status) || null,
    createdAt: snapshot?.createdAt || (session?.createdAt ? new Date(session.createdAt).toISOString() : null),
    // Internal reference only: image bytes stay in encrypted evidence storage,
    // rather than being copied into the queue or delivery log indefinitely.
    _selfie: { version: 1, evidenceId: selfie?.id || null, attemptId: eventAttempt || null }
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
  }).catch(async err => {
    if (err.code === "P2002") return db.webhookDelivery.findFirst({ where: { eventUid } });
    throw err;
  });
}

async function serializeDelivery(delivery, db) {
  const payload = delivery.payload;
  // Previously created deliveries retain their original retry contract.
  if (payload?._selfie?.version !== 1) return JSON.stringify(payload);
  let selfieBase64 = null;
  if (payload._selfie.evidenceId) {
    const session = await db.verificationSession.findFirst({ where: { id: delivery.sessionId, tenantId: delivery.tenantId } });
    if (!session) throw new Error("Webhook selfie session is unavailable");
    const file = await db.evidenceFile.findFirst({ where: {
      id: payload._selfie.evidenceId, sessionId: session.id, fileType: "selfie",
      ...(payload._selfie.attemptId ? { attemptId: payload._selfie.attemptId } : { OR: [{ attemptId: null }, { attemptId: { isSet: false } }] })
    } });
    if (!file) throw new Error("Webhook selfie evidence is unavailable");
    const bytes = await require("../services/evidenceStore").readEvidence(file.storagePath);
    if (file.checksum && crypto.createHash("sha256").update(bytes).digest("hex") !== file.checksum) {
      throw new Error("Webhook selfie checksum mismatch");
    }
    selfieBase64 = bytes.toString("base64");
  }
  return JSON.stringify({ event: payload.event, sessionId: payload.sessionId, status: payload.status, createdAt: payload.createdAt, selfieBase64 });
}

module.exports = { sendWebhook, validateWebhookTarget, isPrivateIp, RETRY_SCHEDULE_SECONDS, MAX_ATTEMPTS };
