"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { decide, resolveThresholds } = require("../src/decisionEngine");
// STRICT = the liveness auto-approve rule switched off (tenant knobs). The
// contracts below describe how each signal routes when nothing waives it;
// the default rule (score > autoApprove OR challenge passed → waive liveness
// quality codes) is covered by its own tests.
const STRICT_T = resolveThresholds({ thresholds: { liveness: { autoApprove: 1, challengePassApproves: false } } });
const { verifyLivenessChallenge, isChallengeFresh, generateLivenessChallenge, computeFrameBinding, verifyFrameBinding, assessExpression } = require("../src/livenessChallenge");
const challenge = actions => ({ actions, nonce: "test", issuedAt: new Date().toISOString() });
const frame = (action, score, yaw, i) => ({ action, checksum: String(i), createdAt: new Date(Date.now() + i * 200), captureMode: "auto", liveness: { score, faceCount: 1 }, pose: { yaw, pitch: 0 } });
test("non-finite/out-of-range scores never approve", () => {
  for (const score of [NaN, Infinity, -Infinity, null, undefined, -0.1, 1.1]) for (const key of ["liveness", "faceMatch", "livenessIdentity"]) {
    assert.notEqual(decide({ [key]: { score } }).status, "approved", `${key}:${score}`);
  }
  assert.ok(Number.isFinite(resolveThresholds({ thresholds: { liveness: { pass: NaN, reject: Infinity } } }).liveness.pass));
});
test("missing expression evidence requires review and generator excludes unsupported expressions", () => {
  for (const action of ["blink", "open_mouth"]) {
    const r = verifyLivenessChallenge(challenge([action]), [0,1,2].map(i => frame(action, .95, 0, i)), {}, { enforcePose: true });
    assert.equal(r.evidenceInsufficient, true);
    assert.notEqual(decide({ livenessChallenge: r }, STRICT_T).status, "approved");
  }
  for (let i = 0; i < 100; i++) assert.ok(generateLivenessChallenge().actions.every(a => !["blink", "open_mouth", "smile"].includes(a)));
  // Capability-driven: a landmark-capable provider may opt expressions back in
  // and the third slot then draws from tilts AND expressions.
  const seen = new Set();
  for (let i = 0; i < 200; i++) generateLivenessChallenge({ supportsExpressions: true }).actions.forEach(a => seen.add(a));
  assert.ok(seen.has("blink") && seen.has("open_mouth"));
});
test("generator refuses exclusions that leave nothing verifiable instead of issuing an empty challenge", () => {
  assert.throws(() => generateLivenessChallenge({ excludeActions: ["turn_left", "turn_right", "look_up", "look_down"] }), /no verifiable head movements/);
  // A single exclusion (the API maximum) always leaves a full three-step challenge.
  for (const ex of ["turn_left", "turn_right", "look_up", "look_down"]) assert.equal(generateLivenessChallenge({ excludeActions: [ex] }).actions.length, 3);
});
test("one/two repeated still frames require review", () => {
  for (const n of [1,2,3]) {
    const frames = Array.from({length:n}, (_,i) => ({ ...frame("turn_left", .95, 20, i), checksum: "same" }));
    const r = verifyLivenessChallenge(challenge(["turn_left"]), frames, {}, { enforcePose:true });
    assert.equal(r.evidenceInsufficient, true);
    assert.notEqual(decide({livenessChallenge:r}, STRICT_T).status, "approved");
  }
});
test("disjoint passive and pose evidence does not satisfy a movement", () => {
  const frames = [frame("turn_left",.95,0,0),frame("turn_left",.95,0,1),frame("turn_left",.01,25,2)];
  const r = verifyLivenessChallenge(challenge(["turn_left"]), frames, {}, {enforcePose:true});
  assert.equal(r.ok,false);
});
test("future challenge timestamps are rejected", () => {
  assert.equal(isChallengeFresh({issuedAt:new Date(Date.now()+60000).toISOString()}),false);
});
test("blink must reopen; static zero mouth geometry cannot pass", () => {
  const expr = (ear,mar=.1) => ({expr:{ear,mar}});
  assert.equal(assessExpression("blink",[expr(.3),expr(.1),expr(.1)]).ok,false);
  assert.equal(assessExpression("blink",[expr(.3),expr(.1),expr(.3)]).ok,true);
  assert.equal(assessExpression("open_mouth",[expr(.3,0),expr(.3,0),expr(.3,0)]).ok,false);
});
test("enforced flash missing, inconclusive or false never approves", () => {
  for (const ok of [undefined,null,false]) assert.equal(decide({liveness:{score:.95,flash:{enforced:true,ok}}}, STRICT_T).status,"manual_review");
});
test("v2 binding authenticates session, attempt, capture mode and metadata", () => {
  const context = ["tenant","session","attempt","liveness_frame","auto",{sequence:[1,2,3]}];
  const bindingHmac = computeFrameBinding("secret","nonce","turn_left","checksum",context);
  const data = {challengeNonce:"nonce",action:"turn_left",checksum:"checksum",bindingHmac,context};
  assert.equal(verifyFrameBinding("secret",data),true);
  for (let i=0;i<context.length;i++) {const changed=[...context];changed[i]="tampered";assert.equal(verifyFrameBinding("secret",{...data,context:changed}),false);}
});
