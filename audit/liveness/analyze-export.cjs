"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");

const observations = {
  3: "Two scored attempts: multiple-face review, then borderline passive review. A face is visible in the captures; the sequence includes movements that do not consistently match their labels. Retain both historical decisions; calibrate detector and capture coaching (I02, I03, I05).",
  4: "Historical combined-document test: the document uploads show a room, not a usable ID; several face captures are cropped. Rejection is supported by missing document/OCR evidence. The result incorrectly says face matched with a null score. Retry was never completed; legacy attempt IDs are absent (I05, I06, I10).",
  5: "Historical multiple-face review followed by unfinished retry. Images include partial framing and motion blur. Do not present the old result as the current attempt; the stored attempt counter does not reconstruct the legacy retry (I03, I05, I06).",
  6: "Historical look-up challenge incomplete, followed by an unfinished retry. Visible chin-up captures need detector/pose regression coverage; legacy bindings prevent exact attempt isolation (I03, I05, I06).",
  7: "Historical rejection: challenge incomplete and multiple faces. Only one prominent face is apparent at contact-sheet resolution; secondary detections require box-level calibration, not an assumption that every extra box is false (I02, I03).",
  13: "Historical approval using the retired smile-era challenge. Useful positive reference, but not evidence of current challenge security or production readiness (I01, I12).",
  14: "Historical look-up failure and borderline aggregate. Several captures are blurred or low in frame, and labelled turn-right captures show limited clear turn travel. Improve quality/trajectory guidance; not a confirmed false reject (I02, I03).",
  15: "Historical approval with smile-era evidence in dim lighting. Preserve as a lighting regression sample, not a current-policy acceptance baseline (I01, I02).",
  18: "First attempt failed look-up; second passed the challenge but scored 0.634 and went to review. Large score variation between attempts warrants capture-quality and passive-model calibration (I02, I03).",
  23: "All 12 images are flat blank captures without a usable face; all three rejections are supported by the evidence. This is a negative no-face control, not a false reject. Consent was absent in this development session; keep no-consent rejection tests for production (I11).",
  24: "Three historical rejections, then an unfinished fourth attempt in the audit trail although attemptNumber is 1. Some labelled look-up images show a downward/sideways head or a hand near the face. There are 40 retained images, including later incomplete captures (I03, I05, I06).",
  25: "Historical look-up failure plus multiple-face detection. Inspect mild motion and inconsistent action labels before changing thresholds; keep the selfie as a detector regression sample (I02, I03).",
  26: "Historical approved turn/tilt sequence. Retain as a positive control alongside negative attack tests; legacy capture metadata is incomplete (I01, I05).",
  27: "Both scored attempts went to multiple-face review. A single prominent face appears in the gallery; record raw boxes/confidence and test secondary detections before changing multi-face safeguards (I02).",
  28: "First attempt had insufficient pose; second reached review on motion verification. Images include limited travel and mixed tilt directions. Improve baseline capture and movement coaching (I03).",
  29: "Two attempts with challenge failure; latest passive score is 0.477. Labels and visible direction are not consistently aligned. Separate passive-quality failure from action completion in reviewer diagnostics (I02, I03, I05).",
  30: "ID-only approval with OCR confidence 0.60. A card image is present, but OCR confidence is not proof of authenticity or correct field extraction. Manually label extracted fields and test tampering/expiry validation (I10).",
  34: "ID-only approval with OCR confidence 0.61. Treat as a document extraction test, not a liveness success; verify expected field values and authenticity evidence (I10).",
  36: "ID-only approval with OCR confidence 0.58. The image is visibly tilted; benchmark field-level OCR correctness and document validation on the original (I10).",
  37: "ID-only approval with OCR confidence 0.60. Preserve separately from face-only metrics; document authenticity and OCR accuracy remain unvalidated by the approval alone (I10).",
  38: "Both attempts went to motion-unverified review. Captures show modest movements and varying starting poses; calibrate trajectory travel and baseline reset without accepting a stationary target pose (I03).",
  39: "Both attempts rejected for incomplete challenge; latest also motion-unverified. Chin-up faces are visible in the retained images. Use these as detector/pose regression candidates while acknowledging the legacy policy (I03).",
  43: "Historical identity mismatch and motion review signals. Tilted frames and a short turn burst are visible; old identity aggregation was pose-sensitive. Current best-frontal aggregation must still be tested against mid-action identity substitution (I03, I04).",
  44: "Both attempts passed the challenge but went to motion review. Flash diagnostics also show weak/no response. Separate trajectory calibration from experimental flash behavior (I03, I08).",
  45: "Historical review for identity borderline, motion, and flat-object heuristic. Chin-up faces are visible; rigidity is not confirmed ground truth for a flat attack. Validate the newer two-action rule on labelled live and attack captures (I03, I04, I08).",
  46: "Early-v2 rejection for identity mismatch and motion. Later code changed identity selection and trajectory handling; preserve this as a historical regression, not proof those defects remain in the latest build (I01, I03, I04).",
  47: "Early-v2 failure combines look-up, sequence span, identity borderline, motion, and passive borderline. The look-up-labelled burst includes a strong sideways turn. Coaching and waiting-time accounting both need coverage (I02, I03).",
  48: "Early-v2 identity/direction/sequence/motion rejection. The contact sheet shows opposing turns despite a direction inconsistency flag. Pose-sign accuracy and release-specific calibration are required (I01, I03, I04).",
  49: "Both attempts rejected with frame-binding failure under the old pipeline despite new attempt-bound evidence. This is historical API/worker incompatibility, not image-level spoof evidence. Preserve strict binding; prevent build mismatch (I07).",
  50: "Historical frame-binding failure under the old pipeline. Images show a complete capture sequence, but correct binding alone would not establish that every challenge passes. Release compatibility must be checked independently of model decisions (I07).",
  51: "Review: no qualifying frontal identity frame and unverified motion. Bursts begin in turned/tilted poses. Capture a reliable neutral baseline and independently check identity across actions (I03, I04).",
  52: "Rejection combines passive 0.486, identity mismatch, direction inconsistency, insufficient evidence and motion. No single threshold fix resolves all signals; use action-level diagnostics and build-specific replay (I01, I02, I03, I04).",
  53: "Selfie 0.995 but turn-left peak yaw was only -6.9 in this build, while the image sequence visibly turns. A pose-estimator regression candidate; latest code uses mirrored inference (I03).",
  55: "Selfie 0.972; the historical look-up burst was not live/pose eligible despite a visible chin-up face. Passive-floor and detector sensitivity require joint testing; do not simply remove the floor (I02, I03).",
  56: "Approved turn/down sequence, selfie 0.789. Positive reference for this exact build and lighting; not a security validation sample by itself (I01, I02).",
  57: "Approved turn/down sequence, selfie 0.778. Compare with low-scoring sessions while keeping build, pose, exposure and capture timing distinct (I01, I02).",
  58: "Rejected: selfie 0.389, under-reported left turn, and assisted/unverified policy. Reissued evidence exists. Passive calibration, pose estimation and assisted-capture routing are separate issues (I02, I03, I09).",
  59: "Rejected: selfie 0.475, left turn peak -14.1, assisted policy. Twenty-two images span a reissued challenge within the session. Show which evidence was actually consumed and why assistance requires review (I02, I03, I05, I09).",
  60: "Attempt 1 passed all actions but went to review on passive 0.623; attempt 2 has no result. At snapshot time the reopened session was overdue. Show previous outcome separately and expire the current unfinished attempt (I02, I05, I06).",
  61: "Selfie 0.968 but historical turn-left failed. Visually turned frames are present; keep as a regression for mirrored pose inference rather than lowering thresholds without attack data (I03).",
  62: "Only two turn-left images, no selfie and no result. The session was overdue at snapshot. This is incomplete capture, not a liveness rejection; instrument interruption/camera/model errors (I06, I09).",
  63: "Approved, selfie 0.988, complete look-up and turn sequence. Preserve the positive outcome together with source digest and experimental flash diagnostic (I01, I08).",
  64: "Manual review solely for direction inconsistency. Images show opposing turns. Current consistency mode is record-only; evaluate a sign-reliable pose model before restoring enforcement (I03).",
  65: "Rejected: selfie 0.436, look-up challenge failure and motion uncertainty. The face is visible but tilted; insufficient model evidence is not proof of spoofing or proof of a false reject (I02, I03).",
  66: "Manual review solely for direction inconsistency despite visible opposing turns. Historical pose-sign issue; retain as a directional calibration case (I03).",
  67: "Review for evidence insufficiency, motion and direction. Chin-up faces are visible at thumbnail resolution. Detector misses cannot be equated with the face physically leaving the image; compare raw boxes at full resolution (I03).",
  68: "Review for insufficient evidence and assisted policy after reissue. Eighteen images contain evidence from more than one challenge instance. Improve coaching while retaining assisted-review safeguards and exact evidence attribution (I03, I05, I09).",
  69: "Approved turn/down sequence, selfie 0.965. Positive reference; validation remains tied to a changing policy label, not an independently certified build (I01).",
  70: "Approved turn/down sequence, selfie 0.757. Keep as a near-pass quality reference and compare against rejected selfies using labelled ground truth (I01, I02).",
  71: "Review: selfie 0.644 and insufficient look-up evidence. Chin-up faces are visible. Test tracked detection and passive quality independently; a detector fix alone need not lift the selfie above 0.65 (I02, I03).",
  72: "Approved turn/up sequence, selfie 0.998. Positive chin-up reference for the same room/device family, not a guarantee of tilt reliability across captures (I01, I03).",
  73: "Review for assisted policy and motion after reissue; selfie 0.999. Assistance intentionally prevents automatic approval. Improve false wrong-way hints without silently bypassing this control (I03, I09).",
  74: "Approved turn/up sequence, selfie 0.979. Preserve as a positive tilt regression case; maintain negative controls when tuning pose and detection (I01, I03).",
  75: "Rejected: look-up pose failure, insufficient evidence and assisted policy despite selfie 0.963. Chin-up images are visible; previous analysis describes yaw/pitch confusion. Requires exact per-frame pose checks, not a global pass-threshold reduction (I03, I09).",
  76: "Attempt 1 passed every action and identity (0.843), but selfie 0.596 caused review while frontal scores were 0.974/0.958/0.990. Attempt 2 has one frame and no result; it was still within TTL at the snapshot. Strong passive-variance case, not a completed retry (I02, I05).",
  77: "Approved and reproduced by current in-memory replay. Selfie 0.977 and identity 0.675 pass, but frontal challenge median is only 0.226. Contradictory passive scores remain a validation risk; do not assume approval proves bona fide input (I01, I02, I04).",
  78: "Approved and reproduced by current in-memory replay. Selfie 0.926, identity 0.526; frontal challenge median 0.217 and turn-left maximum 0.294. A strong selfie softens the active floor to 0.2. Explicitly test this cross-upload trust boundary against attacks (I01, I02, I04).",
  79: "Rejected and reproduced by current in-memory replay. Selfie 0.393; turn maxima 0.273 and 0.243 are below the 0.3 active floor, so neither turn becomes pose-eligible. Look-up passes at pitch 39.3. Visible turns do not make this a proven pose-model failure: passive eligibility is the immediate blocker (I02, I03)."
};

