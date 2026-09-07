"use strict";
// Evaluate independently labeled, held-out outcomes; never derives labels
// from the system decision. Input contains metadata/outcomes, not face images.
function wilson(errors, n) {
  if (!n) return null;
  const z=1.959963984540054, p=errors/n, d=1+z*z/n;
  const centre=(p+z*z/(2*n))/d;
  const radius=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;
  return [Math.max(0,centre-radius),Math.min(1,centre+radius)];
}
function evaluate(dataset) {
  if (dataset.heldOut !== true || dataset.independentLabels !== true || !Array.isArray(dataset.samples)) throw new Error("Independent labels and a held-out dataset are required");
  const groups=new Map();
  const seen=new Set();
  for (const r of dataset.samples) {
    if (!r.id || seen.has(r.id)) throw new Error("Samples need unique IDs"); seen.add(r.id);
    if (!["genuine","attack"].includes(r.label) || !["approved","rejected","manual_review","failed"].includes(r.outcome)) throw new Error("Invalid ground-truth label or outcome");
    if (![r.provider,r.modelVersion,r.policyVersion,r.deviceGroup,r.attackType || "genuine"].every(v=>typeof v==="string" && v.length)) throw new Error("Provider/model/policy/device metadata are required");
    const key=JSON.stringify([r.provider,r.modelVersion,r.policyVersion,r.deviceGroup]);
    if (!groups.has(key)) groups.set(key,{genuine:0,attack:0,falseAccept:0,falseReject:0,review:0,failed:0,attacks:{}});
    const g=groups.get(key);g[r.label]++;
    if (r.label==="attack") {const k=r.attackType || "unspecified";g.attacks[k]=(g.attacks[k]||0)+1;if(r.outcome==="approved")g.falseAccept++;}
    if (r.label==="genuine" && r.outcome==="rejected")g.falseReject++;
    if(r.outcome==="manual_review")g.review++;
    if(r.outcome==="failed")g.failed++;
  }
  return { certification:false, note:"Confidence intervals assume independent observations. Repeated subjects/recordings require clustered analysis. Review and acquisition failures are reported separately.", groups:[...groups].map(([key,g])=>({population:JSON.parse(key),...g,falseAcceptanceRate:g.attack?g.falseAccept/g.attack:null,falseRejectionRate:g.genuine?g.falseReject/g.genuine:null,falseAcceptance95: wilson(g.falseAccept,g.attack),falseRejection95:wilson(g.falseReject,g.genuine)})) };
}
if(require.main===module) {
  try { const file=process.argv[2];if(!file)throw new Error("Usage: node scripts/evaluate-liveness-dataset.js independently-labeled.json");console.log(JSON.stringify(evaluate(JSON.parse(require("fs").readFileSync(file,"utf8"))),null,2)); }
  catch(e){console.error(e.message);process.exitCode=1;}
}
module.exports={evaluate,wilson};
