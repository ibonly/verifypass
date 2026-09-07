"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createMockDb } = require("./helpers/mockDb");
const { createScope } = require("../src/middleware/tenantScope");
const { createSession, retrySession, reissueChallenge, submitSession } = require("../src/services/sessionService");
const { setDb } = require("../src/lib/db");
async function setup(status = "started") {
  const db = createMockDb(); setDb(db);
  const tenant = await db.tenant.create({ data: { tenantUid: "hardening", status: "active" } });
  const scope = createScope(db, tenant.id);
  const created = await createSession(scope, { verificationType: "FACE_ONLY" }, false);
  await scope.sessions.update(created.sessionId, { status, consentAt: new Date() });
  return { db, tenant, scope, created };
}
test("concurrent submit creates exactly one verification outbox record", async () => {
  const { db, scope, created: c } = await setup();
  await Promise.all([submitSession(scope, c.sessionId, c.sdkToken, c.attemptId), submitSession(scope, c.sessionId, c.sdkToken, c.attemptId)]);
  assert.equal(db.outbox.rows.filter(r => r.type === "run_verification").length, 1);
  assert.equal(db.jobQueue.rows.length, 1);
  assert.equal(db.jobQueue.rows[0].payload.attemptId, c.attemptId);
});
test("submit rolls back on outbox persistence failure", async () => {
  const { db, scope, created: c } = await setup();
  db.outbox.create = async () => { throw new Error("outbox unavailable"); };
  await assert.rejects(submitSession(scope, c.sessionId, c.sdkToken, c.attemptId), /outbox unavailable/);
  assert.equal((await scope.sessions.findByUid(c.sessionId)).status, "started");
  assert.equal(db.jobQueue.rows.length, 0);
});
test("concurrent retry consumes one attempt and fences stale requests", async () => {
  const { db, scope, created: c } = await setup("rejected");
  const args = { attemptId: c.attemptId };
  const results = await Promise.allSettled([retrySession(scope, c.sessionId, c.sdkToken, args), retrySession(scope, c.sessionId, c.sdkToken, args)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((await scope.sessions.findByUid(c.sessionId)).attemptNumber, 2);
  assert.equal(db.auditLog.rows.filter(r => r.action === "session.retry").length, 1);
  await assert.rejects(submitSession(scope, c.sessionId, c.sdkToken, c.attemptId), /Attempt changed/);
});
test("reissue refuses stripping all movement requirements and marks assisted flow", async () => {
  const { scope, created: c } = await setup();
  const before = await scope.sessions.findByUid(c.sessionId);
  await assert.rejects(reissueChallenge(scope, c.sessionId, c.sdkToken, { attemptId: c.attemptId, excludeActions: before.livenessChallenge.actions }), /one movement/);
  const result = await reissueChallenge(scope, c.sessionId, c.sdkToken, { attemptId: c.attemptId, excludeActions: [before.livenessChallenge.actions[0]] });
  assert.equal(result.livenessChallenge.assisted, true);
  assert.notEqual(result.attemptId, c.attemptId);
  assert.ok(result.livenessChallenge.actions.length >= 2);
});

test("concurrent uploads reserve one remaining slot and remove the losing file", async t => {
  const { db, tenant, scope, created:c }=await setup();
  const fs=require("fs/promises"),path=require("path"),os=require("os"),sharp=require("sharp");
  const {handleUpload}=require("../src/services/uploadService");
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"vp-cap-race-"));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const session=await scope.sessions.findByUid(c.sessionId);
  const action=session.livenessChallenge.actions[0];
  for(let i=0;i<7;i++) await db.evidenceFile.create({data:{sessionId:session.id,attemptId:c.attemptId,fileType:"liveness_frame",label:action,challengeNonce:session.livenessChallenge.nonce}});
  const png=await sharp(require("crypto").randomBytes(128*128*3),{raw:{width:128,height:128,channels:3}}).png().toBuffer();
  const args={scopedDb:scope,tenantUid:tenant.tenantUid,sessionUid:c.sessionId,sdkToken:c.sdkToken,attemptId:c.attemptId,kind:"liveness",action,captureMode:"auto",imageBase64:png.toString("base64"),evidenceDir:dir};
  const results=await Promise.allSettled([handleUpload(args),handleUpload(args)]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  assert.equal(db.evidenceFile.rows.length,8);
  const files=await fs.readdir(path.join(dir,tenant.tenantUid,c.sessionId));
  assert.equal(files.length,1,"rejected upload must not leave an orphan blob");
  assert.equal(db.evidenceStaging.rows.length,0,"settled compensation must not leave a staging row for the sweeper");
});
