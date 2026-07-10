"use strict";

// Maker-checker (four-eyes) on manual review decisions — tenant opt-in via
// settings.review.dualApproval. Terminal decisions require a SECOND, DIFFERENT
// reviewer; recapture stays immediate.

const test = require("node:test");
const assert = require("node:assert/strict");

const { setDb } = require("../src/lib/db");
const { createMockDb } = require("./helpers/mockDb");
const { dualApprovalFor, validateReview } = require("../src/services/settingsService");
const { signToken } = require("../src/services/authTokens");

let request = null;
let app = null;
try {
  request = require("supertest");
  app = require("../src/app");
} catch (_) { /* deps not installed in this sandbox */ }
const httpOpts = { skip: request && app ? false : "express/supertest/app not loadable here" };

test("dualApprovalFor reads the tenant setting; validateReview gates the patch", () => {
  assert.equal(dualApprovalFor({ settings: { review: { dualApproval: true } } }), true);
  assert.equal(dualApprovalFor({ settings: {} }), false);
  assert.equal(dualApprovalFor(null), false);
  assert.deepEqual(validateReview({ dualApproval: true }), { dualApproval: true });
  assert.throws(() => validateReview({ dualApproval: "yes" }), (e) => e.code === "VALIDATION_ERROR");
  assert.throws(() => validateReview({ bogus: 1 }), (e) => e.code === "VALIDATION_ERROR");
});

test("maker-checker via HTTP: propose → self-confirm blocked → second reviewer applies", httpOpts, async (t) => {
  const db = createMockDb();
  setDb(db);
  t.after(() => setDb(null));

  const tenant = await db.tenant.create({
    data: { tenantUid: "tnt_mc", companyName: "MC", status: "active", settings: { review: { dualApproval: true } } }
  });
  const session = await db.verificationSession.create({
    data: { sessionUid: "vps_MC1", tenantId: tenant.id, status: "manual_review" }
  });
  const [a, b] = await Promise.all(["a", "b"].map((n) => db.user.create({
    data: { tenantId: tenant.id, email: `${n}@mc.ng`, passwordHash: "x", role: "compliance_reviewer", status: "active" }
  })));
  const tokenFor = (u) => signToken({ userId: String(u.id), role: u.role });

  // 1. First reviewer proposes — session must NOT change
  const r1 = await request(app)
    .post("/v1/manual-review/vps_MC1/decision")
    .set("Authorization", `Bearer ${tokenFor(a)}`)
    .send({ decision: "approved", note: "looks fine" });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.status, "pending_second_approval");
  assert.equal((await db.verificationSession.findFirst({ where: { id: session.id } })).status, "manual_review");

  // 2. Same reviewer cannot confirm their own proposal
  const r2 = await request(app)
    .post("/v1/manual-review/vps_MC1/decision")
    .set("Authorization", `Bearer ${tokenFor(a)}`)
    .send({ decision: "approved" });
  assert.equal(r2.status, 403);

  // 3. Different reviewer confirming a DIFFERENT decision re-proposes
  const r3 = await request(app)
    .post("/v1/manual-review/vps_MC1/decision")
    .set("Authorization", `Bearer ${tokenFor(b)}`)
    .send({ decision: "rejected" });
  assert.equal(r3.body.status, "pending_second_approval");
  assert.equal(r3.body.proposedDecision, "rejected");

  // 4. First reviewer confirms the new proposal → applied
  const r4 = await request(app)
    .post("/v1/manual-review/vps_MC1/decision")
    .set("Authorization", `Bearer ${tokenFor(a)}`)
    .send({ decision: "rejected" });
  assert.equal(r4.body.status, "rejected");
  const finalSession = await db.verificationSession.findFirst({ where: { id: session.id } });
  assert.equal(finalSession.status, "rejected");

  // 5. Consumed proposal cannot be reused
  const notes = await db.manualReviewNote.findMany({ where: { sessionId: session.id } });
  assert.ok(notes.some((n) => n.decision === "applied:rejected"), "proposal marked consumed");
  assert.ok(!notes.some((n) => n.decision === "proposed:rejected"), "no dangling proposal");
});

test("dual approval OFF → single reviewer applies immediately", httpOpts, async (t) => {
  const db = createMockDb();
  setDb(db);
  t.after(() => setDb(null));
  const tenant = await db.tenant.create({ data: { tenantUid: "tnt_sd", companyName: "SD", status: "active", settings: {} } });
  await db.verificationSession.create({ data: { sessionUid: "vps_SD1", tenantId: tenant.id, status: "manual_review" } });
  const u = await db.user.create({ data: { tenantId: tenant.id, email: "solo@sd.ng", passwordHash: "x", role: "tenant_admin", status: "active" } });
  const res = await request(app)
    .post("/v1/manual-review/vps_SD1/decision")
    .set("Authorization", `Bearer ${signToken({ userId: String(u.id), role: u.role })}`)
    .send({ decision: "approved" });
  assert.equal(res.body.status, "approved");
});
