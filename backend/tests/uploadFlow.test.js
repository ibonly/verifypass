"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const sharp = require("sharp");

const { setDb } = require("../src/lib/db");
const { createMockDb } = require("./helpers/mockDb");
const { tenantScope } = require("../src/middleware/tenantScope");
const { createSession } = require("../src/services/sessionService");
const { handleUpload, sniffImageType, MAX_IMAGE_BYTES } = require("../src/services/uploadService");
const { readEvidence } = require("../src/services/evidenceStore");

function scopeFor(tenant) {
  const req = { tenant };
  tenantScope(req, {}, () => {});
  return req.scopedDb;
}

/** Fake PNG header for cheap magic-byte tests only. */
function fakePng(bytes = 4096) {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(bytes)]);
}

function realPng() {
  const width = 128;
  const height = 96;
  return sharp(crypto.randomBytes(width * height * 3), { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function setup() {
  const db = createMockDb();
  setDb(db);
  const tenant = await db.tenant.create({ data: { tenantUid: "tnt_up", companyName: "Up", status: "active" } });
  const scope = scopeFor(tenant);
  const created = await createSession(scope, { customerReference: "C1" }, false);
  const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), "vp-up-"));
  return { db, tenant, scope, created, evidenceDir };
}

test("sniffImageType identifies jpeg/png/webp, rejects others", () => {
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImageType(fakePng()), "image/png");
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)]);
  assert.equal(sniffImageType(webp), "image/webp");
  assert.equal(sniffImageType(Buffer.from("GIF89a......")), null);
  assert.equal(sniffImageType(Buffer.from("<html>hi</html>")), null);
});

test("happy path: upload stores encrypted evidence and advances status", async (t) => {
  const { tenant, scope, created, evidenceDir } = await setup();
  t.after(() => setDb(null));

  const plaintext = await realPng();
  const result = await handleUpload({
    scopedDb: scope, tenantUid: tenant.tenantUid, sessionUid: created.sessionId,
    sdkToken: created.sdkToken, kind: "document", side: "front",
    imageBase64: plaintext.toString("base64"), evidenceDir
  });

  assert.equal(result.success, true);
  assert.equal(result.fileType, "id_front");
  assert.equal(result.contentType, "image/jpeg");
  assert.equal(result.originalContentType, "image/png");

  const session = await scope.sessions.findByUid(created.sessionId);
  assert.equal(session.status, "started");

  const evidence = await scope.evidence.listForSession(session.id);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].encrypted, true);
  assert.ok(evidence[0].retentionExpiresAt instanceof Date);

  // Stored encrypted; decrypts to a sanitized JPEG, not the original upload bytes
  const onDisk = await fs.readFile(evidence[0].storagePath);
  assert.equal(onDisk.includes(plaintext.subarray(0, 32)), false);
  const decrypted = await readEvidence(evidence[0].storagePath);
  assert.equal(decrypted.equals(plaintext), false);
  assert.equal(decrypted[0], 0xff);
  assert.equal(decrypted[1], 0xd8);
});

test("data-url prefix is accepted", async (t) => {
  const { tenant, scope, created, evidenceDir } = await setup();
  t.after(() => setDb(null));
  const result = await handleUpload({
    scopedDb: scope, tenantUid: tenant.tenantUid, sessionUid: created.sessionId,
    sdkToken: created.sdkToken, kind: "face",
    imageBase64: `data:image/png;base64,${(await realPng()).toString("base64")}`, evidenceDir
  });
  assert.equal(result.fileType, "selfie");
});

test("wrong sdk token rejected", async (t) => {
  const { tenant, scope, created, evidenceDir } = await setup();
  t.after(() => setDb(null));
  const imageBase64 = (await realPng()).toString("base64");
  await assert.rejects(
    () => handleUpload({
      scopedDb: scope, tenantUid: tenant.tenantUid, sessionUid: created.sessionId,
      sdkToken: "sdk_stolen_token", kind: "document",
      imageBase64, evidenceDir
    }),
    (e) => e.code === "INVALID_API_KEY"
  );
});

test("expired session rejected and marked expired", async (t) => {
  const { tenant, scope, created, evidenceDir } = await setup();
  t.after(() => setDb(null));
  await scope.sessions.update(created.sessionId, { expiresAt: new Date(Date.now() - 1000) });
  const imageBase64 = (await realPng()).toString("base64");

  await assert.rejects(
    () => handleUpload({
      scopedDb: scope, tenantUid: tenant.tenantUid, sessionUid: created.sessionId,
      sdkToken: created.sdkToken, kind: "document",
      imageBase64, evidenceDir
    }),
    (e) => e.code === "SESSION_EXPIRED"
  );
  const session = await scope.sessions.findByUid(created.sessionId);
  assert.equal(session.status, "expired");
});

test("validation: bad format, too small, too large, bad side", async (t) => {
  const { tenant, scope, created, evidenceDir } = await setup();
  t.after(() => setDb(null));
  const base = {
    scopedDb: scope, tenantUid: tenant.tenantUid, sessionUid: created.sessionId,
    sdkToken: created.sdkToken, kind: "document", evidenceDir
  };

  const cases = [
    { ...base, imageBase64: Buffer.from("just text, not an image, padded ".repeat(64)).toString("base64") },
    { ...base, imageBase64: fakePng(10).subarray(0, 100).toString("base64") }, // < 1KB
    { ...base, imageBase64: fakePng(MAX_IMAGE_BYTES).toString("base64") },      // > 8MB
    { ...base, side: "hologram", imageBase64: (await realPng()).toString("base64") }
  ];
  for (const c of cases) {
    await assert.rejects(() => handleUpload(c), (e) => e.code === "VALIDATION_ERROR");
  }
});

test("cannot upload to another tenant's session", async (t) => {
  const { db, created, evidenceDir } = await setup();
  t.after(() => setDb(null));
  const intruder = await db.tenant.create({ data: { tenantUid: "tnt_intruder", companyName: "X", status: "active" } });
  const imageBase64 = (await realPng()).toString("base64");

  await assert.rejects(
    () => handleUpload({
      scopedDb: scopeFor(intruder), tenantUid: intruder.tenantUid, sessionUid: created.sessionId,
      sdkToken: created.sdkToken, kind: "document",
      imageBase64, evidenceDir
    }),
    (e) => e.code === "SESSION_NOT_FOUND"
  );
});

test("getSession lazily expires stale sessions", async (t) => {
  const { scope, created } = await setup();
  t.after(() => setDb(null));
  const { getSession } = require("../src/services/sessionService");

  await scope.sessions.update(created.sessionId, { expiresAt: new Date(Date.now() - 1000) });
  const res = await getSession(scope, created.sessionId);
  assert.equal(res.status, "expired");
});
