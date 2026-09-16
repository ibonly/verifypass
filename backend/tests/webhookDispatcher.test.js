"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { verifyWebhookSignature } = require("@verifypass/shared");
const { createMockDb } = require("./helpers/mockDb");
const { sendWebhook, RETRY_SCHEDULE_SECONDS, MAX_ATTEMPTS } = require("../src/worker/webhookDispatcher");

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

test("verification payload contains exactly the five requested fields", async () => {
  const db = createMockDb();
  const { tenant, session } = await seed(db);
  const fetch = mockFetch(() => ({ status: 200 }));
  await sendWebhook({ tenantId: tenant.id, sessionUid: session.sessionUid, event: "verification.approved" },
    { db, fetchImpl: fetch, validateTarget: async () => {} });
  assert.deepEqual(JSON.parse(fetch.calls[0].opts.body), {
    event: "verification.approved", sessionId: session.sessionUid, status: "approved",
    createdAt: session.createdAt.toISOString(), selfieBase64: null
  });
});

test("delivers signed webhook; receiver can verify signature", async () => {
  const db = createMockDb();
  const { tenant } = await seed(db);
  const fetch = mockFetch(() => ({ status: 200 }));

  const out = await sendWebhook(
    { tenantId: String(tenant.id), sessionUid: "vps_WH1", event: "verification.approved" },
    { db, fetchImpl: fetch, validateTarget: async () => {} }
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
  assert.equal(body.tenantId, undefined);
  assert.equal(body.sessionId, "vps_WH1");
  assert.equal(body.customerReference, undefined);

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
    { db, validateTarget: async () => {}, fetchImpl: mockFetch(() => ({ status: 500 })), now: () => now }
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
    { db, fetchImpl: fetch, validateTarget: async () => {} }
  );
  const delivery = (await db.webhookDelivery.findMany({}))[0];

  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    out = await sendWebhook({ deliveryId: delivery.id }, { db, validateTarget: async () => {}, fetchImpl: fetch });
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
  await sendWebhook({ tenantId: String(tenant.id), sessionUid: "vps_WH1", event: "verification.approved" }, { db, validateTarget: async () => {}, fetchImpl: fetch });
  const delivery = (await db.webhookDelivery.findMany({}))[0];

  const out = await sendWebhook({ deliveryId: delivery.id }, { db, validateTarget: async () => {}, fetchImpl: fetch });
  assert.equal(out.skipped, true);
  assert.equal(fetch.calls.length, 1); // no second HTTP call
});

test("tenant without webhook config: skipped, no delivery row", async () => {
  const db = createMockDb();
  const { tenant } = await seed(db, { webhookUrl: null, webhookSecret: null });
  const out = await sendWebhook(
    { tenantId: String(tenant.id), sessionUid: "vps_WH1", event: "verification.approved" },
    { db, validateTarget: async () => {}, fetchImpl: mockFetch(() => ({ status: 200 })) }
  );
  assert.equal(out.skipped, true);
  assert.equal((await db.webhookDelivery.findMany({})).length, 0);
});

test("outbox webhook snapshots survive retries and redelivery reuses the event ID", async () => {
  const db=createMockDb();
  const {tenant,session}=await seed(db);
  session.status="submitted";
  const fetch=mockFetch(()=>({status:200}));
  const payload={tenantId:tenant.id,sessionUid:session.sessionUid,event:"verification.approved",eventUid:"evt_fixed",snapshot:{status:"approved",riskLevel:"high",attempt:1,attemptId:"old"}};
  await sendWebhook(payload,{db,fetchImpl:fetch,validateTarget:async()=>{}});
  await sendWebhook(payload,{db,fetchImpl:fetch,validateTarget:async()=>{}});
  assert.equal(fetch.calls.length,1);
  assert.equal(db.webhookDelivery.rows.length,1);
  const body=JSON.parse(fetch.calls[0].opts.body);
  assert.equal(body.status,"approved");assert.equal(body.attemptId,undefined);
  assert.equal(db.webhookDelivery.rows[0].eventUid,"evt_fixed");
});

async function addSelfie(db, session, t, { attemptId, fileType = "selfie", bytes = Buffer.from("selfie bytes"), createdAt = new Date() } = {}) {
  const fs = require("node:fs/promises");
  const os = require("node:os");
  const path = require("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vp-webhook-selfie-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stored = await require("../src/services/evidenceStore").saveEvidence({
    tenantUid: "tnt_wh", sessionUid: session.sessionUid, fileType, buffer: bytes, baseDir: dir
  });
  return db.evidenceFile.create({ data: { sessionId: session.id, attemptId, fileType, ...stored, createdAt } });
}

