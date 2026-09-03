"use strict";

// FV-3: per-session / per-action liveness-frame upload budgets. A valid session
// token must not be able to enqueue unbounded evidence (worker-inference +
// Cloudinary-cost DoS). Caps are enforced BEFORE the expensive decode/sanitize,
// so this test never needs sharp.

// Tighten the caps via env BEFORE requiring the service (constants read at load).
process.env.MAX_LIVENESS_FRAMES_PER_ACTION = "2";
process.env.MAX_SELFIES_PER_SESSION = "2";
process.env.MAX_EVIDENCE_PER_SESSION = "50";

const test = require("node:test");
const assert = require("node:assert/strict");

const { setDb } = require("../src/lib/db");
const { createMockDb } = require("./helpers/mockDb");
const { tenantScope } = require("../src/middleware/tenantScope");
const { createSession } = require("../src/services/sessionService");
const { handleUpload } = require("../src/services/uploadService");

function scopeFor(tenant) {
  const req = { tenant };
  tenantScope(req, {}, () => {});
  return req.scopedDb;
}

async function setup() {
  const db = createMockDb();
  setDb(db);
  const tenant = await db.tenant.create({ data: { tenantUid: "tnt_cap", companyName: "C", status: "active" } });
  const scope = scopeFor(tenant);
  const created = await createSession(scope, { verificationType: "FACE_ONLY" }, false);
  const session = await scope.sessions.findByUid(created.sessionId);
  return { db, tenant, scope, created, session };
}

test("FV-3: per-action liveness frame cap is enforced before decode", async (t) => {
  const { scope, tenant, created, session } = await setup();
  t.after(() => setDb(null));

  for (let i = 0; i < 2; i++) {
    await scope.evidence.create({ sessionId: session.id, fileType: "liveness_frame", label: "smile", storagePath: `p${i}`, encrypted: true });
  }

  await assert.rejects(
    () => handleUpload({
      scopedDb: scope, tenantUid: tenant.tenantUid, sessionUid: created.sessionId,
      sdkToken: created.sdkToken, kind: "liveness", action: "smile",
      imageBase64: "data:image/jpeg;base64,AAAA"
    }),
    (err) => err.code === "VALIDATION_ERROR" && /too many liveness frames/.test(err.message)
  );
});

test("FV-3: selfie cap is enforced", async (t) => {
  const { scope, tenant, created, session } = await setup();
  t.after(() => setDb(null));

  for (let i = 0; i < 2; i++) {
    await scope.evidence.create({ sessionId: session.id, fileType: "selfie", storagePath: `s${i}`, encrypted: true });
  }

  await assert.rejects(
    () => handleUpload({
      scopedDb: scope, tenantUid: tenant.tenantUid, sessionUid: created.sessionId,
      sdkToken: created.sdkToken, kind: "face", side: "selfie",
      imageBase64: "data:image/jpeg;base64,AAAA"
    }),
    (err) => err.code === "VALIDATION_ERROR" && /too many selfie captures/.test(err.message)
  );
});
