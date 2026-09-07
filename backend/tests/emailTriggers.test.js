"use strict";

// Email trigger wiring: every lifecycle/event helper calls the mail API with
// the right template + vars, and is a safe no-op when the API is unconfigured.
// No real SMTP or DB — the fetch to the PHP service is intercepted.

const test = require("node:test");
const assert = require("node:assert/strict");

const email = require("../src/services/emailService");

// Capture outbound calls to the PHP mail API.
const calls = [];
const realFetch = global.fetch;

function mockMailApi(t) {
  const environment = Object.fromEntries(["EMAIL_API_URL", "EMAIL_API_KEY", "DASHBOARD_URL", "NODE_ENV"].map(name => [name, process.env[name]]));
  process.env.EMAIL_API_URL = "https://mailer.example.test";
  process.env.EMAIL_API_KEY = "test-key-32-chars-minimum-xxxxx";
  process.env.DASHBOARD_URL = "https://app.example.test";
  global.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), rawBody: opts.body, headers: opts.headers, redirect: opts.redirect });
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  };
  t.after(() => {
    global.fetch = realFetch;
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

const user = { email: "owner@acme.test" };

test("disabled mode: every helper is a safe no-op, never throws", async (t) => {
  mockMailApi(t);
  delete process.env.EMAIL_API_URL;
  delete process.env.EMAIL_API_KEY;
  for (const fn of [
    () => email.sendWelcome(user, { companyName: "Acme" }),
    () => email.sendPasswordChanged(user, { ip: "1.2.3.4" }),
    () => email.sendMfaChanged(user, { changeKind: "enabled", ip: "1.2.3.4" }),
    () => email.sendReviewWaiting(user, { companyName: "Acme", pendingCount: 2, oldestWait: "5 min" }),
    () => email.sendWebhookFailing(user, { endpointHost: "x.test", errorClass: "HTTP 500", attempts: 5 }),
    () => email.sendDeletionCompleted(user, { auditRef: "del_1", sessionsAffected: 2, filesDeleted: 9 })
  ]) {
    const out = await fn();
    assert.equal(out.skipped, true);
  }
});

test("verify_email embeds a 24h action token and returns its hash", async (t) => {
  mockMailApi(t); calls.length = 0;
  const out = await email.sendVerifyEmail(user, { companyName: "Acme" });
  assert.equal(calls[0].body.template, "verify_email");
  assert.match(calls[0].body.vars.actionUrl, /^https:\/\/app\.example\.test\/verify-email#token=.+/);
  assert.equal(out.expiresIn, 86400);
  assert.equal(out.tokenHash.length, 64);
  const call = calls[0];
  assert.match(call.headers["X-Email-Timestamp"], /^\d{10}$/);
  assert.match(call.headers["X-Email-Nonce"], /^[a-f0-9]{32}$/);
  const expected = require("crypto").createHmac("sha256", process.env.EMAIL_API_KEY)
    .update(`v1\n${call.headers["X-Email-Timestamp"]}\n${call.headers["X-Email-Nonce"]}\n${call.rawBody}`).digest("hex");
  assert.equal(call.headers["X-Email-Signature"], expected);
  assert.equal(call.headers["X-Email-Key"], undefined);
  assert.equal(call.redirect, "error");
});

test("production refuses a plaintext mail API URL", async (t) => {
  mockMailApi(t); calls.length = 0;
  process.env.NODE_ENV = "production";
  process.env.EMAIL_API_URL = "http://mailer.example.test";
  await assert.rejects(email.sendWelcome(user, { companyName: "Acme" }), /must use HTTPS/);
  assert.equal(calls.length, 0);
});

test("delivery requires an explicit success acknowledgement", async (t) => {
  mockMailApi(t);
  for (const response of [null, {}, { success: false }, { success: "true" }]) {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => response });
    await assert.rejects(email.sendWelcome(user, { companyName: "Acme" }), /invalid delivery acknowledgement/);
  }
  global.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Invalid JSON"); } });
  await assert.rejects(email.sendWelcome(user, { companyName: "Acme" }), /invalid delivery acknowledgement/);
});

test("delivery errors do not propagate arbitrary remote error content", async (t) => {
  mockMailApi(t);
  global.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: "private recipient data" }) });
  await assert.rejects(email.sendWelcome(user, { companyName: "Acme" }), { message: "email api HTTP 503", status: 503 });
});

