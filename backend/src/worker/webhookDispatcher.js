"use strict";

// send_webhook job handler (PRD §9.11). Retry schedule: 1m, 5m, 30m, 2h, 12h.
// Each attempt is recorded on the webhook_deliveries row; retries are new
// queue jobs referencing the same delivery (idempotent, survives restarts).

const crypto = require("crypto");
const { webhookHeaders } = require("@verifypass/shared");
const { hasLivenessStatus } = require("../services/webhookEligibility");
const { signEvidenceAccess } = require("../services/evidenceStore");
const { logWebhook, requestSummary } = require("../services/webhookLog");
const config = require("../config");


const { validateWebhookTarget, isPrivateIp } = require("../lib/webhookTarget");

const RETRY_SCHEDULE_SECONDS = [60, 300, 1800, 7200, 43200];
const MAX_ATTEMPTS = RETRY_SCHEDULE_SECONDS.length + 1;
const TIMEOUT_MS = 10000;

function failureReasonFor(error) {
  if (/Webhook selfie|Approved webhook/.test(error?.message || "")) return "payload_or_evidence_unavailable";
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "timeout";
  const code = error?.cause?.code || error?.code;
  if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET"].includes(code)) return code.toLowerCase();
  return "request_error";
}

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
  const log = (stage, delivery, details = {}) => logWebhook(stage, {
    eventUid: delivery?.eventUid, deliveryId: delivery?.id,
    tenantId: delivery?.tenantId, sessionId: delivery?.payload?.sessionId,
    event: delivery?.event, ...details
  }, deps.log);
  const doFetch = fetchImpl || fetch;
  // Retry scheduling goes through the injected dispatch in Lambda/SQS
  // topologies; the polling worker keeps using job_queue rows.
  const dispatch = enqueueJob || ((type, jobPayload, { runAfter = now(), maxAttempts = 1 } = {}) =>
    db.jobQueue.create({ data: { type, payload: jobPayload, status: "pending", runAfter, maxAttempts } }));

  // Fence old queued events too, not only newly generated outcomes.
  const allowedEvents = { "verification.approved": "passed", "verification.failed": "failed" };
  if (!payload.deliveryId && !allowedEvents[payload.event] && payload.event !== "webhook.test") {
    log("skipped", null, { tenantId: payload.tenantId, sessionId: payload.sessionUid,
      event: payload.event, reason: "no_deliverable_liveness_outcome" });
    return { skipped: true, reason: "no deliverable liveness outcome" };
  }

  let delivery;
  if (payload.deliveryId) {
    delivery = await db.webhookDelivery.findFirst({ where: { id: payload.deliveryId } });
    if (!delivery) {
      log("delivery_missing", null, { deliveryId: payload.deliveryId });
      throw new Error(`webhook delivery ${payload.deliveryId} not found`);
    }
    if (delivery.status === "delivered") {
      log("duplicate_ignored", delivery, { status: "delivered" });
      return { skipped: true };
    }
  } else {
    delivery = await createDelivery(payload, { db, now });
    if (!delivery) {
      log("skipped", null, { tenantId: payload.tenantId, sessionId: payload.sessionUid,
        event: payload.event, reason: "webhook_not_configured" });
      return { skipped: true, reason: "tenant has no webhook configured" };
    }
  }

  if (delivery.status === "delivered") {
    log("duplicate_ignored", delivery, { status: "delivered" });
    return { skipped: true };
  }
  log("delivery_ready", delivery, { trigger: delivery.event === "webhook.test" ? "test" : payload.deliveryId ? "retry" : "new_event",
    status: delivery.status, attempt: (delivery.attempts || 0) + 1 });
  if (!allowedEvents[delivery.event] && delivery.event !== "webhook.test") {
    await db.webhookDelivery.updateMany({ where: { id: delivery.id }, data: {
      status: "skipped", nextAttemptAt: null, lastError: "No deliverable liveness outcome"
    } });
    log("skipped", delivery, { reason: "no_deliverable_liveness_outcome" });
    return { skipped: true, reason: "no deliverable liveness outcome" };
  }
  const tenant = await db.tenant.findFirst({ where: { id: delivery.tenantId } });
  if (!tenant?.webhookUrl || !tenant?.webhookSecret) {
    await db.webhookDelivery.updateMany({ where: { id: delivery.id }, data: { status: "failed", lastError: "webhook not configured" } });
    log("skipped", delivery, { reason: "webhook_not_configured" });
    return { skipped: true };
  }

  // Deliveries created before selfie references were persisted have only the
  // four public fields. Rebuild one only when its original result names the
  // consumed selfie; never use the session's current attempt on a retry.
  if (delivery.event === "verification.approved" && delivery.payload?._selfie?.version !== 1) {
    if (!await upgradeLegacyApprovedDelivery(delivery, db)) {
      await db.webhookDelivery.updateMany({ where: { id: delivery.id }, data: {
        status: "skipped", nextAttemptAt: null,
        lastError: "Legacy approved delivery cannot be matched to its original selfie"
      } });
      log("skipped", delivery, { reason: "legacy_selfie_unavailable" });
      return { skipped: true, reason: "legacy approved delivery has no pinned selfie" };
    }
    log("legacy_payload_upgraded", delivery);
  }

  if (allowedEvents[delivery.event]) {
    const attemptId = delivery.payload?._selfie?.attemptId ?? payload.attemptId ?? null;
    const eligible = delivery.sessionId && await hasLivenessStatus(db, delivery.sessionId, attemptId, allowedEvents[delivery.event]);
    if (!eligible) {
      await db.webhookDelivery.updateMany({ where: { id: delivery.id }, data: {
        status: "skipped", nextAttemptAt: null, lastError: "Liveness result does not match event"
      } });
      log("skipped", delivery, { reason: "liveness_result_mismatch" });
      return { skipped: true, reason: "liveness result does not match event" };
    }
  }

  const attempts = (delivery.attempts || 0) + 1;
  log("attempt_started", delivery, { attempt: attempts });

  let statusCode = null;
  let error = null;
  let failureReason = null;
  try {
    await (deps.validateTarget || validateWebhookTarget)(tenant.webhookUrl);
    const body = await serializeDelivery(delivery, db);
    const headers = webhookHeaders(body, tenant.webhookSecret, { event: delivery.event });
    const startedAt = Date.now();
    log("request_sent", delivery, { attempt: attempts, receiverOrigin: new URL(tenant.webhookUrl).origin,
      ...requestSummary(body) });
    const res = await doFetch(tenant.webhookUrl, {
      method: "POST",
      redirect: "error",
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    statusCode = res.status;
    log("response_received", delivery, { attempt: attempts, httpStatus: statusCode,
      durationMs: Date.now() - startedAt });
    if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
    if (error) failureReason = "non_2xx_response";
  } catch (err) {
    if (err.code === "WEBHOOK_TARGET_BLOCKED") {
      await db.webhookDelivery.updateMany({
        where: { id: delivery.id },
        data: { status: "failed", attempts, lastStatusCode: null, nextAttemptAt: null, lastError: `SSRF blocked: ${err.message}` }
      });
      log("blocked", delivery, { attempt: attempts, reason: "webhook_target_blocked" });
      return { delivered: false, attempts, blocked: true, reason: err.message };
    }
    error = err.message;
    failureReason = failureReasonFor(err);
  }

  if (!error) {
    await db.webhookDelivery.updateMany({
      where: { id: delivery.id },
      data: { status: "delivered", attempts, lastStatusCode: statusCode, lastError: null, deliveredAt: now(), nextAttemptAt: null }
    });
    log("delivered", delivery, { attempt: attempts, httpStatus: statusCode });
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
  log(exhausted ? "exhausted" : "attempt_failed", delivery, {
    attempt: attempts, httpStatus: statusCode, reason: failureReason,
    nextAttemptAt: nextAt?.toISOString() ?? null
  });
  if (!exhausted) {
    // scheduling is managed here, not by generic job retry
    await dispatch("send_webhook", { deliveryId: delivery.id }, { runAfter: nextAt, maxAttempts: 1 });
    log("retry_scheduled", delivery, { attempt: attempts + 1, nextAttemptAt: nextAt.toISOString() });
  } else {
    notifyWebhookExhausted(tenant, delivery, attempts, error || "unknown");
  }
  return { delivered: false, attempts, exhausted };
}

async function upgradeLegacyApprovedDelivery(delivery, db) {
  if (!delivery.sessionId || !delivery.createdAt) return false;
  const session = await db.verificationSession.findFirst({ where: { id: delivery.sessionId, tenantId: delivery.tenantId } });
  if (!session || delivery.payload?.sessionId !== session.sessionUid || delivery.payload?.status !== "approved") return false;
  const createdAt = new Date(delivery.createdAt);
  if (!Number.isFinite(createdAt.getTime())) return false;
  const results = await db.verificationResult.findMany({
    where: { sessionId: session.id, createdAt: { lte: createdAt } },
    orderBy: { createdAt: "desc" }, take: 1
  });
  const result = results[0];
  const sameCurrentAttempt = (session.attemptId || null) === (result?.attemptId || null);
  const manuallyApproved = session.status === "approved" && sameCurrentAttempt && session.completedAt && new Date(session.completedAt) <= createdAt;
  const approved = result?.rawResult?.decision?.status === "approved" || manuallyApproved;
  if (!approved || result.livenessStatus !== "passed") return false;
  const consumedIds = result.rawResult?.consumedEvidenceIds;
  if (!Array.isArray(consumedIds) || !consumedIds.length) return false;
  const selfies = await db.evidenceFile.findMany({
    where: {
      id: { in: consumedIds.map(String) }, sessionId: session.id, fileType: "selfie",
      ...(result.attemptId ? { attemptId: result.attemptId } : { OR: [{ attemptId: null }, { attemptId: { isSet: false } }] })
    },
    orderBy: { createdAt: "desc" }, take: 1
  });
  if (!selfies[0]) return false;
  const upgraded = {
    ...delivery.payload,
    userSessionId: session.customerReference ?? null,
    _selfie: { version: 1, evidenceId: selfies[0].id, attemptId: result.attemptId || null }
  };
  await db.webhookDelivery.updateMany({ where: { id: delivery.id }, data: { payload: upgraded } });
  delivery.payload = upgraded;
  return true;
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
    ...(event === "verification.approved" ? { userSessionId: snapshot?.customerReference ?? session?.customerReference ?? null } : {}),
    status: snapshot?.status || session?.status || (event.startsWith("verification.") ? event.slice("verification.".length) : null),
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
  // An approved event must never fall through to the legacy four-field body,
  // including when a queued delivery predates the selfie URL contract.
  if (delivery.event === "verification.approved" && (
    payload?._selfie?.version !== 1 ||
    payload.event !== delivery.event ||
    payload.status !== "approved" ||
    !payload.sessionId ||
    !payload.createdAt
  )) throw new Error("Approved webhook payload is incomplete");
  // Failed and explicit test events retain their existing body contract.
  if (payload?._selfie?.version !== 1) return JSON.stringify(payload);
  const approved = delivery.event === "verification.approved";
  if (approved) {
    if (!payload._selfie.evidenceId) throw new Error("Webhook selfie evidence is unavailable");
    const session = await db.verificationSession.findFirst({ where: { id: delivery.sessionId, tenantId: delivery.tenantId } });
    if (!session) throw new Error("Webhook selfie session is unavailable");
    if (payload.sessionId !== session.sessionUid) throw new Error("Approved webhook session does not match delivery");
    const file = await db.evidenceFile.findFirst({ where: {
      id: payload._selfie.evidenceId, sessionId: session.id, fileType: "selfie",
      ...(payload._selfie.attemptId ? { attemptId: payload._selfie.attemptId } : { OR: [{ attemptId: null }, { attemptId: { isSet: false } }] })
    } });
    if (!file) throw new Error("Webhook selfie evidence is unavailable");
    const { token } = signEvidenceAccess(String(file.id), { tenantId: String(delivery.tenantId) });
    const selfieUrl = `${config.apiPublicUrl}/v1/dashboard/evidence/${encodeURIComponent(file.id)}/image?token=${encodeURIComponent(token)}`;
    return JSON.stringify({ event: payload.event, sessionId: payload.sessionId,
      userSessionId: payload.userSessionId ?? session.customerReference ?? null,
      status: payload.status, createdAt: payload.createdAt, selfieUrl });
  }
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
  return JSON.stringify({ event: payload.event, sessionId: payload.sessionId,
    status: payload.status, createdAt: payload.createdAt, selfieBase64 });
}

module.exports = { sendWebhook, validateWebhookTarget, isPrivateIp, RETRY_SCHEDULE_SECONDS, MAX_ATTEMPTS };
