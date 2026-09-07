"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { decide, resolveThresholds, LIVENESS_WAIVABLE } = require("../src/decisionEngine");
const { DEFAULT_THRESHOLDS } = require("../src/reasonCodes");

// STRICT = the liveness auto-approve rule switched off (tenant knobs). The
// contracts below describe how each signal routes when nothing waives it;
// the default rule (score > autoApprove OR challenge passed → waive liveness
// quality codes) is covered by its own tests.
const STRICT = { thresholds: { liveness: { autoApprove: 1, challengePassApproves: false } } };
const STRICT_T = resolveThresholds(STRICT);

const ok = {
  selfie: { faceCount: 1 },
  liveness: { score: 0.95 },
  idFace: { found: true },
  faceMatch: { score: 0.9 },
  document: { ocrConfidence: 0.94, expired: false }
};

// Golden table: PRD §13.2 decision matrix + §14 bands. Each row is a contract.
const GOLDEN = [
  // [name, signal overrides, expected status, expected codes (subset)]
  ["all good → approved", {}, "approved", []],
  ["liveness failed → rejected", { liveness: { score: 0.5 } }, "rejected", ["LIVENESS_FAILED"]],
  ["liveness at reject boundary (0.70) → review band", { liveness: { score: 0.70 } }, "manual_review", ["LIVENESS_BORDERLINE"]],
  ["liveness borderline (0.80) → manual_review", { liveness: { score: 0.80 } }, "manual_review", ["LIVENESS_BORDERLINE"]],
  ["liveness at pass boundary (0.85) → approved", { liveness: { score: 0.85 } }, "approved", []],
  ["liveness score missing → rejected (fail closed)", { liveness: {} }, "rejected", ["LIVENESS_FAILED"]],
  ["face mismatch high confidence → rejected", { faceMatch: { score: 0.4 } }, "rejected", ["FACE_MATCH_FAILED"]],
  ["face score borderline (0.7) → manual_review", { faceMatch: { score: 0.7 } }, "manual_review", ["FACE_MATCH_BORDERLINE"]],
  ["face score at pass (0.82) → approved", { faceMatch: { score: 0.82 } }, "approved", []],
  ["no face on selfie → rejected", { selfie: { faceCount: 0 } }, "rejected", ["NO_FACE_ON_SELFIE"]],
  ["multiple faces → manual_review (detector false positives must not hard-reject)", { selfie: { faceCount: 3 } }, "manual_review", ["MULTIPLE_FACES_DETECTED"]],
  ["no face on ID → manual_review", { idFace: { found: false } }, "manual_review", ["NO_FACE_ON_DOCUMENT"]],
  ["OCR failed, faces fine → manual_review", { document: { ocrConfidence: null, expired: false } }, "manual_review", ["DOCUMENT_OCR_FAILED"]],
  ["document expired → manual_review", { document: { ocrConfidence: 0.9, expired: true } }, "manual_review", ["DOCUMENT_EXPIRED"]],
  ["selfie submitted as 'ID front' (passes passive liveness) → manual_review", { document: { ocrConfidence: 0.9, expired: false, liveFaceAsDocument: true } }, "manual_review", ["DOCUMENT_IS_LIVE_FACE"]],
  ["extraction-only OCR (validated:false) PASSES — verification is a later phase", { document: { ocrConfidence: 0.8, expired: false, validated: false } }, "approved", []],
  ["validated OCR service (no validated flag) unchanged → approved", { document: { ocrConfidence: 0.9, expired: false } }, "approved", []],
  ["reject beats review: liveness fail + expired doc → rejected", { liveness: { score: 0.3 }, document: { ocrConfidence: 0.9, expired: true } }, "rejected", ["LIVENESS_FAILED", "DOCUMENT_EXPIRED"]],
  ["multiple review reasons accumulate", { liveness: { score: 0.8 }, faceMatch: { score: 0.7 } }, "manual_review", ["LIVENESS_BORDERLINE", "FACE_MATCH_BORDERLINE"]],
  ["FACE_ONLY: no document sections at all → approved", { idFace: undefined, faceMatch: undefined, document: undefined }, "approved", []]
];

