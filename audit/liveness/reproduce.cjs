"use strict";
// Diagnostic reproductions of CURRENT defects. Assertions intentionally prove
// undesirable behavior, not the desired specification. No network/real DB.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const shared = require("../../backend/shared/src");
const { runVerification } = require("../../backend/src/worker/pipeline");
const { createMockDb } = require("../../backend/tests/helpers/mockDb");
const { VerifyPassClient } = require("../../frontend/sdk/core/src/client");
const findings = [];
function proof(id, evidence) { findings.push({ id, evidence }); }
const now = Date.now();
const ch = actions => ({ actions, nonce: "audit-nonce", issuedAt: new Date(now).toISOString() });
const frame = (action, i, extra = {}) => ({ action, checksum: `checksum-${i}`, liveness: { score: .95, faceCount: 1 }, pose: { yaw: 20, pitch: 15 }, createdAt: new Date(now + i * 100), ...extra });
const verify = (actions, frames) => shared.verifyLivenessChallenge(ch(actions), frames, shared.DEFAULT_THRESHOLDS, { enforcePose: true, now: () => now });
(async () => {
  let r = verify(["blink"], [frame("blink", 0)]);
  assert.equal(r.ok, true); assert.equal(r.perAction.blink.expression, undefined);
  proof("L01", "Blink with one frame and no expression data returns ok:true under enforcePose:true.");
  r = verify(["turn_left", "turn_right"], [frame("turn_left", 0), frame("turn_right", 1)]);
  assert.equal(r.ok, true); assert.equal(r.consistency.ok, false); assert.equal(r.motionUnverified, false);
  proof("L02/L03", "Same-sign turns, one frame per action: ok:true; consistency false and missing trajectory are not blocking by default.");
  r = verify(["turn_left"], [frame("turn_left", 0, { liveness: { score: .95, faceCount: 1 }, pose: { yaw: 0 } }), frame("turn_left", 1, { liveness: { score: 0, faceCount: 1 }, pose: { yaw: 25 } })]);
  assert.equal(r.ok, true);
  proof("L04", "High liveness on frontal frame plus zero-liveness turned frame satisfies action; no one frame satisfies both.");
  assert.equal(shared.decide({ selfie: { faceCount: 1 }, liveness: { score: NaN } }).status, "approved");
  assert.equal(shared.decide({ selfie: { faceCount: 1 }, liveness: { score: .95 }, livenessIdentity: { score: null, error: "provider unavailable" } }).status, "approved");
  proof("L05/L06", "NaN passive score and missing identity score each permit approved decisions at the decision boundary.");
  const excluded = shared.generateLivenessChallenge({ excludeActions: ["turn_left", "turn_right", "look_up", "look_down"], randomInt: () => 0 });
  assert.deepEqual(new Set(excluded.actions), new Set(["blink", "open_mouth"]));
  proof("L07", "Excluding four head movements leaves only two expression actions.");
  assert.equal(shared.isChallengeFresh({ issuedAt: new Date(now + 86400000).toISOString() }, { now: () => now }), true);
  proof("L08", "Challenge issued one day in the future is treated as fresh.");
  const seq = shared.FLASH.palette.slice(0,4);
  const fake = shared.scoreFlashResponse([[20,20,20], ...seq.map(c => c.map(v => 20 + v * .2))], seq);
  assert.equal(fake.ok, true);
  proof("L09", "Synthetic uniform-color tile means score as valid flash response without any face evidence (scorer-level proof).");
  let body;
  const client = new VerifyPassClient({ baseUrl: "https://example.invalid", sessionId: "vps_audit", sdkToken: "sdk_audit", fetchImpl: async (_, opts) => { body = JSON.parse(opts.body); return { ok: true, json: async () => ({ success: true }) }; } });
  await client.uploadLivenessFrame("blink", "dummy");
  assert.equal(body.captureMode, "auto");
  proof("L10", "Two-argument uploadLivenessFrame used by vanilla button labels manual capture as auto.");

  async function pipelineScenario({ selfieScore=.95, enforceFlash=false, identityError=false, resultError=false } = {}) {
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
        await db.evidenceFile.create({data:{sessionId:session.id,...rows[i],storagePath,checksum,createdAt:new Date(now+i*100),challengeNonce:'audit-nonce',bindingHmac:shared.computeFrameBinding(require('../../backend/src/config').sdkTokenSecret,'audit-nonce',rows[i].label,checksum)}});
      }
      const provider={name:"stub", checkLiveness:async buf=>({score:buf.toString()==='audit-frame-0'?selfieScore:.95,faceCount:1,pose:{yaw:20,pitch:0},raw:{}}), compareFaces:async()=>{if(identityError)throw Error('simulated identity outage');return {score:.99,idFaceFound:true};}};
      if(resultError)db.verificationResult.create=async()=>{throw Error('simulated result write failure');};
      const deps={db,provider,evidenceKey:key,env:"production",screen:async()=>({hit:false})};
      if(resultError){
        await assert.rejects(runVerification({sessionUid:session.sessionUid},deps),/simulated result/);
        assert.equal(session.status,'approved'); assert.equal(db.verificationResult.rows.length,0);
        const retry=await runVerification({sessionUid:session.sessionUid},deps);assert.equal(retry.skipped,true);
        return {status:session.status,missingResult:true,retrySkipped:true};
      }
      const out=await runVerification({sessionUid:session.sessionUid},deps);
      return {status:out.status,result:db.verificationResult.rows[0]};
    } finally {await fs.rm(dir,{recursive:true,force:true});}
  }
  let p=await pipelineScenario({selfieScore:.01});
  assert.equal(p.status,'approved'); assert.equal(p.result.livenessScore,.01);
  proof('L11', 'Production-mode pipeline approves selfie score 0.01 with three challenge scores 0.95; persisted score remains 0.01. Stub provider, real encrypted evidence.');
  p=await pipelineScenario({enforceFlash:true});assert.equal(p.status,'approved');
  proof('L12','Production-mode pipeline approves with enforceFlash:true and no flash evidence.');
  p=await pipelineScenario({identityError:true});assert.equal(p.status,'approved');
  proof('L06','Production-mode pipeline approves when identity comparison throws.');
  await pipelineScenario({resultError:true});
  proof('L13','Result persistence failure leaves approved session without result; job retry skips it.');
  console.log(JSON.stringify({date:new Date().toISOString(),proofs:findings.length,findings},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
