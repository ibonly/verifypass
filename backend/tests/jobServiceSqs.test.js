"use strict";

// jobService SQS backend: delay capping at the SQS 900s max + notBefore
// carried in the message for the Lambda handler's delay ladder.

const test = require("node:test");
const assert = require("node:assert/strict");

const { enqueue, delaySecondsFor, MAX_SQS_DELAY_SECONDS, __setTestSqs } = require("../src/services/jobService");

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; process.env[k] = v; }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

test("delaySecondsFor: immediate → 0, near → exact, far → capped at 900", () => {
  const now = Date.parse("2026-07-10T00:00:00Z");
  assert.equal(delaySecondsFor(new Date(now), now), 0);
  assert.equal(delaySecondsFor(new Date(now - 5000), now), 0, "past runAfter never goes negative");
  assert.equal(delaySecondsFor(new Date(now + 60_000), now), 60);
  assert.equal(delaySecondsFor(new Date(now + 12 * 3600 * 1000), now), MAX_SQS_DELAY_SECONDS,
    "12h webhook retries hop in ≤900s steps");
});

test("sqs mode: message carries type/payload/notBefore with capped DelaySeconds", async () => {
  const sent = [];
  __setTestSqs({ send: async (cmd) => { sent.push(cmd.input); return {}; } });

  await withEnv({ QUEUE_BACKEND: "sqs", SQS_QUEUE_URL: "https://sqs.test/q" }, async () => {
    const runAfter = new Date(Date.now() + 2 * 3600 * 1000); // 2h out
    await enqueue("send_webhook", { deliveryId: 7 }, { runAfter, maxAttempts: 1 });
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].QueueUrl, "https://sqs.test/q");
  assert.equal(sent[0].DelaySeconds, MAX_SQS_DELAY_SECONDS);
  const body = JSON.parse(sent[0].MessageBody);
  assert.equal(body.type, "send_webhook");
  assert.equal(body.payload.deliveryId, 7);
  assert.ok(body.notBefore, "handler needs the target time to run the ladder");
});

test("sqs mode without SQS_QUEUE_URL fails loudly", async () => {
  __setTestSqs({ send: async () => ({}) });
  await withEnv({ QUEUE_BACKEND: "sqs", SQS_QUEUE_URL: "" }, async () => {
    await assert.rejects(() => enqueue("run_verification", {}), /SQS_QUEUE_URL/);
  });
});

// --------------------------------------------------------------------------
// db mode + Lambda: the worker "kick" — best-effort async invoke after an
// immediate enqueue so verification starts in seconds, not on the next cron.
// --------------------------------------------------------------------------

const { __setTestLambda } = require("../src/services/jobService");
const { setDb } = require("../src/lib/db");
const { createMockDb } = require("./helpers/mockDb");

test("db mode with WORKER_LAMBDA_ARN: immediate enqueue kicks a drain", async () => {
  setDb(createMockDb());
  const invokes = [];
  __setTestLambda({ send: async (cmd) => { invokes.push(cmd.input); return {}; } });

  await withEnv({ QUEUE_BACKEND: "db", WORKER_LAMBDA_ARN: "arn:aws:lambda:x:fn" }, async () => {
    await enqueue("run_verification", { sessionUid: "vps_k" });
    await new Promise((r) => setImmediate(r)); // fire-and-forget settles
  });

  assert.equal(invokes.length, 1);
  assert.equal(invokes[0].FunctionName, "arn:aws:lambda:x:fn");
  assert.equal(invokes[0].InvocationType, "Event", "async — must never block the API request");
  assert.equal(JSON.parse(invokes[0].Payload).type, "drain");
});

test("db mode: FUTURE-scheduled jobs do not kick (the cron drain owns those)", async () => {
  setDb(createMockDb());
  const invokes = [];
  __setTestLambda({ send: async (cmd) => { invokes.push(cmd.input); return {}; } });

  await withEnv({ QUEUE_BACKEND: "db", WORKER_LAMBDA_ARN: "arn:aws:lambda:x:fn" }, async () => {
    await enqueue("send_webhook", { deliveryId: 1 }, { runAfter: new Date(Date.now() + 60_000) });
    await new Promise((r) => setImmediate(r));
  });
  assert.equal(invokes.length, 0);
});

test("db mode without WORKER_LAMBDA_ARN: plain row, no kick (polling worker topology)", async () => {
  const db = createMockDb();
  setDb(db);
  const invokes = [];
  __setTestLambda({ send: async (cmd) => { invokes.push(cmd.input); return {}; } });

  await withEnv({ QUEUE_BACKEND: "db", WORKER_LAMBDA_ARN: "" }, async () => {
    await enqueue("run_verification", { sessionUid: "vps_p" });
    await new Promise((r) => setImmediate(r));
  });
  assert.equal(invokes.length, 0);
  assert.equal((await db.jobQueue.findMany({ where: { status: "pending" } })).length, 1);
});
