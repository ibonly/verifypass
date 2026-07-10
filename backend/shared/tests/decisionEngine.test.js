"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { decide, resolveThresholds } = require("../src/decisionEngine");
const { DEFAULT_THRESHOLDS } = require("../src/reasonCodes");

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
    const d = decide(signals, DEFAULT_THRESHOLDS);
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
  const d = decide({ ...ok, livenessChallenge: { ok: false, reasonCodes: ["LIVENESS_CHALLENGE_FAILED"] } });
  assert.equal(d.status, "rejected");
  assert.equal(d.riskLevel, "high");
  assert.ok(d.reasonCodes.includes("LIVENESS_CHALLENGE_FAILED"));
});

test("livenessChallenge incomplete → rejected (fail closed)", () => {
  const d = decide({ ...ok, livenessChallenge: { ok: false, reasonCodes: ["LIVENESS_CHALLENGE_INCOMPLETE"] } });
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