for (const [name, overrides, expectedStatus, expectedCodes] of GOLDEN) {
  test(`golden: ${name}`, () => {
    const signals = { ...ok, ...overrides };
    // allow explicit undefined to delete a section
    for (const k of Object.keys(signals)) if (signals[k] === undefined) delete signals[k];
    const d = decide(signals, STRICT_T);
    assert.equal(d.status, expectedStatus, `status; got codes ${d.reasonCodes}`);
    for (const code of expectedCodes) {
      assert.ok(d.reasonCodes.includes(code), `expected ${code} in ${d.reasonCodes}`);
    }
  });
}

test("risk levels: rejected=high, review=medium, approved=low", () => {
  assert.equal(decide({ ...ok, liveness: { score: 0.1 } }).riskLevel, "high");
  assert.equal(decide({ ...ok, faceMatch: { score: 0.7 } }).riskLevel, "medium");
  assert.equal(decide(ok).riskLevel, "low");
});

test("livenessChallenge failure is a hard reject (spoof/replay)", () => {
  const d = decide({ ...ok, livenessChallenge: { ok: false, reasonCodes: ["LIVENESS_CHALLENGE_FAILED"] } }, STRICT_T);
  assert.equal(d.status, "rejected");
  assert.equal(d.riskLevel, "high");
  assert.ok(d.reasonCodes.includes("LIVENESS_CHALLENGE_FAILED"));
});

test("livenessChallenge incomplete → rejected (fail closed)", () => {
  const d = decide({ ...ok, livenessChallenge: { ok: false, reasonCodes: ["LIVENESS_CHALLENGE_INCOMPLETE"] } }, STRICT_T);
  assert.equal(d.status, "rejected");
  assert.ok(d.reasonCodes.includes("LIVENESS_CHALLENGE_INCOMPLETE"));
});

test("livenessChallenge ok=true does not affect an otherwise-approved case", () => {
  const d = decide({ ...ok, livenessChallenge: { ok: true, reasonCodes: [] } });
  assert.equal(d.status, "approved");
  assert.deepEqual(d.reasonCodes, []);
});

test("no-face-on-ID suppresses face match scoring", () => {
  // If the ID face wasn't found, a null match score must not add a second reason
  const d = decide({ ...ok, idFace: { found: false }, faceMatch: { score: null } });
  assert.equal(d.status, "manual_review");
  assert.deepEqual(d.reasonCodes, ["NO_FACE_ON_DOCUMENT"]);
});

test("resolveThresholds merges tenant settings within bounds", () => {
  const t = resolveThresholds({ thresholds: { liveness: { pass: 0.9 }, faceMatch: { reject: 0.3 } } });
  assert.equal(t.liveness.pass, 0.9);
  assert.equal(t.liveness.reject, DEFAULT_THRESHOLDS.liveness.reject);
  assert.equal(t.faceMatch.reject, 0.5); // clamped up to platform bound
});

test("tenant thresholds change outcomes", () => {
  const strict = resolveThresholds({ thresholds: { faceMatch: { pass: 0.95 } } });
  const d = decide({ ...ok, faceMatch: { score: 0.9 } }, strict);
  assert.equal(d.status, "manual_review");
});

// --- FV-5: provider-calibrated thresholds ---

test("FV-5: ONNX cosine-scale thresholds approve a genuine match that the faceplugin-scale defaults would reject", () => {
  // A genuine same-person ArcFace cosine similarity lands ~0.5.
  const genuine = {
    selfie: { faceCount: 1 },
    liveness: { score: 0.8 },
    idFace: { found: true },
    faceMatch: { score: 0.5 },
    document: { ocrConfidence: 0.94, expired: false }
  };

  // Platform (faceplugin-scale) defaults: 0.5 < reject 0.65 → wrongly rejected.
  const fpThresholds = resolveThresholds({});
  const fp = decide(genuine, fpThresholds);
  assert.equal(fp.status, "rejected");
  assert.ok(fp.reasonCodes.includes("FACE_MATCH_FAILED"));

  // ONNX profile: 0.5 >= pass 0.42 → approved (given other signals clean).
  const onnxThresholds = resolveThresholds({}, "onnx");
  assert.ok(onnxThresholds.faceMatch.pass <= 0.5, `onnx pass should be <= 0.5, got ${onnxThresholds.faceMatch.pass}`);
  const on = decide(genuine, onnxThresholds);
  assert.equal(on.status, "approved", JSON.stringify(on));
});

