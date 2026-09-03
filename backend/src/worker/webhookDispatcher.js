"use strict";

// send_webhook job handler (PRD §9.11). Retry schedule: 1m, 5m, 30m, 2h, 12h.
// Each attempt is recorded on the webhook_deliveries row; retries are new
// queue jobs referencing the same delivery (idempotent, survives restarts).

const crypto = require("crypto");
const { webhookHeaders } = require("@verifypass/shared");


const dns = require("dns/promises");
const { URL } = require("url");
const net = require("net");

/**
 * Resolve the webhook URL's hostname and reject private/loopback/link-local/
 * CGNAT ranges to prevent SSRF. Also enforces https in production.
 */
async function validateWebhookTarget(urlStr) {
  const u = new URL(urlStr);
  if (u.protocol !== "https:") {
    throw new Error("webhook URL must use https");
  }
  // Only allow standard HTTPS port (or explicit 443)
  const port = u.port ? Number(u.port) : 443;
  if (port !== 443) {
    throw new Error(`webhook URL port ${port} not allowed (use 443)`);
  }
  // Resolve hostname to IPs and check each
  const host = u.hostname;
  let addrs;
  if (net.isIP(host)) {
    addrs = [host];
  } else {
    try {
      const records = await dns.resolve4(host);
      addrs = records;
    } catch (_) {
      throw new Error(`could not resolve webhook host: ${host}`);
    }
  }
  for (const ip of addrs) {
    if (isPrivateIp(ip)) {
      throw new Error(`webhook URL resolves to private/reserved IP (${ip})`);
    }
  }
}

function isPrivateIp(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return true; // non-IPv4 → block
  const [a, b, c, d] = parts;
  if (a === 127) return true;                          // loopback
  if (a === 10) return true;                           // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16
  if (a === 169 && b === 254) return true;             // link-local
  if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT 100.64.0.0/10
  if (a === 0) return true;                            // 0.0.0.0/8
  if (a >= 224) return true;                           // multicast + reserved
  return false;
}

const RETRY_SCHEDULE_SECONDS = [60, 300, 1800, 7200, 43200];
const MAX_ATTEMPTS = RETRY_SCHEDULE_SECONDS.length;
const TIMEOUT_MS = 10000;

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

  const tenant = await db.tenant.findFirst({ where: { id: delivery.tenantId } });
  if (!tenant?.webhookUrl || !tenant?.webhookSecret) {
    await db.webhookDelivery.updateMany({ where: { id: delivery.id }, data: { status: "failed", lastError: "webhook not configured" } });
    return { skipped: true };
  }

  const body = JSON.stringify(delivery.payload);
  const attempts = (delivery.attempts || 0) + 1;

  // SSRF protection: validate the target URL before sending
  const checkTarget = deps.validateTarget || validateWebhookTarget;
  try {
    await checkTarget(tenant.webhookUrl);
  } catch (ssrfErr) {
    await db.webhookDelivery.updateMany({
      where: { id: delivery.id },
      data: { status: "failed", attempts, lastError: `SSRF blocked: ${ssrfErr.message}` }
    });
    return { delivered: false, attempts, blocked: true, reason: ssrfErr.message };
  }

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

module.exports = { sendWebhook, validateWebhookTarget, isPrivateIp, RETRY_SCHEDULE_SECONDS, MAX_ATTEMPTS };
