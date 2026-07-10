"use strict";

// Lambda entry: SQS batches with partial failures, the notBefore delay
// ladder, and direct EventBridge invokes. Executor/enqueue are injected —
// no AWS needed.

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildHandler } = require("../worker.lambda");

function sqsEvent(...bodies) {
  return { Records: bodies.map((b, i) => ({ messageId: `m${i}`, body: JSON.stringify(b) })) };
}

test("SQS batch: executes due jobs; reports ONLY failed messages back", async () => {
  const ran = [];
  const handler = buildHandler({
    execute: async (job) => {
      ran.push(job.type);
      if (job.payload.boom) throw new Error("provider exploded");
    },
    enqueue: async () => { throw new Error("should not requeue"); }
  });

  const out = await handler(sqsEvent(
    { type: "run_verification", payload: { sessionUid: "vps_1" } },
    { type: "run_verification", payload: { sessionUid: "vps_2", boom: true } },
    { type: "send_webhook", payload: { deliveryId: 9 } }
  ));

  assert.deepEqual(ran, ["run_verification", "run_verification", "send_webhook"]);
  assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: "m1" }],
    "one bad job must not force redelivery of the whole batch");
});

test("delay ladder: early message is re-enqueued toward notBefore and ACKED", async () => {
  const requeued = [];
  const now = Date.parse("2026-07-10T00:00:00Z");
  const handler = buildHandler({
    execute: async () => { throw new Error("must not execute early"); },
    enqueue: async (type, payload, opts) => requeued.push({ type, payload, opts }),
    now: () => now
  });

  const notBefore = new Date(now + 2 * 60 * 60 * 1000).toISOString(); // 2h out
  const out = await handler(sqsEvent(
    { type: "send_webhook", payload: { deliveryId: 3 }, notBefore, maxAttempts: 1 }
  ));

  assert.equal(out.batchItemFailures.length, 0, "early hop is a SUCCESS, not a failure");
  assert.equal(requeued.length, 1);
  assert.equal(requeued[0].type, "send_webhook");
  assert.equal(requeued[0].opts.runAfter.toISOString(), notBefore, "target time preserved across hops");
});

test("due message (notBefore in the past) executes normally", async () => {
  const ran = [];
  const handler = buildHandler({
    execute: async (job) => ran.push(job.type),
    enqueue: async () => { throw new Error("should not requeue"); },
    now: () => Date.parse("2026-07-10T12:00:00Z")
  });
  await handler(sqsEvent(
    { type: "send_webhook", payload: {}, notBefore: "2026-07-10T11:00:00Z" }
  ));
  assert.deepEqual(ran, ["send_webhook"]);
});

test("direct invoke (EventBridge cron) runs the named job", async () => {
  const ran = [];
  const handler = buildHandler({ execute: async (job) => { ran.push(job.type); return { timedOut: 0 }; } });
  const out = await handler({ type: "expire_sessions" });
  assert.deepEqual(ran, ["expire_sessions"]);
  assert.equal(out.ok, true);
});

test("malformed message body counts as a batch failure, not a crash", async () => {
  const handler = buildHandler({ execute: async () => {} });
  const out = await handler({ Records: [{ messageId: "bad", body: "{not json" }] });
  assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: "bad" }]);
});

// --------------------------------------------------------------------------
// db-queue drain (QUEUE_BACKEND=db, the deployed configuration): the
// job_queue table stays the source of truth; drain claims and executes rows
// with the polling worker's exact retry semantics.
// --------------------------------------------------------------------------

const { drainDbQueue } = require("../worker.lambda");
const { createMockDb } = require("./helpers/mockDb");

async function seedDrain(db, { jobs = 1, type = "send_webhook" } = {}) {
  // tenant WITHOUT webhook config → send_webhook returns {skipped} = success
  const tenant = await db.tenant.create({ data: { tenantUid: "tnt_dr", companyName: "D", status: "active" } });
  for (let i = 0; i < jobs; i++) {
    await db.jobQueue.create({
      data: {
        type, payload: { tenantId: String(tenant.id), sessionUid: `vps_${i}`, event: "verification.approved" },
        status: "pending", runAfter: new Date(Date.now() - 1000), maxAttempts: 5, attempts: 0
      }
    });
  }
  return tenant;
}

test("drain: claims pending jobs, executes, marks done, stops when empty", async () => {
  const db = createMockDb();
  await seedDrain(db, { jobs: 3 });
  const out = await drainDbQueue({ db }, { maxJobs: 10 });
  assert.equal(out.processed, 3);
  assert.equal(out.failed, 0);
  const remaining = await db.jobQueue.findMany({ where: { status: "pending" } });
  assert.equal(remaining.length, 0);
  const done = await db.jobQueue.findMany({ where: { status: "done" } });
  assert.equal(done.length, 3);
});

test("drain: failing job goes back to pending with backoff; exhausted → failed", async () => {
  const db = createMockDb();
  await db.tenant.create({ data: { tenantUid: "tnt_x", companyName: "X", status: "active" } });
  await db.jobQueue.create({
    data: { type: "nope_not_a_job", payload: {}, status: "pending", runAfter: new Date(0), maxAttempts: 5, attempts: 0 }
  });
  await db.jobQueue.create({
    data: { type: "nope_not_a_job", payload: {}, status: "pending", runAfter: new Date(0), maxAttempts: 2, attempts: 1 }
  });

  const out = await drainDbQueue({ db }, { maxJobs: 10 });
  assert.equal(out.failed, 2);
  const retry = await db.jobQueue.findMany({ where: { status: "pending" } });
  assert.equal(retry.length, 1, "attempts remaining → requeued with backoff");
  assert.ok(new Date(retry[0].runAfter).getTime() > Date.now(), "backoff pushed runAfter into the future");
  const dead = await db.jobQueue.findMany({ where: { status: "failed" } });
  assert.equal(dead.length, 1, "attempts exhausted → failed, no crash loop");
});

test("drain: respects the maxJobs bound (leaves the rest for the next invocation)", async () => {
  const db = createMockDb();
  await seedDrain(db, { jobs: 5 });
  const out = await drainDbQueue({ db }, { maxJobs: 2 });
  assert.equal(out.processed, 2);
  assert.equal((await db.jobQueue.findMany({ where: { status: "pending" } })).length, 3);
});

test("drain: reclaims a stale 'running' orphan first, then processes it", async () => {
  const db = createMockDb();
  const tenant = await seedDrain(db, { jobs: 0 });
  await db.jobQueue.create({
    data: {
      type: "send_webhook", payload: { tenantId: String(tenant.id), sessionUid: "vps_o", event: "verification.failed" },
      status: "running", runAfter: new Date(0), maxAttempts: 5, attempts: 1,
      lockedBy: "lambda-died", lockedAt: new Date(Date.now() - 10 * 60 * 1000)
    }
  });
  const out = await drainDbQueue({ db }, { maxJobs: 10 });
  assert.equal(out.processed, 1, "orphaned running job was requeued and drained in one pass");
});
