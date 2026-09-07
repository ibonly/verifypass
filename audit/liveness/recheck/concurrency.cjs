"use strict";
process.env.NODE_ENV = "test"; process.env.REQUIRE_CONSENT = "false"; process.env.QUEUE_BACKEND = "db"; process.env.MAX_LIVENESS_FRAMES_PER_ACTION = "2";
const ROOT=require("node:path").resolve(__dirname, "../../..");
const assert = require("node:assert/strict");
const { createMockDb } = require(ROOT+"/backend/tests/helpers/mockDb");
const { setDb } = require(ROOT+"/backend/src/lib/db");
const { tenantScope } = require(ROOT+"/backend/src/middleware/tenantScope");
const sessions = require(ROOT+"/backend/src/services/sessionService");
const cloud = require(ROOT+"/backend/src/services/cloudinaryService");
const store = require(ROOT+"/backend/src/services/evidenceStore");
let writes = 0, deletes = 0;
cloud.uploadEvidenceImage = async () => null;
store.saveEvidence = async () => ({ checksum: `fake-checksum-${++writes}`, storagePath: `fake-storage-${writes}`, retentionExpiresAt: new Date() });
if (store.deleteEvidence) store.deleteEvidence = async () => { deletes++; };
if (store.removeEvidence) store.removeEvidence = async () => { deletes++; };
const { handleUpload } = require(ROOT+"/backend/src/services/uploadService");
function barrier(n) { let arrived=0, release; const wait=new Promise(r=>{release=r;}); return async()=>{if(++arrived===n)release();await wait;}; }
async function fixture(status="started") {
  const db=createMockDb(); setDb(db);
  const tenant=await db.tenant.create({data:{tenantUid:"tnt_audit_races",status:"active",settings:{}}});
  const sessionUid="vps_races";const token=sessions.signSdkToken(sessionUid);
  const session=await db.verificationSession.create({data:{sessionUid,tenantId:tenant.id,status,verificationType:"FACE_ONLY",sdkTokenHash:token.tokenHash,expiresAt:new Date(Date.now()+600000),livenessChallenge:{nonce:"nonce",issuedAt:new Date().toISOString(),actions:["turn_left","turn_right","blink"]}}});
  const req={tenant};tenantScope(req,{},()=>{});
  return {db,tenant,session,scopedDb:req.scopedDb,sdkToken:token.token};
}
const out=[]; async function block(id, fn){ try{ const info=await fn(); out.push({id,state:"STILL_REPRODUCES",info}); } catch(e){ out.push({id,state:e.code==="ERR_ASSERTION"?"FIXED":"ERROR",info:(e.message||String(e)).slice(0,600)}); } }
(async()=>{
  await block("L15-retry-audit-failure", async()=>{
    const f=await fixture("rejected"); f.db.auditLog.create=async()=>{throw Error("simulated audit failure");};
    const oe=console.error; console.error=()=>{}; const results=[];
    try { for(let i=0;i<7;i++){ f.session.status="rejected"; try { const r=await sessions.retrySession(f.scopedDb,f.session.sessionUid,f.sdkToken,{tenantId:f.tenant.id}); results.push("ok:"+r.attempts); } catch(e){ results.push("err:"+(e.code||e.message)); } } } finally { console.error=oe; }
    assert.ok(results.every(r=>r==="ok:2"), JSON.stringify(results)); return JSON.stringify(results);
  });
  await block("L15-retry-limit-no-audit-failure", async()=>{
    const f=await fixture("rejected"); const results=[];
    for(let i=0;i<7;i++){ f.session.status="rejected"; try { const r=await sessions.retrySession(f.scopedDb,f.session.sessionUid,f.sdkToken,{tenantId:f.tenant.id}); results.push("ok:"+r.attempts); } catch(e){ results.push("err:"+(e.code||e.message)); } }
    assert.ok(results.filter(r=>r.startsWith("ok")).length>5, JSON.stringify(results)); return JSON.stringify(results);
  });
  await block("L15-reissue-race", async()=>{
    const f=await fixture(); const gate=barrier(3);
    // gate whichever read the service performs first
    const list=f.scopedDb.auditLogs?.list; if(list) f.scopedDb.auditLogs.list=async(...a)=>{const s=await list(...a);await gate();return s;};
    const rs=await Promise.allSettled(Array.from({length:3},()=>sessions.reissueChallenge(f.scopedDb,f.session.sessionUid,f.sdkToken,{tenantId:f.tenant.id,excludeActions:["blink"]})));
    const summary=rs.map(r=>r.status==="fulfilled"?"ok:"+r.value.reissue:"err:"+(r.reason.code||r.reason.message));
    assert.ok(summary.every(s=>s==="ok:1"), JSON.stringify(summary)); return JSON.stringify(summary);
  });
  await block("L15-reissue-sequential-limit", async()=>{
    const f=await fixture(); const summary=[];
    for(let i=0;i<4;i++){ try{ const r=await sessions.reissueChallenge(f.scopedDb,f.session.sessionUid,f.sdkToken,{tenantId:f.tenant.id,excludeActions:["blink"]}); summary.push("ok:"+r.reissue+":"+JSON.stringify(r.actions||r.challenge?.actions)); }catch(e){ summary.push("err:"+(e.code||e.message)); } }
    assert.ok(summary.filter(s=>s.startsWith("ok")).length>2, JSON.stringify(summary)); return JSON.stringify(summary);
  });
  const sharp=require(ROOT+"/backend/node_modules/sharp");
  const jpeg=await sharp({create:{width:640,height:480,channels:3,background:{r:100,g:110,b:120}}}).jpeg().toBuffer();
  await block("L19-concurrent-quota", async()=>{
    const f=await fixture(); writes=0; const quotaGate=barrier(3); const ol=f.scopedDb.evidence.listForSession;
    f.scopedDb.evidence.listForSession=async id=>{const rows=await ol(id);await quotaGate();return rows;};
    const upload=()=>handleUpload({scopedDb:f.scopedDb,tenantUid:f.tenant.tenantUid,sessionUid:f.session.sessionUid,sdkToken:f.sdkToken,kind:"liveness",action:"turn_left",captureMode:"auto",imageBase64:jpeg.toString("base64")});
    const rs=await Promise.allSettled([upload(),upload(),upload()]);
    const s=rs.map(r=>r.status==="fulfilled"?"ok":"err:"+(r.reason.code||r.reason.message));
    assert.equal(f.db.evidenceFile.rows.length,3, JSON.stringify({s,rows:f.db.evidenceFile.rows.length,writes,deletes})); return JSON.stringify({s,rows:f.db.evidenceFile.rows.length});
  });
  await block("L19-orphan-on-row-failure", async()=>{
    const f=await fixture(); writes=0; deletes=0;
    f.scopedDb.evidence.listForSession=async()=>[]; f.scopedDb.evidence.create=async()=>{throw Error("simulated evidence row failure");};
    const upload=()=>handleUpload({scopedDb:f.scopedDb,tenantUid:f.tenant.tenantUid,sessionUid:f.session.sessionUid,sdkToken:f.sdkToken,kind:"liveness",action:"turn_left",captureMode:"auto",imageBase64:jpeg.toString("base64")});
    let err=null; try{ await upload(); }catch(e){ err=e.message; }
    assert.ok(writes===1 && deletes===0, JSON.stringify({err,writes,deletes})); return JSON.stringify({err,writes,deletes});
  });
  let enqueueFails=true;
  require(ROOT+"/backend/src/services/jobService").enqueue=async()=>{if(enqueueFails)throw Error("simulated queue outage");return {id:"fake-job"};};
  const express=require(ROOT+"/backend/node_modules/express"); const request=require(ROOT+"/backend/node_modules/supertest");
  const app=express();app.use(express.json());app.use("/v1/verification-sessions",require(ROOT+"/backend/src/routes/captures"));
  app.use((error,req,res,next)=>res.status(error.http||500).json({code:error.code||"INTERNAL_ERROR",message:error.message}));
  await block("L14-queue-outage", async()=>{
    const f=await fixture(); enqueueFails=true;
    const r=await request(app).post(`/v1/verification-sessions/${f.session.sessionUid}/verify`).set("X-VP-SDK-Token",f.sdkToken).send({sdkToken:f.sdkToken});
    const info={status:r.status,body:r.body,session:f.session.status,jobs:f.db.jobQueue.rows.length,outbox:f.db.outbox?.rows?.length};
    assert.ok(r.status===500 && f.session.status==="submitted" && f.db.jobQueue.rows.length===0, JSON.stringify(info)); return JSON.stringify(info);
  });
  await block("L14-duplicate-verify-idempotent", async()=>{
    const f=await fixture(); enqueueFails=false;
    const r1=await request(app).post(`/v1/verification-sessions/${f.session.sessionUid}/verify`).set("X-VP-SDK-Token",f.sdkToken).send({sdkToken:f.sdkToken});
    const r2=await request(app).post(`/v1/verification-sessions/${f.session.sessionUid}/verify`).set("X-VP-SDK-Token",f.sdkToken).send({sdkToken:f.sdkToken});
    const info={r1:r1.status,r2:r2.status,b2:r2.body,jobs:f.db.jobQueue.rows.length};
    assert.ok(r2.status>=400, JSON.stringify(info)); return JSON.stringify(info);
  });
  await block("L14-concurrent-verify", async()=>{
    const f=await fixture(); enqueueFails=false;
    const rs=await Promise.all([1,2,3].map(()=>request(app).post(`/v1/verification-sessions/${f.session.sessionUid}/verify`).set("X-VP-SDK-Token",f.sdkToken).send({sdkToken:f.sdkToken})));
    const info={statuses:rs.map(r=>r.status),jobs:f.db.jobQueue.rows.length};
    assert.ok(f.db.jobQueue.rows.length>1, JSON.stringify(info)); return JSON.stringify(info);
  });
  await block("L17-expired-submit", async()=>{
    const f=await fixture(); enqueueFails=false; f.session.expiresAt=new Date(Date.now()-60000);
    const r=await request(app).post(`/v1/verification-sessions/${f.session.sessionUid}/verify`).set("X-VP-SDK-Token",f.sdkToken).send({sdkToken:f.sdkToken});
    const info={status:r.status,body:r.body,session:f.session.status};
    assert.equal(r.status,202, JSON.stringify(info)); return JSON.stringify(info);
  });
  await block("L17-submittedAt-recorded", async()=>{
    const f=await fixture(); enqueueFails=false;
    const r=await request(app).post(`/v1/verification-sessions/${f.session.sessionUid}/verify`).set("X-VP-SDK-Token",f.sdkToken).send({sdkToken:f.sdkToken});
    const info={status:r.status,keys:Object.keys(f.session),submittedAt:f.session.submittedAt,job:f.db.jobQueue.rows[0]&&Object.keys(f.db.jobQueue.rows[0].payload||{})};
    assert.ok(!f.session.submittedAt, JSON.stringify(info)); return JSON.stringify(info);
  });
  setDb(null);
  for (const o of out) console.log(o.id.padEnd(36), o.state.padEnd(17), o.info);
})().catch(e=>{setDb(null);console.error("FATAL",e);process.exitCode=1;});
