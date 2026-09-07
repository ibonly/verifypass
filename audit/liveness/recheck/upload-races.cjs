"use strict";
process.env.NODE_ENV = "test"; process.env.REQUIRE_CONSENT = "false"; process.env.QUEUE_BACKEND = "db"; process.env.MAX_LIVENESS_FRAMES_PER_ACTION = "2";
const ROOT=require("node:path").resolve(__dirname, "../../..");
const { createMockDb } = require(ROOT+"/backend/tests/helpers/mockDb");
const { setDb } = require(ROOT+"/backend/src/lib/db");
const { tenantScope } = require(ROOT+"/backend/src/middleware/tenantScope");
const sessions = require(ROOT+"/backend/src/services/sessionService");
const cloud = require(ROOT+"/backend/src/services/cloudinaryService");
const store = require(ROOT+"/backend/src/services/evidenceStore");
let writes = 0, deletes = 0;
cloud.uploadEvidenceImage = async () => null;
store.saveEvidence = async ({ onPrepared }) => { writes++; const storagePath = `fake-storage-${writes}`; await onPrepared?.(storagePath); return { checksum: `fake-checksum-${writes}`, storagePath, retentionExpiresAt: new Date() }; };
store.deleteEvidence = async () => { deletes++; };
const { handleUpload } = require(ROOT+"/backend/src/services/uploadService");
function barrier(n) { let arrived=0, release; const wait=new Promise(r=>{release=r;}); return async()=>{if(++arrived===n)release();await wait;}; }
async function fixture(status="started") {
  const db=createMockDb(); setDb(db);
  const tenant=await db.tenant.create({data:{tenantUid:"tnt_audit_races",status:"active",settings:{}}});
  const sessionUid="vps_races";const token=sessions.signSdkToken(sessionUid);
  const session=await db.verificationSession.create({data:{sessionUid,tenantId:tenant.id,status,verificationType:"FACE_ONLY",sdkTokenHash:token.tokenHash,expiresAt:new Date(Date.now()+600000),attemptId:"att-1",livenessChallenge:{nonce:"nonce",issuedAt:new Date().toISOString(),actions:["turn_left","turn_right","blink"]}}});
  const req={tenant};tenantScope(req,{},()=>{});
  return {db,tenant,session,scopedDb:req.scopedDb,sdkToken:token.token};
}
(async()=>{
  const sharp=require(ROOT+"/backend/node_modules/sharp");
  const jpeg=await sharp({create:{width:640,height:480,channels:3,background:{r:100,g:110,b:120}}}).jpeg().toBuffer();
  const mk=(f,action="turn_left")=>()=>handleUpload({scopedDb:f.scopedDb,tenantUid:f.tenant.tenantUid,sessionUid:f.session.sessionUid,sdkToken:f.sdkToken,attemptId:"att-1",kind:"liveness",action,captureMode:"auto",imageBase64:jpeg.toString("base64")});
  // concurrent quota
  let f=await fixture(); writes=0; deletes=0;
  const gate=barrier(3); const ol=f.scopedDb.evidence.listForSession; let gated=0;
  f.scopedDb.evidence.listForSession=async id=>{const rows=await ol(id); if(gated<3){gated++; await gate();} return rows;};
  const rs=await Promise.allSettled([mk(f)(),mk(f)(),mk(f)()]);
  console.log("L19-concurrent-quota:", JSON.stringify({outcomes:rs.map(r=>r.status==="fulfilled"?"ok":"err:"+(r.reason.code||r.reason.message)), rows:f.db.evidenceFile.rows.length, writes, deletes, staging:f.db.evidenceStaging.rows.length}));
  // orphan on row failure
  f=await fixture(); writes=0; deletes=0;
  f.db.evidenceFile.create=async()=>{throw Error("simulated evidence row failure");};
  let err=null; try{ await mk(f)(); }catch(e){ err=e.message; }
  console.log("L19-orphan-row-failure:", JSON.stringify({err, writes, deletes, staging:f.db.evidenceStaging.rows.length, outbox:f.db.outbox.rows.map(r=>r.type)}));
  // orphan when delete also fails -> outbox cleanup
  f=await fixture(); writes=0; deletes=0;
  store.deleteEvidence=async()=>{throw Error("disk gone");};
  f.db.evidenceFile.create=async()=>{throw Error("simulated evidence row failure");};
  err=null; try{ await mk(f)(); }catch(e){ err=e.message; }
  console.log("L19-orphan-delete-fails:", JSON.stringify({err, writes, outbox:f.db.outbox.rows.map(r=>({type:r.type,payload:r.payload}))}));
  store.deleteEvidence=async()=>{deletes++;};
  // upload after submit (status changes between read and commit)
  f=await fixture(); writes=0; deletes=0;
  const ol2=f.scopedDb.evidence.listForSession; let first=true;
  f.scopedDb.evidence.listForSession=async id=>{const rows=await ol2(id); if(first){first=false; f.session.status="submitted";} return rows;};
  err=null; try{ await mk(f)(); }catch(e){ err=e.code||e.message; }
  console.log("L19-late-upload-after-submit:", JSON.stringify({err, rows:f.db.evidenceFile.rows.length, writes, deletes}));
  // normal upload to confirm harness
  f=await fixture(); writes=0; deletes=0;
  const ok=await mk(f)(); console.log("sanity-upload:", JSON.stringify({success:ok.success, rows:f.db.evidenceFile.rows.length, staging:f.db.evidenceStaging.rows.length, row:{...f.db.evidenceFile.rows[0], bindingHmac:'…'}}));
  setDb(null);
})().catch(e=>{setDb(null);console.error("FATAL",e);process.exitCode=1;});