test("FV-5: unknown/absent provider falls back to platform (faceplugin) defaults", () => {
  assert.deepEqual(resolveThresholds({}), resolveThresholds({}, "does-not-exist"));
  const t = resolveThresholds({}, "faceplugin");
  assert.equal(t.faceMatch.reject, 0.65);
  assert.equal(t.faceMatch.pass, 0.82);
});

test("FV-5: onnx impostor score below onnx reject is still rejected", () => {
  const impostor = {
    selfie: { faceCount: 1 }, liveness: { score: 0.8 }, idFace: { found: true },
    faceMatch: { score: 0.2 }, document: { ocrConfidence: 0.94, expired: false }
  };
  const on = decide(impostor, resolveThresholds({}, "onnx"));
  assert.equal(on.status, "rejected");
  assert.ok(on.reasonCodes.includes("FACE_MATCH_FAILED"));
});

test("P0 capture integrity: virtualCameraSuspected routes to manual review", () => {
  const { decide, resolveThresholds } = require("../src/decisionEngine");
  const t = resolveThresholds({});
  const r = decide({
    selfie: { faceCount: 1 },
    liveness: { score: 0.95 },
    risk: { virtualCameraSuspected: true }
  }, t);
  assert.equal(r.status, "manual_review");
  assert.ok(r.reasonCodes.includes("CAPTURE_INTEGRITY_RISK"));
});

test("STRICT: LIVENESS_MOTION_UNVERIFIED routes to manual review, not reject", () => {
  const { decide, resolveThresholds } = require("../src/decisionEngine");
  const r = decide({
    selfie: { faceCount: 1 }, liveness: { score: 0.95 },
    livenessChallenge: { ok: true, reasonCodes: [], motionUnverified: true }
  }, resolveThresholds(STRICT));
  assert.equal(r.status, "manual_review");
  assert.ok(r.reasonCodes.includes("LIVENESS_MOTION_UNVERIFIED"));
});

test("STRICT: LIVENESS_MANUAL_CAPTURE routes to manual review", () => {
  const { decide, resolveThresholds } = require("../src/decisionEngine");
  const r = decide({ selfie: { faceCount: 1 }, liveness: { score: 0.95 }, livenessChallenge: { ok: true, reasonCodes: [], manualCapture: true } }, resolveThresholds(STRICT));
  assert.equal(r.status, "manual_review");
  assert.ok(r.reasonCodes.includes("LIVENESS_MANUAL_CAPTURE"));
});

test("identity continuity: low selfie↔challenge similarity rejects, borderline reviews; occlusion reviews; multi-face challenge reviews", () => {
  const { decide, resolveThresholds } = require("../src/decisionEngine");
  const t = resolveThresholds(STRICT);
  const base = { selfie: { faceCount: 1 }, liveness: { score: 0.95 }, livenessChallenge: { ok: true, reasonCodes: [] } };
  assert.equal(decide({ ...base, livenessIdentity: { score: 0.3 } }, t).status, "rejected");
  assert.ok(decide({ ...base, livenessIdentity: { score: 0.3 } }, t).reasonCodes.includes("LIVENESS_IDENTITY_MISMATCH"));
  const mid = decide({ ...base, livenessIdentity: { score: (t.faceMatch.reject + t.faceMatch.pass) / 2 } }, t);
  assert.equal(mid.status, "manual_review"); assert.ok(mid.reasonCodes.includes("LIVENESS_IDENTITY_BORDERLINE"));
  assert.equal(decide({ ...base, livenessIdentity: { score: 0.95 } }, t).status, "approved");
  const occ = decide({ ...base, selfie: { faceCount: 1, occluded: true } }, t);
  assert.equal(occ.status, "manual_review"); assert.ok(occ.reasonCodes.includes("FACE_OCCLUDED"));
  const mf = decide({ ...base, livenessChallenge: { ok: true, reasonCodes: [], multiFaceActions: 2 } }, t);
  assert.equal(mf.status, "manual_review"); assert.ok(mf.reasonCodes.includes("MULTIPLE_FACES_DURING_CHALLENGE"));
});