test("encrypted selfie is delivered as base64, signed, and remains pinned across retries", async t => {
  const db = createMockDb();
  const { tenant, session } = await seed(db);
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const selfie = await addSelfie(db, session, t, { attemptId: "original", bytes });
  await addSelfie(db, session, t, { attemptId: "original", fileType: "liveness_frame" });
  const http = require("node:http");
  const { once } = require("node:events");
  const received = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ body, headers: req.headers });
    res.writeHead(received.length === 1 ? 503 : 204); res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const fetch = async (_url, opts) => {
    fetch.calls.push({ opts });
    return globalThis.fetch(`http://127.0.0.1:${server.address().port}/hook`, opts);
  };
  fetch.calls = [];
  const deps = { db, fetchImpl: fetch, validateTarget: async () => {} };
  await sendWebhook({ tenantId: tenant.id, sessionUid: session.sessionUid, event: "verification.approved",
    snapshot: { selfieId: selfie.id, attemptId: "original", minimalPayload: true, status: "approved" } }, deps);
  session.attemptId = "new";
  session.status = "submitted";
  await addSelfie(db, session, t, { attemptId: "new" });
  await sendWebhook({ deliveryId: db.webhookDelivery.rows[0].id }, deps);
  assert.equal(fetch.calls.length, 2);
  assert.equal(received.length, 2);
  assert.equal(verifyWebhookSignature(received[1].body, received[1].headers, "whsec_test"), true);
  assert.deepEqual(Buffer.from(JSON.parse(received[1].body).selfieBase64, "base64"), bytes);
  assert.equal(fetch.calls[0].opts.body, fetch.calls[1].opts.body);
  const body = JSON.parse(fetch.calls[1].opts.body);
  assert.deepEqual(Object.keys(body).sort(), ["createdAt", "event", "selfieBase64", "sessionId", "status"]);
  assert.deepEqual(Buffer.from(body.selfieBase64, "base64"), bytes);
  assert.equal(body.status, "approved");
  assert.equal(verifyWebhookSignature(fetch.calls[1].opts.body, fetch.calls[1].opts.headers, "whsec_test"), true);
  assert.equal(JSON.stringify(db.webhookDelivery.rows).includes(bytes.toString("base64")), false, "do not duplicate plaintext biometric data in delivery storage");
});

test("selfie selection isolates session and attempt; no document or frame fallback", async t => {
  const db = createMockDb();
  const { tenant, session } = await seed(db);
  session.attemptId = "current";
  await addSelfie(db, session, t, { attemptId: "old" });
  const frame = await addSelfie(db, session, t, { attemptId: "current", fileType: "liveness_frame" });
  const foreign = await addSelfie(db, { ...session, id: "other-session" }, t, { attemptId: "current" });
  const fetch = mockFetch(() => ({ status: 200 }));
  for (const selfieId of [undefined, frame.id, foreign.id]) {
    await sendWebhook({ tenantId: tenant.id, sessionUid: session.sessionUid, event: "verification.approved", snapshot: { selfieId } },
      { db, fetchImpl: fetch, validateTarget: async () => {} });
  }
  for (const call of fetch.calls) assert.equal(JSON.parse(call.opts.body).selfieBase64, null);
});

test("selfie read failure is visible and retryable; it never sends an incomplete image", async t => {
  const db = createMockDb();
  const { tenant, session } = await seed(db);
  const selfie = await addSelfie(db, session, t);
  const fs = require("node:fs/promises");
  const encrypted = await fs.readFile(selfie.storagePath);
  await fs.unlink(selfie.storagePath);
  const fetch = mockFetch(() => ({ status: 200 }));
  const deps = { db, fetchImpl: fetch, validateTarget: async () => {} };
  await sendWebhook({ tenantId: tenant.id, sessionUid: session.sessionUid, event: "verification.approved" }, deps);
  assert.equal(fetch.calls.length, 0);
  assert.equal(db.webhookDelivery.rows[0].status, "failed");
  assert.equal(db.jobQueue.rows.length, 1);
  await fs.writeFile(selfie.storagePath, encrypted);
  const result = await sendWebhook(db.jobQueue.rows[0].payload, deps);
  assert.equal(result.delivered, true);
  assert.equal(JSON.parse(fetch.calls[0].opts.body).selfieBase64, Buffer.from("selfie bytes").toString("base64"));
});

test("temporary DNS failure retries and later delivers the same event", async () => {
  const db = createMockDb();
  const { tenant } = await seed(db);
  const { validateWebhookTarget } = require("../src/lib/webhookTarget");
  const fetch = mockFetch(() => ({ status: 204 }));
  const out = await sendWebhook({ tenantId: tenant.id, sessionUid: "vps_WH1", event: "verification.approved" }, {
    db, fetchImpl: fetch,
    validateTarget: url => validateWebhookTarget(url, { resolve4: async () => { throw new Error("EAI_AGAIN"); } })
  });
  assert.equal(out.exhausted, false);
  assert.equal(fetch.calls.length, 0);
  assert.equal(db.jobQueue.rows.length, 1);
  assert.match(db.webhookDelivery.rows[0].lastError, /could not resolve/);
  const retry = await sendWebhook(db.jobQueue.rows[0].payload, {
    db, fetchImpl: fetch,
    validateTarget: url => validateWebhookTarget(url, { resolve4: async () => ["93.184.216.34"] })
  });
  assert.equal(retry.delivered, true);
  assert.equal(db.webhookDelivery.rows.length, 1);
  assert.equal(fetch.calls[0].opts.redirect, "error");
});

