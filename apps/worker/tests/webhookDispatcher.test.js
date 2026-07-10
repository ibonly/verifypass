"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { verifyWebhookSignature } = require("@verifypass/shared");
const { createMockDb } = require("../../api/tests/helpers/mockDb");
const { sendWebhook, RETRY_SCHEDULE_SECONDS, MAX_ATTEMPTS } = require("../src/webhookDispatcher");

function mockFetch(responder) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const r = responder(calls.length, url, opts);
    if (r.throw) throw new Error(r.throw);
    return { status: r.status ?? 200 };
  };
  fn.calls = calls;
  return fn;
}

async function seed(db, { webhookUrl = "https://client.example/hook", webhookSecret = "whsec_test" } = {}) {
  const tenant = await db.tenant.create({
    data: { tenantUid: "tnt_wh", companyName: "W", status: "active", webhookUrl, webhookSecret }
  });
  const session = await db.verificationSession.create({
    data: {
      sessionUid: "vps_WH1", tenantId: tenant.id, status: "approved", riskLevel: "low",
      customerReference: "CUST-9", completedAt: new Date()
    }
  });
  return { tenant, session };
}

test("payload carries attempt number — consumers can order events across retries", async () => {
  const db = createMockDb();
  const { tenant, session } = await seed(db);
  // two prior end-user retries on this session
  for (let i = 0; i < 2; i++) {
    await db.auditLog.create({
      data: { tenantId: tenant.id, sessionId: session.id, actorType: "api", action: "session.retry", metadata: { attempt: i + 2 } }
    });
  }
  const fetch = mockFetch(() => ({ status: 200 }));
  await sendWebhook(
    { tenantId: String(tenant.id), sessionUid: "vps_WH1", event: "verification.approved" },
    { db, fetchImpl: fetch }
  );
  const body = JSON.parse(fetch.calls[0].opts.body);
  assert.equal(body.attempt, 3, "initial attempt + 2 retries");
});

test("fresh session payload has attempt 1", async () => {
  const db = createMockDb();
  const { tenant } = await seed(db);
  const fetch = mockFetch(() => ({ status: 200 }));
  await sendWebhook(
    { tenantId: String(tenant.id), sessionUid: "vps_WH1", event: "verification.approved" },
    { db, fetchImpl: fetch }
  );
  assert.equal(JSON.parse(fetch.calls[0].opts.body).attempt, 1);
});

test("delivers signed webhook; receiver can verify signature", async () => {
  const db = createMockDb();
  const { tenant } = await seed(db);
  const fetch = mockFetch(() => ({ status: 200 }));

  const out = await sendWebhook(
    { tenantId: String(tenant.id), sessionUid: "vps_WH1", event: "verification.approved" },
    { db, fetchImpl: fetch }
  );
  assert.equal(out.delivered, true);

  const { url, opts } = fetch.calls[0];
  assert.equal(url, "https://client.example/hook");
  assert.equal(opts.headers["X-Verifypass-Event"], "verification.approved");

  // Receiver-side verification with the tenant secret
  const okSig = verifyWebhookSignature(opts.body, {
    "x-verifypass-signature": opts.headers["X-Verifypass-Signature"],
    "x-verifypass-timestamp": opts.headers["X-Verifypass-Timestamp"]
  }, "whsec_test");
  assert.equal(okSig, true);

  const badSig = verifyWebhookSignature(opts.body, {
    "x-verifypass-signature": opts.headers["X-Verifypass-Signature"],
    "x-verifypass-timestamp": opts.headers["X-Verifypass-Timestamp"]
  }, "whsec_WRONG");
  assert.equal(badSig, false);

  // Payload per PRD §9.11
  const body = JSON.parse(opts.body);
  assert.equal(body.event, "verification.approved");
  assert.equal(body.tenantId, "tnt_wh");
  assert.equal(body.sessionId, "vps_WH1");
  assert.equal(body.customerReference, "CUST-9");

  const delivery = (await db.webhookDelivery.findMany({}))[0];
  assert.equal(delivery.status, "delivered");
  assert.equal(delivery.attempts, 1);
});

test("failure schedules retry with backoff; delivery row tracks state", async () => {
  const db = createMockDb();
  const { tenant } = await seed(db);
  const now = new Date("2026-07-04T12:00:00Z");

  const out = await sendWebhook(
    { tenantId: String(tenant.id), sessionUid: "vps_WH1", event: "verification.approved" },
    { db, fetchImpl: mockFetch(() => ({ status: 500 })), now: () => now }
  );
  assert.equal(out.delivered, false);
  assert.equal(out.exhausted, false);

  const delivery = (await db.webhookDelivery.findMany({}))[0];
  assert.equal(delivery.status, "failed");
  assert.equal(delivery.lastStatusCode, 500);
  assert.equal(delivery.nextAttemptAt.getTime(), now.getTime() + RETRY_SCHEDULE_SECONDS[0] * 1000);

  const retryJobs = await db.jobQueue.findMany({ where: { type: "send_webhook" } });
  assert.equal(retryJobs.length, 1);
  assert.equal(retryJobs[0].payload.deliveryId, delivery.id);
});

test("retries until exhausted after MAX_ATTEMPTS", async () => {
  const db = createMockDb();
  const { tenant } = await seed(db);
  const fetch = mockFetch(() => ({ throw: "connect ECONNREFUSED" }));

  let out = await sendWebhook(
    { tenantId: String(tenant.id), sessionUid: "vps_WH1", event: "verification.approved" },
    { db, fetchImpl: fetch }
  );
  const delivery = (await db.webhookDelivery.findMany({}))[0];

  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    out = await sendWebhook({ deliveryId: delivery.id }, { db, fetchImpl: fetch });
  }
  assert.equal(out.exhausted, true);

  const final = (await db.webhookDelivery.findMany({}))[0];
  assert.equal(final.status, "exhausted");
  assert.equal(final.attempts, MAX_ATTEMPTS);
  assert.equal(final.nextAttemptAt, null);
});

test("already-delivered retry job is a no-op (idempotent)", async () => {
  const db = createMockDb();
  const { tenant } = await seed(db);
  const fetch = mockFetch(() => ({ status: 200 }));
  await sendWebhook({ tenantId: String(tenant.id), sessionUid: "vps_WH1", event: "verification.approved" }, { db, fetchImpl: fetch });
  const delivery = (await db.webhookDelivery.findMany({}))[0];

  const out = await sendWebhook({ deliveryId: delivery.id }, { db, fetchImpl: fetch });
  assert.equal(out.skipped, true);
  assert.equal(fetch.calls.length, 1); // no second HTTP call
});

test("tenant without webhook config: skipped, no delivery row", async () => {
  const db = createMockDb();
  const { tenant } = await seed(db, { webhookUrl: null, webhookSecret: null });
  const out = await sendWebhook(
    { tenantId: String(tenant.id), sessionUid: "vps_WH1", event: "verification.approved" },
    { db, fetchImpl: mockFetch(() => ({ status: 200 })) }
  );
  assert.equal(out.skipped, true);
  assert.equal((await db.webhookDelivery.findMany({})).length, 0);
});
