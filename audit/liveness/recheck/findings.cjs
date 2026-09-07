"use strict";
// Per-finding recheck: each block asserts the ORIGINAL undesirable behavior.
// "STILL_REPRODUCES" = gap remains; "FIXED" = behavior changed (assertion failed).
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const ROOT = require("node:path").resolve(__dirname, "../../..");
const shared = require(ROOT + "/backend/shared/src");
const { runVerification } = require(ROOT + "/backend/src/worker/pipeline");
const { createMockDb } = require(ROOT + "/backend/tests/helpers/mockDb");
const { VerifyPassClient } = require(ROOT + "/frontend/sdk/core/src/client");
const now = Date.now();
const ch = actions => ({ actions, nonce: "audit-nonce", issuedAt: new Date(now).toISOString() });
const frame = (action, i, extra = {}) => ({ action, checksum: `checksum-${i}`, liveness: { score: .95, faceCount: 1 }, pose: { yaw: 20, pitch: 15 }, createdAt: new Date(now + i * 100), ...extra });
const verify = (actions, frames) => shared.verifyLivenessChallenge(ch(actions), frames, shared.DEFAULT_THRESHOLDS, { enforcePose: true, now: () => now });
const out = [];
async function block(id, fn) {
  try { const info = await fn(); out.push({ id, state: "STILL_REPRODUCES", info }); }
  catch (e) { out.push({ id, state: e.code === "ERR_ASSERTION" ? "FIXED" : "ERROR", info: (e.message||String(e)).slice(0,900) }); }
}
(async () => {
  await block("L01", () => { const r = verify(["blink"], [frame("blink", 0)]); assert.equal(r.ok, true, JSON.stringify({ok:r.ok,reasons:r.reasonCodes||r.reasons,perAction:r.perAction,consistency:r.consistency,motionUnverified:r.motionUnverified})); return JSON.stringify({ok:r.ok, reasons:r.reasonCodes||r.reasons, perAction:r.perAction?.blink}); });
  await block("L02/L03", () => { const r = verify(["turn_left", "turn_right"], [frame("turn_left", 0), frame("turn_right", 1)]); assert.equal(r.ok, true, JSON.stringify({ok:r.ok,reasons:r.reasonCodes||r.reasons,perAction:r.perAction,consistency:r.consistency,motionUnverified:r.motionUnverified})); return JSON.stringify({ok:r.ok,consistency:r.consistency,motionUnverified:r.motionUnverified}); });
  await block("L04", () => { const r = verify(["turn_left"], [frame("turn_left", 0, { liveness: { score: .95, faceCount: 1 }, pose: { yaw: 0 } }), frame("turn_left", 1, { liveness: { score: 0, faceCount: 1 }, pose: { yaw: 25 } })]); assert.equal(r.ok, true, JSON.stringify({ok:r.ok,reasons:r.reasonCodes||r.reasons,perAction:r.perAction,consistency:r.consistency,motionUnverified:r.motionUnverified})); return JSON.stringify(r.perAction); });
  await block("L05", () => { const d = shared.decide({ selfie: { faceCount: 1 }, liveness: { score: NaN } }); assert.equal(d.status,"approved",JSON.stringify(d)); return JSON.stringify(d); });
  await block("L06-decision", () => { const d = shared.decide({ selfie: { faceCount: 1 }, liveness: { score: .95 }, livenessIdentity: { score: null, error: "provider unavailable" } }); assert.equal(d.status,"approved",JSON.stringify(d)); return JSON.stringify(d); });
  await block("L07", () => { const e = shared.generateLivenessChallenge({ excludeActions: ["turn_left", "turn_right", "look_up", "look_down"], randomInt: () => 0 }); assert.deepEqual(new Set(e.actions), new Set(["blink","open_mouth"]), JSON.stringify(e)); return JSON.stringify(e.actions); });
  await block("L08", () => { const f = shared.isChallengeFresh({ issuedAt: new Date(now + 86400000).toISOString() }, { now: () => now }); assert.equal(f,true,String(f)); return String(f); });
  await block("L09", () => { const seq = shared.FLASH.palette.slice(0,4); const fake = shared.scoreFlashResponse([[20,20,20], ...seq.map(c => c.map(v => 20 + v * .2))], seq); assert.equal(fake.ok, true); return JSON.stringify(fake); });
  await block("L10", async () => { let body; const client = new VerifyPassClient({ baseUrl: "https://example.invalid", sessionId: "vps_audit", sdkToken: "sdk_audit", fetchImpl: async (_, opts) => { body = JSON.parse(opts.body); return { ok: true, json: async () => ({ success: true }) }; } }); await client.uploadLivenessFrame("blink", "dummy"); assert.equal(body.captureMode,"auto",JSON.stringify(body)); return JSON.stringify(body); });

  async function pipelineScenario({ selfieScore=.95, enforceFlash=false, identityError=false, resultError=false, attemptRace=false } = {}) {
    const db = createMockDb();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vp-liveness-audit-"));
    const key = crypto.randomBytes(32);
    try {
      const tenant = await db.tenant.create({ data: { tenantUid: "tnt_audit", status: "active", settings: { challenge: { enforceFlash } } } });
      const session = await db.verificationSession.create({ data: { tenantId: tenant.id, sessionUid: "vps_audit", status: "submitted", verificationType: "FACE_ONLY", isLive: false, livenessChallenge: ch(["turn_left", "turn_right", "blink"]) } });
      const rows = [{fileType:"selfie", label:null}, ...["turn_left", "turn_right", "blink"].map(label => ({fileType:"liveness_frame",label}))];
      for (let i=0;i<rows.length;i++) {
        const storagePath = path.join(dir,`${i}.enc`);
        const buf=Buffer.from(`audit-frame-${i}`);
        await fs.writeFile(storagePath, shared.encryptBuffer(buf,key));
        const checksum=crypto.createHash('sha256').update(buf).digest('hex');
        await db.evidenceFile.create({data:{sessionId:session.id,...rows[i],storagePath,checksum,createdAt:new Date(now+i*100),challengeNonce:'audit-nonce',bindingHmac:shared.computeFrameBinding(require(ROOT+'/backend/src/config').sdkTokenSecret,'audit-nonce',rows[i].label,checksum)}});
      }
      if (attemptRace) { const read = db.verificationSession.findFirst.bind(db.verificationSession); db.verificationSession.findFirst = async args => { const row=await read(args); return row ? {...row} : null; }; }
      let movedAttempt=false;
      const provider={name:"stub", checkLiveness:async buf=>{ if(attemptRace && !movedAttempt){ movedAttempt=true; session.status="rejected"; session.livenessChallenge={...ch(["look_down"]),nonce:"attempt-B"}; session.status="submitted"; } return {score:buf.toString()==='audit-frame-0'?selfieScore:.95,faceCount:1,pose:{yaw:20,pitch:0},raw:{}}; }, compareFaces:async()=>{if(identityError)throw Error('simulated identity outage');return {score:.99,idFaceFound:true};}};
      if(resultError)db.verificationResult.create=async()=>{throw Error('simulated result write failure');};
      const deps={db,provider,evidenceKey:key,env:"production",screen:async()=>({hit:false})};
      if(resultError){
        let threw=null; try { await runVerification({sessionUid:session.sessionUid},deps); } catch(e){ threw=e.message; }
        const retry=await runVerification({sessionUid:session.sessionUid},deps).catch(e=>({error:e.message}));
        return {threw,status:session.status,results:db.verificationResult.rows.length,retry};
      }
      let error=null; let o=null;
      try { o=await runVerification({sessionUid:session.sessionUid},deps); } catch(e){ error=e.message; }
      return {status:o?.status,error,skipped:o?.skipped,reasons:db.verificationResult.rows[0]?.reasonCodes,result:db.verificationResult.rows[0]&&{livenessScore:db.verificationResult.rows[0].livenessScore,livenessStatus:db.verificationResult.rows[0].livenessStatus,decisionScore:db.verificationResult.rows[0].decisionScore||db.verificationResult.rows[0].details?.decisionScore},attempt:session.livenessChallenge.nonce,sessionStatus:session.status};
    } finally {await fs.rm(dir,{recursive:true,force:true});}
  }
  await block("baseline-good", async()=>{ const p=await pipelineScenario({}); assert.equal(p.status,"approved",JSON.stringify(p)); return JSON.stringify(p); });
  await block("L11", async()=>{ const p=await pipelineScenario({selfieScore:.01}); assert.equal(p.status,"approved",JSON.stringify(p)); return JSON.stringify(p); });
  await block("L12", async()=>{ const p=await pipelineScenario({enforceFlash:true}); assert.equal(p.status,"approved",JSON.stringify(p)); return JSON.stringify(p); });
  await block("L06-pipeline", async()=>{ const p=await pipelineScenario({identityError:true}); assert.equal(p.status,"approved",JSON.stringify(p)); return JSON.stringify(p); });
  await block("L13", async()=>{ const p=await pipelineScenario({resultError:true}); assert.equal(p.status,"approved",JSON.stringify(p)); assert.equal(p.results,0); return JSON.stringify(p); });
  await block("L16", async()=>{ const p=await pipelineScenario({attemptRace:true}); assert.equal(p.status,"approved",JSON.stringify(p)); assert.equal(p.attempt,'attempt-B'); return JSON.stringify(p); });
  for (const o of out) console.log(o.id.padEnd(14), o.state.padEnd(17), o.info);
})().catch(e=>{console.error("FATAL",e);process.exitCode=1;});