test("password_reset uses a 30-minute token and records request ip", async (t) => {
  mockMailApi(t); calls.length = 0;
  const out = await email.sendPasswordReset(user, { ip: "197.210.1.1" });
  assert.equal(calls[0].body.template, "password_reset");
  assert.equal(calls[0].body.vars.ip, "197.210.1.1");
  assert.match(calls[0].body.vars.actionUrl, /\/reset-password#token=/);
  assert.equal(out.expiresIn, 1800);
});

test("team_invite carries role/inviter and a 72h set-password link", async (t) => {
  mockMailApi(t); calls.length = 0;
  const out = await email.sendTeamInvite({ to: "dev@acme.test", companyName: "Acme", role: "developer", inviter: "owner@acme.test", invitationId: "inv_1" });
  assert.equal(calls[0].body.to, "dev@acme.test");
  assert.equal(calls[0].body.vars.role, "developer");
  assert.match(calls[0].body.vars.actionUrl, /\/accept-invite#token=/);
  assert.equal(out.expiresIn, 259200);
});

test("email_change_notice masks the new address for the old mailbox", async (t) => {
  mockMailApi(t); calls.length = 0;
  await email.sendEmailChangeNotice(user, { newEmail: "newaddress@acme.test", ip: "1.2.3.4" });
  assert.equal(calls[0].body.template, "email_change_notice");
  assert.match(calls[0].body.vars.newEmailMasked, /^ne\*{3}@acme\.test$/);
  assert.ok(!calls[0].body.vars.newEmailMasked.includes("newaddress"));
});

test("review + webhook + deletion triggers carry counts, not customer PII", async (t) => {
  mockMailApi(t); calls.length = 0;
  await email.sendReviewWaiting(user, { companyName: "Acme", pendingCount: 3, oldestWait: "12 min" });
  await email.sendReviewSecondConfirmation(user, { proposer: "r1@acme.test", proposedDecision: "approval", caseAge: "9 min" });
  await email.sendWebhookChanged(user, { companyName: "Acme", endpointHost: "hooks.acme.test", secretRotated: true, actor: "owner@acme.test" });
  await email.sendDeletionCompleted(user, { auditRef: "del_9", sessionsAffected: 4, filesDeleted: 41 });

  const [review, second, hook, del] = calls.map(c => c.body);
  assert.equal(review.template, "review_waiting");
  assert.equal(review.vars.pendingCount, "3");
  assert.equal(second.template, "review_second_confirmation");
  assert.equal(second.vars.proposedDecision, "approval");
  assert.equal(hook.template, "webhook_changed");
  assert.equal(hook.vars.secretRotated, "yes");
  assert.equal(del.template, "deletion_completed");
  assert.equal(del.vars.filesDeleted, "41");
  // None of the bodies carry a customer reference or scores.
  for (const c of calls) {
    const s = JSON.stringify(c.body.vars);
    assert.ok(!/customerReference|livenessScore|faceMatch/.test(s), `PII leaked in ${c.body.template}`);
  }
});

test("production + ops triggers address the right recipient", async (t) => {
  mockMailApi(t); calls.length = 0;
  await email.sendProductionRequestOps("ops@verifypass.test", { companyName: "Acme", tenantUid: "tnt_1", contactEmail: "owner@acme.test", checklistSummary: "profile:done", testSessions: 2 });
  await email.sendProductionDecision(user, { decision: "approved", reasonText: "Checklist complete." });
  await email.sendWorkspaceStatus(user, { companyName: "Acme", statusChange: "suspended", reasonCategory: "policy" });
  await email.sendOpsAlert("ops@verifypass.test", { signal: "worker_down", hostId: "worker-1", firstSeen: "t0", lastSeen: "t1", detail: "no tick in 5m" });

  assert.equal(calls[0].body.to, "ops@verifypass.test");
  assert.equal(calls[0].body.template, "production_request_ops");
  assert.equal(calls[1].body.vars.decision, "approved");
  assert.equal(calls[2].body.template, "workspace_status");
  assert.equal(calls[3].body.template, "ops_alert");
  assert.equal(calls[3].body.vars.signal, "worker_down");
});

test("weekly digest and incident notice render with aggregate stats", async (t) => {
  mockMailApi(t); calls.length = 0;
  await email.sendWeeklyDigest(user, { companyName: "Acme", totalVerifications: 120, approvedCount: 80, rejectedCount: 30, reviewCount: 10, topReasons: "liveness, face_match", queueDepth: 4, webhookHealth: "ok" });
  await email.sendIncidentNotice(user, { windowStart: "t0", windowEnd: "t1", dataCategories: "email addresses", actionsTaken: "contained", tenantActions: "rotate keys", incidentRef: "inc-1" });
  assert.equal(calls[0].body.template, "weekly_digest");
  assert.equal(calls[1].body.template, "incident_notice");
  assert.equal(calls[1].body.vars.incidentRef, "inc-1");
});
