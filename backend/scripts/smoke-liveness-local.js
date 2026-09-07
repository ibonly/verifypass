"use strict";
// Local-only smoke: real Prisma, HTTP/CORS middleware, image sanitization,
// encrypted storage and rollback. Never sends a real biometric image.
require("../src/env");
const assert = require("assert/strict");
const crypto = require("crypto");
const sharp = require("sharp");
const request = require("supertest");
const { getDb } = require("../src/lib/db");
const { createScope } = require("../src/middleware/tenantScope");
const { createSession } = require("../src/services/sessionService");
const { readEvidence, deleteEvidence } = require("../src/services/evidenceStore");
const config = require("../src/config");
(async () => {
  const hostname = new URL(process.env.DATABASE_URL).hostname;
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(hostname), "smoke test is restricted to local MongoDB");
  config.cloudinary.enabled = false;
  const db = getDb();
  const marker = `smoke_${crypto.randomUUID()}`;
  let tenant, session;
  try {
    tenant = await db.tenant.create({ data: { tenantUid: marker, companyName: "Temporary liveness smoke", status: "active" } });
    const scope = createScope(db, tenant.id);
    const c = await createSession(scope, { verificationType: "FACE_ONLY" }, false);
    session = await scope.sessions.findByUid(c.sessionId);
    const app = require("../src/app");
    const preflight = await request(app).options(`/v1/verification-sessions/${c.sessionId}/liveness-frame`).set("Origin", "http://localhost:5175").set("Access-Control-Request-Method", "POST").set("Access-Control-Request-Headers", "content-type,x-vp-sdk-token");
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers["access-control-allow-headers"].toLowerCase(), /x-vp-sdk-token/);
    const consent = await request(app).post(`/v1/verification-sessions/${c.sessionId}/consent`).set("X-VP-SDK-Token", c.sdkToken).send({ sdkToken: c.sdkToken, copyVersion: "synthetic-smoke" });
    assert.equal(consent.status, 200);
    const png = await sharp(crypto.randomBytes(128*128*3), {raw:{width:128,height:128,channels:3}}).png().toBuffer();
    const upload = await request(app).post(`/v1/verification-sessions/${c.sessionId}/liveness-frame`).set("X-VP-SDK-Token", c.sdkToken).send({ sdkToken: c.sdkToken, attemptId: c.attemptId, action: c.livenessChallenge.actions[0], captureMode: "auto", imageBase64: png.toString("base64") });
    assert.ok([200,201].includes(upload.status), `upload returned ${upload.status}: ${JSON.stringify(upload.body)}`);
    const file = await db.evidenceFile.findFirst({where:{sessionId:session.id}});
    assert.equal(file.attemptId,c.attemptId);
    assert.equal(file.captureMode,"auto");
    const jpeg = await readEvidence(file.storagePath);
    assert.equal(jpeg[0],255); assert.equal(jpeg[1],216);
    assert.equal(crypto.createHash("sha256").update(jpeg).digest("hex"),file.checksum);
    await assert.rejects(db.$transaction(async tx => {
      await tx.outbox.create({ data: { type: marker, payload: {}, status: "pending" } });
      throw new Error("rollback-smoke");
    }), /rollback-smoke/);
    assert.equal(await db.outbox.count({where:{type:marker}}),0);
    console.log(JSON.stringify({success:true,cors:true,realUpload:true,attemptAndCaptureFields:true,encryptedStorage:true,transactionRollback:true}));
  } finally {
    if (session) {
      const files = await db.evidenceFile.findMany({where:{sessionId:session.id}});
      for (const file of files) await deleteEvidence(file.storagePath);
      await db.evidenceFile.deleteMany({where:{sessionId:session.id}});
      await db.auditLog.deleteMany({where:{sessionId:session.id}});
      await db.verificationSession.delete({where:{id:session.id}});
    }
    if (tenant) await db.tenant.delete({where:{id:tenant.id}});
    await db.$disconnect();
  }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