test("STRICT: pose provider outage routes to manual review; capture anomaly routes to review", () => {
  const { decide, resolveThresholds } = require("../src/decisionEngine");
  const t = resolveThresholds(STRICT);
  const r = decide({ selfie: { faceCount: 1 }, liveness: { score: 0.95 }, livenessChallenge: { ok: true, reasonCodes: [], poseProviderUnavailable: true } }, t);
  assert.equal(r.status, "manual_review"); assert.ok(r.reasonCodes.includes("LIVENESS_POSE_PROVIDER_UNAVAILABLE"));
  const a = decide({ selfie: { faceCount: 1 }, liveness: { score: 0.95 }, risk: { captureAnomaly: true } }, t);
  assert.equal(a.status, "manual_review"); assert.ok(a.reasonCodes.includes("CAPTURE_INTEGRITY_RISK"));
});

// --- Liveness auto-approve rule (product rule 2026-09-07, default ON) ---

test("auto-approve: passive score above autoApprove approves and records the waived liveness codes", () => {
  const t = resolveThresholds({}); // defaults: autoApprove 0.6, challengePassApproves true
  assert.equal(t.liveness.autoApprove, 0.6);
  assert.equal(t.liveness.challengePassApproves, true);
  // 0.75 sits in the old review band (0.70–0.85) — now approved outright
  const band = decide({ ...ok, liveness: { score: 0.75 } }, t);
  assert.equal(band.status, "approved");
  assert.deepEqual(band.waivedReasonCodes, ["LIVENESS_BORDERLINE"]);
  assert.equal(band.livenessWaiver, "score");
  // a failed / incomplete challenge is waived when the score clears the bar
  const failed = decide({ ...ok, liveness: { score: 0.61 }, livenessChallenge: { ok: false, reasonCodes: ["LIVENESS_CHALLENGE_FAILED"], motionUnverified: true, evidenceInsufficient: true } }, t);
  assert.equal(failed.status, "approved");
  assert.deepEqual(failed.reasonCodes, []);
  // 0.61 is also below the faceplugin reject band (0.70) → LIVENESS_FAILED is waived as well
  assert.deepEqual(new Set(failed.waivedReasonCodes), new Set(["LIVENESS_FAILED", "LIVENESS_CHALLENGE_FAILED", "LIVENESS_MOTION_UNVERIFIED", "LIVENESS_EVIDENCE_INSUFFICIENT"]));
  // strictly above: exactly 0.60 does NOT trigger the rule
  const edge = decide({ ...ok, liveness: { score: 0.60 } }, t);
  assert.equal(edge.status, "rejected");
  assert.ok(edge.reasonCodes.includes("LIVENESS_FAILED"));
  assert.equal(edge.waivedReasonCodes, undefined);
});

test("auto-approve: a passed challenge approves even when the passive score failed", () => {
  const t = resolveThresholds({});
  const d = decide({ ...ok, liveness: { score: 0.2 }, livenessChallenge: { ok: true, reasonCodes: [], motionUnverified: true, manualCapture: true, poseProviderUnavailable: true, flatObject: true } }, t);
  assert.equal(d.status, "approved");
  assert.equal(d.livenessWaiver, "challenge");
  assert.deepEqual(new Set(d.waivedReasonCodes), new Set(["LIVENESS_FAILED", "LIVENESS_MOTION_UNVERIFIED", "LIVENESS_MANUAL_CAPTURE", "LIVENESS_POSE_PROVIDER_UNAVAILABLE", "LIVENESS_FLAT_OBJECT"]));
  // soft direction/flat-object flags are waived; the same codes as tenant-ENFORCED
  // challenge rejects are not (auto-approve never overrides an opted-in check)
  const soft = decide({ ...ok, liveness: { score: 0.95 }, livenessChallenge: { ok: true, reasonCodes: [], directionInconsistent: true, flatObject: true } }, t);
  assert.equal(soft.status, "approved");
  assert.deepEqual(new Set(soft.waivedReasonCodes), new Set(["LIVENESS_DIRECTION_INCONSISTENT", "LIVENESS_FLAT_OBJECT"]));
  const enforced = decide({ ...ok, liveness: { score: 0.95 }, livenessChallenge: { ok: false, reasonCodes: ["LIVENESS_DIRECTION_INCONSISTENT"] } }, t);
  assert.equal(enforced.status, "rejected");
  assert.deepEqual(enforced.reasonCodes, ["LIVENESS_DIRECTION_INCONSISTENT"]);
  // enforced screen-flash is a tenant opt-in → never waived
  const flash = decide({ ...ok, liveness: { score: 0.95, flash: { enforced: true, ok: false } } }, t);
  assert.equal(flash.status, "manual_review");
  assert.deepEqual(flash.reasonCodes, ["LIVENESS_FLASH_UNVERIFIED"]);
});

test("auto-approve never waives identity, replay, tamper, governance or non-liveness codes", () => {
  const t = resolveThresholds({});
  const hot = { ...ok, liveness: { score: 0.99 }, livenessChallenge: { ok: true, reasonCodes: [] } };
  for (const code of ["LIVENESS_IDENTITY_MISMATCH", "LIVENESS_IDENTITY_BORDERLINE", "LIVENESS_IDENTITY_UNAVAILABLE", "LIVENESS_CHALLENGE_DUPLICATE_FRAME", "LIVENESS_FRAME_BINDING_FAILED", "MULTIPLE_FACES_DURING_CHALLENGE", "LIVENESS_POLICY_UNVERIFIED", "LIVENESS_FLASH_UNVERIFIED"]) {
    assert.ok(!LIVENESS_WAIVABLE.has(code), `${code} must not be waivable`);
  }
  assert.equal(decide({ ...hot, livenessIdentity: { score: 0.1 } }, t).status, "rejected");
  assert.equal(decide({ ...hot, livenessIdentity: { score: null } }, t).status, "manual_review");
  assert.equal(decide({ ...hot, livenessChallenge: { ok: false, reasonCodes: ["LIVENESS_CHALLENGE_DUPLICATE_FRAME"] } }, t).status, "rejected");
  assert.equal(decide({ ...hot, livenessChallenge: { ok: true, reasonCodes: [], policyUnverified: true } }, t).status, "manual_review");
  assert.equal(decide({ ...hot, livenessChallenge: { ok: true, reasonCodes: [], multiFaceActions: 2 } }, t).status, "manual_review");
  assert.equal(decide({ ...hot, selfie: { faceCount: 0 } }, t).status, "rejected");
  assert.equal(decide({ ...hot, faceMatch: { score: 0.4 } }, t).status, "rejected");
  assert.equal(decide({ ...hot, document: { ocrConfidence: 0.9, expired: true } }, t).status, "manual_review");
  // the waived list still travels alongside a non-waived outcome
  const mixed = decide({ ...hot, liveness: { score: 0.75 }, faceMatch: { score: 0.7 } }, t);
  assert.equal(mixed.status, "manual_review");
  assert.deepEqual(mixed.reasonCodes, ["FACE_MATCH_BORDERLINE"]);
  assert.deepEqual(mixed.waivedReasonCodes, ["LIVENESS_BORDERLINE"]);
});

test("auto-approve knobs: tenant can raise the bar, disable challenge-pass, or switch the rule off", () => {
  const raised = resolveThresholds({ thresholds: { liveness: { autoApprove: 0.9 } } });
  assert.equal(decide({ ...ok, liveness: { score: 0.75 } }, raised).status, "manual_review");
  assert.equal(decide({ ...ok, liveness: { score: 0.91 } }, raised).status, "approved");
  const noChallenge = resolveThresholds({ thresholds: { liveness: { challengePassApproves: false } } });
  assert.equal(decide({ ...ok, liveness: { score: 0.2 }, livenessChallenge: { ok: true, reasonCodes: [] } }, noChallenge).status, "rejected");
  assert.equal(decide({ ...ok, liveness: { score: 0.75 } }, STRICT_T).status, "manual_review");
  assert.equal(decide({ ...ok, liveness: { score: 0.2 }, livenessChallenge: { ok: true, reasonCodes: [] } }, STRICT_T).status, "rejected");
  // bounds: clamped into [autoApproveMin, autoApproveMax]; garbage falls back to the default
  assert.equal(resolveThresholds({ thresholds: { liveness: { autoApprove: 5 } } }).liveness.autoApprove, 1);
  assert.equal(resolveThresholds({ thresholds: { liveness: { autoApprove: 0.01 } } }).liveness.autoApprove, 0.3);
  assert.equal(resolveThresholds({ thresholds: { liveness: { autoApprove: "x" } } }).liveness.autoApprove, 0.6);
  // provider profiles carry the same default
  assert.equal(resolveThresholds({}, "onnx").liveness.autoApprove, 0.6);
});
