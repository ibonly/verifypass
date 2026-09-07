"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {evaluate,wilson}=require("../scripts/evaluate-liveness-dataset");
test("evaluation rejects circular labels and reports nonzero uncertainty for zero observed errors",()=>{
  assert.throws(()=>evaluate({samples:[]}),/Independent labels/);
  const ci=wilson(0,10);assert.ok(ci[1]>.2);
  const samples=[{id:"a",provider:"p",modelVersion:"m",policyVersion:"v",deviceGroup:"d",label:"attack",attackType:"print",outcome:"approved"},{id:"b",provider:"p",modelVersion:"m",policyVersion:"v",deviceGroup:"d",label:"genuine",outcome:"manual_review"}];
  const r=evaluate({heldOut:true,independentLabels:true,samples});
  assert.equal(r.groups[0].falseAcceptanceRate,1);assert.equal(r.groups[0].review,1);assert.equal(r.certification,false);
});
