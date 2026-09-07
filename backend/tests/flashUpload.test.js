"use strict";

// Screen-flash upload validation (sharp-free: every case here is rejected or
// stored before/without image decoding — the JPEG path is covered by
// uploadFlow.test.js on a machine where sharp loads).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const { setDb } = require("../src/lib/db");
const { createMockDb } = require("./helpers/mockDb");
const { tenantScope } = require("../src/middleware/tenantScope");
const { createSession } = require("../src/services/sessionService");
const { handleUpload } = require("../src/services/uploadService");

async function setup() {
  const db = createMockDb();
  setDb(db);
  const tenant = await db.tenant.create({ data: { tenantUid: "tnt_fl", companyName: "Fl", status: "active" } });
  const req = { tenant };
  tenantScope(req, {}, () => {});
  const created = await createSession(req.scopedDb, { customerReference: "C1" }, false);
  const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), "vp-fl-"));
  return { db, tenant, scope: req.scopedDb, created, evidenceDir };
}

const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]).toString("base64");

test("flash upload: sequence must be well-formed (4 distinct palette colours)", async (t) => {
  const { tenant, scope, created, evidenceDir } = await setup();
  t.after(() => setDb(null));
  const base = { scopedDb: scope, tenantUid: tenant.tenantUid, sessionUid: created.sessionId, sdkToken: created.sdkToken, attemptId: created.attemptId, kind: "flash", imageBase64: JPEG_HEADER, evidenceDir, retentionDays: 30 };
  for (const meta of [undefined, {}, { sequence: [[255, 0, 0]] }, { sequence: [[255, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]] }, { sequence: [[1, 2, 3], [255, 0, 0], [0, 255, 0], [0, 0, 255]] }]) {
    await assert.rejects(handleUpload({ ...base, meta }), (e) => e.code === "VALIDATION_ERROR" && /colour sequence/.test(e.message));
  }
});

test("flash upload: no action/challenge membership needed; label is 'flash'", async (t) => {
  const { tenant, scope, created, evidenceDir } = await setup();
  t.after(() => setDb(null));
  const meta = { sequence: (await scope.sessions.findByUid(created.sessionId)).livenessChallenge.flashSequence, tile: 96 };
  // a garbage body reaches the decoder (past validation) — proves the flash
  // branch does not demand `action` or membership in the challenge set
  await assert.rejects(
    handleUpload({ scopedDb: scope, tenantUid: tenant.tenantUid, sessionUid: created.sessionId, sdkToken: created.sdkToken, attemptId: created.attemptId, kind: "flash", meta, imageBase64: "not-base64!!", evidenceDir, retentionDays: 30 }),
    (e) => e.code === "VALIDATION_ERROR" && !/colour sequence|action/.test(e.message)
  );
});