test("private targets are blocked permanently, with no HTTP call or retry", async () => {
  const db = createMockDb();
  const { tenant } = await seed(db);
  const { validateWebhookTarget } = require("../src/lib/webhookTarget");
  const fetch = mockFetch(() => ({ status: 200 }));
  const out = await sendWebhook({ tenantId: tenant.id, sessionUid: "vps_WH1", event: "verification.approved" }, {
    db, fetchImpl: fetch,
    validateTarget: url => validateWebhookTarget(url, { resolve4: async () => ["93.184.216.34", "127.0.0.1"] })
  });
  assert.equal(out.blocked, true);
  assert.equal(fetch.calls.length, 0);
  assert.equal(db.jobQueue.rows.length, 0);
  assert.equal(db.webhookDelivery.rows[0].nextAttemptAt, null);
});

test("all five advertised delays are used, including the final 12-hour retry", async () => {
  const db = createMockDb();
  const { tenant } = await seed(db);
  const now = new Date("2026-09-15T12:00:00Z");
  const deps = { db, now: () => now, fetchImpl: mockFetch(() => ({ status: 503 })), validateTarget: async () => {} };
  await sendWebhook({ tenantId: tenant.id, sessionUid: "vps_WH1", event: "verification.approved" }, deps);
  for (let i = 1; i < 6; i++) await sendWebhook({ deliveryId: db.webhookDelivery.rows[0].id }, deps);
  assert.deepEqual(db.jobQueue.rows.map(j => (j.runAfter - now) / 1000), [60, 300, 1800, 7200, 43200]);
  assert.equal(db.webhookDelivery.rows[0].attempts, 6);
  assert.equal(db.webhookDelivery.rows[0].status, "exhausted");
});

test("ID_ONLY events never include an image, even when stray selfie evidence exists", async t => {
  const db = createMockDb();
  const { tenant, session } = await seed(db);
  session.verificationType = "ID_ONLY";
  await addSelfie(db, session, t);
  const fetch = mockFetch(() => ({ status: 200 }));
  await sendWebhook({ tenantId: tenant.id, sessionUid: session.sessionUid, event: "verification.approved" },
    { db, fetchImpl: fetch, validateTarget: async () => {} });
  assert.equal(JSON.parse(fetch.calls[0].opts.body).selfieBase64, null);
});

test("newest selfie in the same attempt is selected when no pinned ID is supplied", async t => {
  const db = createMockDb();
  const { tenant, session } = await seed(db);
  await addSelfie(db, session, t, { createdAt: new Date(0), bytes: Buffer.from("old") });
  await addSelfie(db, session, t, { bytes: Buffer.from("latest") });
  const fetch = mockFetch(() => ({ status: 200 }));
  await sendWebhook({ tenantId: tenant.id, sessionUid: session.sessionUid, event: "verification.approved" },
    { db, fetchImpl: fetch, validateTarget: async () => {} });
  const body = JSON.parse(fetch.calls[0].opts.body);
  assert.equal(body.selfieBase64, Buffer.from("latest").toString("base64"));
  assert.equal(body.status, "approved");
});

test("explicit legacy attempt in an old event never selects a newer attempt's selfie", async t => {
  const db = createMockDb();
  const { tenant, session } = await seed(db);
  session.attemptId = "new";
  await addSelfie(db, session, t, { attemptId: "new" });
  const fetch = mockFetch(() => ({ status: 200 }));
  await sendWebhook({ tenantId: tenant.id, sessionUid: session.sessionUid, event: "verification.approved", snapshot: { attemptId: null } },
    { db, fetchImpl: fetch, validateTarget: async () => {} });
  assert.equal(JSON.parse(fetch.calls[0].opts.body).selfieBase64, null);
});

test("only approved verification events reach the receiver, including old delivery retries", async () => {
  const db = createMockDb();
  const { tenant, session } = await seed(db);
  const fetch = mockFetch(() => ({ status: 200 }));
  const deps = { db, fetchImpl: fetch, validateTarget: async () => {} };
  for (const status of ["rejected", "manual_review", "failed", "expired"]) {
    const event = `verification.${status}`;
    const fresh = await sendWebhook({ tenantId: tenant.id, sessionUid: session.sessionUid, event }, deps);
    assert.equal(fresh.skipped, true);
    const old = await db.webhookDelivery.create({ data: {
      event, tenantId: tenant.id, status: "failed", payload: { event, status }, nextAttemptAt: new Date(), attempts: 1
    } });
    const retry = await sendWebhook({ deliveryId: old.id }, deps);
    assert.equal(retry.skipped, true);
    assert.equal(old.status, "skipped");
    assert.equal(old.nextAttemptAt, null);
    assert.equal(old.attempts, 1);
  }
  assert.equal(fetch.calls.length, 0);
  assert.equal(db.jobQueue.rows.length, 0);
});
