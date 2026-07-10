"use strict";

// Background job dispatch, two backends:
//   QUEUE_BACKEND=db   (default) — row in job_queue; the polling worker (or
//                       dev stack) claims it. Right for VPS/cPanel deploys.
//   QUEUE_BACKEND=sqs  — message to SQS_QUEUE_URL; an SQS-triggered Lambda
//                       (apps/worker/lambda.js) processes it. No polling
//                       process exists in this topology.
//
// Long delays: SQS caps DelaySeconds at 900 (15 min), but webhook retries
// schedule up to 12h out. Messages therefore carry `notBefore`; the Lambda
// handler re-enqueues any message that arrives early with the next ≤900s
// hop until the time comes (the standard SQS delay ladder).
//
// @aws-sdk/client-sqs is an optional dependency, lazy-required so db-mode
// deployments and the test suite never need it installed.

const { getDb } = require("../lib/db");

const MAX_SQS_DELAY_SECONDS = 900;

function queueBackend() {
  return (process.env.QUEUE_BACKEND || "db").toLowerCase();
}

let sqsClient = null;
let sqsSdk = null;

function getSqs() {
  if (!sqsSdk) {
    try {
      sqsSdk = require("@aws-sdk/client-sqs");
    } catch {
      throw new Error("QUEUE_BACKEND=sqs requires @aws-sdk/client-sqs (npm i @aws-sdk/client-sqs)");
    }
  }
  if (!sqsClient) {
    sqsClient = new sqsSdk.SQSClient({ region: process.env.S3_REGION || process.env.AWS_REGION || "us-east-1" });
  }
  return { client: sqsClient, sdk: sqsSdk };
}

/** TEST-ONLY: inject a fake SQS client. */
function __setTestSqs(client, sdk) {
  sqsClient = client;
  sqsSdk = sdk || { SendMessageCommand: function (input) { this.input = input; } };
}

/** Delay for the NEXT hop toward notBefore, capped at the SQS maximum. */
function delaySecondsFor(runAfter, now = Date.now()) {
  const remaining = Math.ceil((new Date(runAfter).getTime() - now) / 1000);
  return Math.max(0, Math.min(remaining, MAX_SQS_DELAY_SECONDS));
}

async function enqueueSqs(type, payload, { runAfter, maxAttempts, now = Date.now() }) {
  const queueUrl = process.env.SQS_QUEUE_URL;
  if (!queueUrl) throw new Error("QUEUE_BACKEND=sqs requires SQS_QUEUE_URL");
  const { client, sdk } = getSqs();
  const body = {
    type,
    payload,
    maxAttempts,
    // consumed by the Lambda handler's delay ladder
    notBefore: new Date(runAfter).toISOString()
  };
  await client.send(new sdk.SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(body),
    DelaySeconds: delaySecondsFor(runAfter, now)
  }));
  return body;
}

// ---------------------------------------------------------------------------
// Worker "kick" (db backend on Lambda): after writing the job row, async-
// invoke the worker function with {type:"drain"} so verification starts in
// seconds instead of on the next EventBridge minute. Fire-and-forget and
// strictly best-effort — the row is the source of truth, the scheduled drain
// is the guarantee, the kick is only latency.
// ---------------------------------------------------------------------------
let lambdaClient = null;
let lambdaSdk = null;

function getLambda() {
  if (!lambdaSdk) {
    try {
      lambdaSdk = require("@aws-sdk/client-lambda");
    } catch {
      return null; // sdk not installed — scheduled drain still covers us
    }
  }
  if (!lambdaClient) {
    lambdaClient = new lambdaSdk.LambdaClient({ region: process.env.AWS_REGION || "us-east-1" });
  }
  return { client: lambdaClient, sdk: lambdaSdk };
}

/** TEST-ONLY: inject a fake Lambda client. */
function __setTestLambda(client, sdk) {
  lambdaClient = client;
  lambdaSdk = sdk || { InvokeCommand: function (input) { this.input = input; } };
}

function kickWorker() {
  const fnArn = process.env.WORKER_LAMBDA_ARN;
  if (!fnArn) return; // not running on Lambda — polling worker handles it
  const aws = getLambda();
  if (!aws) return;
  aws.client.send(new aws.sdk.InvokeCommand({
    FunctionName: fnArn,
    InvocationType: "Event", // async — never blocks or fails the API request
    Payload: JSON.stringify({ type: "drain" })
  })).catch((err) => console.warn("WORKER_KICK_FAILED (scheduled drain will pick it up)", err.message));
}

/** Enqueue a background job on the configured backend. */
async function enqueue(type, payload = {}, { runAfter = new Date(), maxAttempts = 5 } = {}) {
  if (queueBackend() === "sqs") {
    return enqueueSqs(type, payload, { runAfter, maxAttempts });
  }
  const row = await getDb().jobQueue.create({
    data: { type, payload, status: "pending", runAfter, maxAttempts }
  });
  if (runAfter.getTime() <= Date.now()) kickWorker(); // immediate jobs only
  return row;
}

module.exports = { enqueue, queueBackend, delaySecondsFor, MAX_SQS_DELAY_SECONDS, __setTestSqs, __setTestLambda };
