"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createMockDb } = require("../../api/tests/helpers/mockDb");
const { capFailedSessionRetention } = require("../src/retention");

const DAY = 24 * 3600 * 1000;

test("caps evidence of dead sessions to tenant failedSessionDays; leaves live sessions alone", async () => {
  const db = createMockDb();
  const now = new Date();

  // tenant with custom 2-day failed-session policy
  const tenant = await db.tenant.create({
    data: { tenantUid: "tnt_ret", companyName: "R", status: "active", settings: { retention: { failedSessionDays: 2 } } }
  });
  const endedAt = new Date(now.getTime() - 1 * DAY);

  const dead = await db.verificationSession.create({
    data: { sessionUid: "vps_DEAD", tenantId: tenant.id, status: "expired", completedAt: null, updatedAt: endedAt }
  });
  const alive = await db.verificationSession.create({
    data: { sessionUid: "vps_LIVE", tenantId: tenant.id, status: "approved", completedAt: now }
  });

  const farFuture = new Date(now.getTime() + 30 * DAY);
  await db.evidenceFile.create({ data: { sessionId: dead.id, fileType: "selfie", storagePath: "/x/dead.enc", retentionExpiresAt: farFuture } });
  await db.evidenceFile.create({ data: { sessionId: alive.id, fileType: "selfie", storagePath: "/x/live.enc", retentionExpiresAt: farFuture } });

  const capped = await capFailedSessionRetention(db, now);
  assert.equal(capped, 1);

  const deadFile = await db.evidenceFile.findFirst({ where: { sessionId: dead.id } });
  const expectedCap = new Date(endedAt.getTime() + 2 * DAY);
  assert.equal(deadFile.retentionExpiresAt.getTime(), expectedCap.getTime());

  const liveFile = await db.evidenceFile.findFirst({ where: { sessionId: alive.id } });
  assert.equal(liveFile.retentionExpiresAt.getTime(), farFuture.getTime());

  // idempotent: second run caps nothing further
  assert.equal(await capFailedSessionRetention(db, now), 0);
});

test("default policy (7 days) applies when tenant has no override", async () => {
  const db = createMockDb();
  const now = new Date();
  const tenant = await db.tenant.create({ data: { tenantUid: "tnt_def", companyName: "D", status: "active", settings: {} } });
  const ended = new Date(now.getTime() - 3 * DAY);
  const s = await db.verificationSession.create({
    data: { sessionUid: "vps_F", tenantId: tenant.id, status: "failed", completedAt: ended }
  });
  await db.evidenceFile.create({ data: { sessionId: s.id, fileType: "id_front", storagePath: "/x/f.enc", retentionExpiresAt: new Date(now.getTime() + 60 * DAY) } });

  await capFailedSessionRetention(db, now);
  const file = await db.evidenceFile.findFirst({ where: { sessionId: s.id } });
  assert.equal(file.retentionExpiresAt.getTime(), new Date(ended.getTime() + 7 * DAY).getTime());
});
