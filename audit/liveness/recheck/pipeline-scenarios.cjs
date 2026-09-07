"use strict";
const crypto = require("crypto"); const fs = require("fs/promises"); const os = require("os"); const path = require("path");
const ROOT = require("node:path").resolve(__dirname, "../../..");
const { encryptBuffer, computeFrameBinding } = require(ROOT+"/backend/shared/src");
const { createMockDb } = require(ROOT+"/backend/tests/helpers/mockDb");
const { runVerification } = require(ROOT+"/backend/src/worker/pipeline");
const config = require(ROOT+"/backend/src/config");
const KEY = crypto.randomBytes(32);
function provider() {
  return { name: "stub",
    checkLiveness: async buf => { let d={}; try { d=JSON.parse(buf.toString()); } catch(_){} return { pose: d.pose||null, score: d.score ?? 0.95, faceCount: 1, occluded:false, raw:{} }; },
    faceLandmarks: async buf => { let d={}; try { d=JSON.parse(buf.toString()); } catch(_){} return d.expr ? { points:null, expr:d.expr } : null; },
    compareFaces: async () => ({ score: 0.9, idFaceFound: true, raw: {} }),
    extractDocument: async () => ({ available:true, ocrConfidence:0.9, extractedData:{}, expired:false, raw:{} }) };
}
async function scenario(name, { actions, frames, settings={}, env, issuedAgoMs=60000, submittedAt=null, validatedPolicy=false, attemptId="att-1", selfieScore=0.95 }) {
  const db = createMockDb(); const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vp-scen-"));
  const tenant = await db.tenant.create({ data: { tenantUid: "tnt", status: "active", settings } });
  const issuedAt = new Date(Date.now() - issuedAgoMs);
  const session = await db.verificationSession.create({ data: { sessionUid: "vps_s", tenantId: tenant.id, status: "submitted", verificationType: "FACE_ONLY", isLive:false, attemptId, submittedAt, livenessChallenge: { actions, nonce: "n1", issuedAt: issuedAt.toISOString(), flashSequence: [[255,0,0],[0,255,0],[0,0,255],[255,255,255]] } } });
  let n=0;
  async function add(fileType, label, plainObj, createdAt, captureMode="auto") {
    const plain = Buffer.from(JSON.stringify({ ...plainObj, n: ++n }));
    const checksum = crypto.createHash("sha256").update(plain).digest("hex");
    const p = path.join(dir, `${n}.enc`); await fs.writeFile(p, encryptBuffer(plain, KEY));
    const mode = fileType==="liveness_frame" ? captureMode : null;
    const bindingHmac = computeFrameBinding(config.sdkTokenSecret, "n1", label || fileType, checksum, attemptId ? [session.tenantId, session.id, attemptId, fileType, mode, null] : undefined);
    await db.evidenceFile.create({ data: { sessionId: session.id, fileType, label, attemptId, challengeNonce: "n1", bindingHmac, captureMode: mode, storagePath: p, checksum, encrypted:true, createdAt } });
  }
  await add("selfie", null, { score: selfieScore }, new Date(issuedAt.getTime()+1000));
  for (const f of frames) await add("liveness_frame", f.action, f.plain, new Date(issuedAt.getTime()+f.atMs), f.mode);
  const prev = process.env.LIVENESS_VALIDATED_POLICY;
  if (validatedPolicy) process.env.LIVENESS_VALIDATED_POLICY = require(ROOT+"/backend/src/lib/release").policyVersion; else delete process.env.LIVENESS_VALIDATED_POLICY;
  let out, err=null; try { out = await runVerification({ sessionUid: "vps_s", attemptId }, { db, provider: provider(), evidenceKey: KEY, env, screen: async()=>({hit:false}) }); } catch(e){ err=e.message; }
  if (prev===undefined) delete process.env.LIVENESS_VALIDATED_POLICY; else process.env.LIVENESS_VALIDATED_POLICY=prev;
  const r = db.verificationResult.rows[0];
  console.log(name.padEnd(44), JSON.stringify(out||err), r ? JSON.stringify({ livenessScore:r.livenessScore, livenessStatus:r.livenessStatus, flash:r.rawResult.liveness?.flash, evidenceInsufficient:r.rawResult.livenessChallenge?.evidenceInsufficient, policyUnverified:r.rawResult.livenessChallenge?.policyUnverified, seq:r.rawResult.livenessChallenge?.sequence && {ok:r.rawResult.livenessChallenge.sequence.ok, issueOk:r.rawResult.livenessChallenge.sequence.issueOk, issueToFirstMs:r.rawResult.livenessChallenge.sequence.issueToFirstMs}, perAction: Object.fromEntries(Object.entries(r.rawResult.livenessChallenge?.perAction||{}).map(([k,v])=>[k,{poseOk:v.poseOk,traj:v.trajectoryOk,expr:v.expression?.ok}])) }) : "");
  await fs.rm(dir,{recursive:true,force:true});
}
const turns = (startMs) => { const fr=[]; let t=startMs; for (const a of ["turn_left","turn_right"]) { for (const yaw of [0,10,20]) { fr.push({ action:a, atMs:t, plain:{ pose:{ yaw: a==="turn_left"?-yaw:yaw, pitch:0 } } }); t+=400; } t+=1500; } return fr; };
const blink = (startMs, withExpr) => [0.30,0.12,0.29].map((ear,i)=>({ action:"blink", atMs:startMs+i*400, plain:{ pose:{yaw:0,pitch:0}, ...(withExpr?{expr:{ear,mar:0.05}}:{}) } }));
(async()=>{
  await scenario("good: 2 turns, 3 frames each (dev env)", { actions:["turn_left","turn_right"], frames: turns(5000), env:"test" });
  await scenario("good in production, policy NOT validated", { actions:["turn_left","turn_right"], frames: turns(5000), env:"production" });
  await scenario("good in production, policy validated", { actions:["turn_left","turn_right"], frames: turns(5000), env:"production", validatedPolicy:true });
  await scenario("L12: enforceFlash, no mosaic", { actions:["turn_left","turn_right"], frames: turns(5000), env:"test", settings:{ challenge:{ enforceFlash:true } } });
  await scenario("L01: legacy blink, 3 frames, no landmarks", { actions:["turn_left","turn_right","blink"], frames: [...turns(5000), ...blink(10000,false)], env:"test" });
  await scenario("L01: blink with EAR closure+reopen", { actions:["turn_left","turn_right","blink"], frames: [...turns(5000), ...blink(10000,true)], env:"test" });
  await scenario("L03: one frame per action", { actions:["turn_left","turn_right"], frames: [ {action:"turn_left",atMs:5000,plain:{pose:{yaw:-20,pitch:0}}}, {action:"turn_right",atMs:7000,plain:{pose:{yaw:20,pitch:0}}} ], env:"test" });
  await scenario("L17: first frame 4 min after issue (doc step slow)", { actions:["turn_left","turn_right"], frames: turns(240000), env:"test", issuedAgoMs: 260000 });
  await scenario("L17: challenge 9.5 min old, submitted then queued 20 min", { actions:["turn_left","turn_right"], frames: turns(5000), env:"test", issuedAgoMs: 30*60000, submittedAt: new Date(Date.now()-20.5*60000) });
  await scenario("L17: challenge 11 min old at submit", { actions:["turn_left","turn_right"], frames: turns(5000), env:"test", issuedAgoMs: 11*60000, submittedAt: new Date() });
  await scenario("L10: manual capture mode frames", { actions:["turn_left","turn_right"], frames: turns(5000).map(f=>({...f,mode:"manual"})), env:"test" });
  await scenario("L11: selfie 0.5 (borderline) good frames", { actions:["turn_left","turn_right"], frames: turns(5000), env:"test", selfieScore:0.5 });
  await scenario("legacy session without attemptId", { actions:["turn_left","turn_right"], frames: turns(5000), env:"test", attemptId:null });
})().catch(e=>{console.error("FATAL",e);process.exitCode=1;});