function countBy(rows, key) {
  return rows.reduce((counts, row) => {
    const value = key(row);
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function score(value) {
  return Number.isFinite(value) ? value.toFixed(4) : "not available";
}

async function main() {
  process.umask(0o077);
  assert(process.argv[2], "Usage: node audit/liveness/analyze-export.cjs <export directory>");
  const root = path.resolve(process.argv[2]);
  const data = JSON.parse(await fs.readFile(path.join(root, "database.json"), "utf8"));
  const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.finishedAt, "2026-09-07T17:33:51.526Z", "Human observations are specific to the reviewed snapshot; review new data before reusing them.");
  const summaries = JSON.parse(await fs.readFile(path.join(root, "summaries.json"), "utf8"));
  const at = new Date(manifest.finishedAt);
  const stats = {
    snapshot: manifest.finishedAt,
    sessions: summaries.length,
    results: data.verificationResult.length,
    evidence: data.evidenceFile.length,
    statuses: countBy(summaries, row => row.status),
    faceOnly: countBy(summaries.filter(row => row.type === "FACE_ONLY"), row => row.status),
    afternoon: countBy(summaries.filter(row => new Date(row.createdAt) >= new Date("2026-09-07T15:00:00Z")), row => row.status),
    overdue: summaries.filter(row => ["created", "started"].includes(row.status) && new Date(row.expiresAt) < at).map(row => row.number),
    consented: summaries.filter(row => row.consentAt).length,
    captured: summaries.filter(row => row.evidenceCount).length,
    withResults: summaries.filter(row => row.resultCount).length
  };
  assert.equal(manifest.evidence.verified, data.evidenceFile.length);
  assert.deepEqual(manifest.countsBefore, manifest.countsAfter);
  const sessionIds = new Set(data.verificationSession.map(session => session.id));
  assert(data.verificationResult.every(result => sessionIds.has(result.sessionId)));
  assert(data.evidenceFile.every(evidence => sessionIds.has(evidence.sessionId)));
  const sections = ["# Complete Session Ledger", "", `Snapshot: ${manifest.finishedAt} (UTC). ${summaries.length} sessions, ${data.verificationResult.length} results, ${data.evidenceFile.length} checksum-verified images.`, "", "[Image gallery](index.html) | [Database export](database.json) | [Image manifest](evidence-manifest.json) | [Snapshot manifest](manifest.json)", "", "All images were inspected as contact-sheet thumbnails; originals are linked for closer inspection. Images establish framing and visible movement, not identity, physical liveness or document authenticity. Improvement IDs I01-I12 refer to the root audit report.", "", "Legacy records lack attempt IDs. Their decision events are shown in chronological order, not claimed as exact result-to-attempt joins. A current session status is not the same as its last completed attempt's outcome.", "", "## Index", "", "| Ref | Session | Current State | Product | Results | Images |", "| --- | --- | --- | --- | ---: | ---: |"];
  for (const summary of summaries) sections.push(`| [S${summary.number}](#s${summary.number}) | ${summary.sessionUid} | ${summary.status} | ${summary.type} | ${summary.resultCount} | ${summary.evidenceCount} |`);
  let coveredResults = 0;
  let coveredEvidence = 0;
  for (const summary of summaries) {
    const bundle = JSON.parse(await fs.readFile(path.join(root, "sessions", summary.sessionUid, "session.json"), "utf8"));
    const { session, results, files, logs } = bundle;
    coveredResults += results.length;
    coveredEvidence += files.length;
    const gallery = `sessions/${session.sessionUid}/index.html`;
    const detail = `sessions/${session.sessionUid}/session.json`;
    const overdue = stats.overdue.includes(summary.number);
    const fallback = !files.length
      ? `${session.consentAt ? "Consent was recorded, but no evidence or result was retained." : "No consent, evidence or result was retained."} ${overdue ? "The record is past expiresAt but remains nonterminal." : "No completed attempt is available."} Classify as unfinished/abandoned funnel traffic, not a model failure; add explicit exit diagnostics and terminal expiry (I06, I09).`
      : "Inspect stored decisions and evidence below; no independent ground-truth label is available.";
    sections.push("", `<a id="s${summary.number}"></a>`, `## S${summary.number}`, "", `Session: ${session.sessionUid}. [Images](${gallery}) | [All data and audit events](${detail})`, "", `Created: ${session.createdAt}. Current status: **${session.status}**. Product: ${session.verificationType}. Stored attemptNumber: ${session.attemptNumber}. Expiry: ${session.expiresAt || "none"}${overdue ? " (overdue at snapshot)" : ""}.`, "", observations[summary.number] || fallback, "", `Current session reason codes: ${(session.decisionReason?.reasonCodes || []).join(", ") || "none (may be cleared on retry)"}.`, "", "### Stored Results", "");
    if (!results.length) sections.push("No result was stored; no verification outcome can be inferred.");
    for (const [index, result] of results.entries()) {
      const raw = result.rawResult || {};
      const exactEvent = result.attemptId ? logs.find(log => log.action === "verification.decided" && log.metadata?.attemptId === result.attemptId) : null;
      sections.push(`- Result ${index + 1}: ${result.id}, ${result.createdAt}; attempt ${result.attemptId || "legacy/unbound"}. Passive ${score(result.livenessScore)} (${result.livenessStatus || "not applicable"}); face match ${score(result.faceMatchScore)} (${result.faceMatchStatus || "not applicable"}); document ${result.documentStatus || "not applicable"}, OCR ${score(result.ocrConfidence)}.`, `  Pipeline ${raw.pipelineVersion || "missing"}; source digest ${raw.release?.sourceDigest || "missing"}; model ${raw.modelVersion || "missing"}.`, `  ${exactEvent ? `Decision: ${exactEvent.metadata.status}; reasons: ${(exactEvent.metadata.reasonCodes || []).join(", ") || "none"}.` : "No exact attempt-bound decision join; consult the chronological audit events below."}`);
      if (raw.livenessIdentity) sections.push(`  Identity score ${score(raw.livenessIdentity.score)}; aggregation ${raw.livenessIdentity.aggregation || "not recorded"}; reason ${raw.livenessIdentity.reason || raw.livenessIdentity.error || "none"}.`);
      for (const [action, value] of Object.entries(raw.livenessChallenge?.perAction || {})) sections.push(`  Action ${action}: present=${value.present}, live=${value.live}, poseOk=${value.poseOk}, passiveMax=${score(value.score)}, peakYaw=${value.peakYaw ?? "not recorded"}, peakPitch=${value.peakPitch ?? "not recorded"}, trajectoryOk=${value.trajectoryOk ?? "not recorded"}.`);
    }
    sections.push("", "### Decision And Retry History", "");
    const events = logs.filter(log => /verification.decided|session.retry|challenge.reissued|review\./.test(log.action));
    if (!events.length) sections.push("No decision/retry events stored.");
    for (const event of events) sections.push(`- ${event.createdAt}: ${event.action}: ${JSON.stringify(event.metadata || {})}`);
    sections.push("", "### Image References", "");
    if (!files.length) sections.push("No images stored.");
    for (const file of files) sections.push(`- [E${file.evidenceIndex}: ${file.label || file.fileType}](${file.file}): attempt ${file.attemptId || "legacy/unbound"}; ${file.width}x${file.height}; checksum ${file.integrity}; [sheet ${file.contactSheet}](contact-sheets/${String(file.contactSheet).padStart(2, "0")}.jpg), tile ${file.contactTile}.`);
  }
  assert.equal(coveredResults, data.verificationResult.length);
  assert.equal(coveredEvidence, data.evidenceFile.length);
  await fs.writeFile(path.join(root, "SESSION_LEDGER.md"), sections.join("\n") + "\n");
  await fs.writeFile(path.join(root, "analysis-stats.json"), JSON.stringify(stats, null, 2));
  console.log(JSON.stringify({ sessionsCovered: summaries.length, resultsCovered: coveredResults, evidenceCovered: coveredEvidence, overdue: stats.overdue.length, ledger: path.join(root, "SESSION_LEDGER.md") }, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });