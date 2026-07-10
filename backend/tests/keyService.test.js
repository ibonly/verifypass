"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { setDb } = require("../src/lib/db");
const { createMockDb } = require("./helpers/mockDb");
const { revokeKey, rotateKey, deleteKey } = require("../src/services/apiKeyService");

test("malformed key id (not an ObjectId) → NOT_FOUND, never a Prisma P2023 500", async (t) => {
  const db = createMockDb();
  setDb(db);
  t.after(() => setDb(null));
  const tenant = await db.tenant.create({ data: { tenantUid: "tnt_oid", companyName: "O", status: "active" } });
  for (const bad of ["abc", "12345", "'; drop--", "zzzzzzzzzzzzzzzzzzzzzzzz"]) {
    await assert.rejects(() => revokeKey(tenant.id, bad), (e) => e.code === "NOT_FOUND");
    await assert.rejects(() => rotateKey(tenant.id, bad), (e) => e.code === "NOT_FOUND");
    await assert.rejects(() => deleteKey(tenant.id, bad), (e) => e.code === "NOT_FOUND");
  }
});
