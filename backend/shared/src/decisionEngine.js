"use strict";

// Decision engine (PRD §9.9, §13.2, §14). PURE FUNCTION — no I/O, no clock,
// no randomness. Tested against a golden table; changing any rule must break
// a test.

const { DEFAULT_THRESHOLDS, THRESHOLD_BOUNDS, THRESHOLD_PROFILES, REASON_CODES } = require("./reasonCodes");

/**
 * Merge tenant-configured thresholds over defaults, clamped to platform bounds.
 * @param {object} tenantSettings tenant.settings ({ thresholds: {...} })
 * @param {string} [providerName] active provider ("onnx" | "faceplugin" | ...).
 *   Face-match/liveness SCORE SCALES differ by provider (FV-5), so the base
 *   defaults AND bounds come from that provider's profile when one exists;
 *   an unknown/absent provider falls back to the platform faceplugin scale.
 */
function resolveThresholds(tenantSettings = {}, providerName) {
  const profile = providerName ? THRESHOLD_PROFILES[providerName] : null;
  const baseDefaults = profile ? profile.defaults : DEFAULT_THRESHOLDS;
  const bounds = profile ? profile.bounds : THRESHOLD_BOUNDS;
  const t = tenantSettings.thresholds || {};
  const merged = {
    liveness: { ...baseDefaults.liveness, ...(t.liveness || {}) },
    faceMatch: { ...baseDefaults.faceMatch, ...(t.faceMatch || {}) },
    maxFailedAttempts: t.maxFailedAttempts || DEFAULT_THRESHOLDS.maxFailedAttempts,
    risk: { ...DEFAULT_THRESHOLDS.risk, ...(t.risk || {}) }
  };
  for (const k of ["liveness", "faceMatch"]) {
    const b = bounds[k];
    if (!Number.isFinite(merged[k].reject)) merged[k].reject = baseDefaults[k].reject;
    if (!Number.isFinite(merged[k].pass)) merged[k].pass = baseDefaults[k].pass;
    merged[k].reject = Math.min(Math.max(merged[k].reject, b.rejectMin), b.passMax);
    merged[k].pass = Math.max(Math.min(merged[k].pass, b.passMax), b.rejectMin);
    if (merged[k].reject > merged[k].pass) merged[k].reject = merged[k].pass;
  }
  return merged;
}

/**
 * @param {object} signals
 * @param {object} [signals.selfie]    {faceCount}
 * @param {object} [signals.liveness]  {score 0..1}
 * @param {object} [signals.idFace]    {found}
 * @param {object} [signals.faceMatch] {score 0..1} — omit for FACE_ONLY re-auth
 * @param {object} [signals.document]  {ocrConfidence 0..1|null, expired,
 *   liveFaceAsDocument} — omit for FACE_ONLY. liveFaceAsDocument: the "ID"
 *   image passed PASSIVE LIVENESS as a real face — it's a person shown to the
 *   camera, not a document (a genuine card's printed portrait scores Spoof)
 * @param {object} [signals.risk]      fraud-signal flags (Phase 2):
 *   {repeatedFailedAttempts, deviceSharedAcrossIdentities, ipVelocityExceeded}
 *   — flags force at least manual_review; they never auto-reject on their own
 * @param {object} [thresholds] resolved thresholds (resolveThresholds output)
 * @returns {{status, riskLevel, reasonCodes: string[]}}
 */
function decide(signals, thresholds = DEFAULT_THRESHOLDS) {
  const rejects = [];
  const reviews = [];
  const R = REASON_CODES;

  const { selfie, liveness, idFace, faceMatch, document, risk, livenessChallenge, livenessIdentity } = signals;

  // Identity continuity (v5 A4): the challenge performer must be the selfie
  // subject. Same bands as face match (the same embedding model produces it).
  if (livenessIdentity && Number.isFinite(livenessIdentity.score) && livenessIdentity.score >= 0 && livenessIdentity.score <= 1) {
    if (livenessIdentity.score < thresholds.faceMatch.reject) rejects.push(R.LIVENESS_IDENTITY_MISMATCH);
    else if (livenessIdentity.score < thresholds.faceMatch.pass) reviews.push(R.LIVENESS_IDENTITY_BORDERLINE);
  }
  if (livenessIdentity && (!Number.isFinite(livenessIdentity.score) || livenessIdentity.score < 0 || livenessIdentity.score > 1)) reviews.push(R.LIVENESS_IDENTITY_UNAVAILABLE);
  if (livenessChallenge?.evidenceInsufficient) reviews.push(R.LIVENESS_EVIDENCE_INSUFFICIENT);
  if (livenessChallenge?.policyUnverified) reviews.push(R.LIVENESS_POLICY_UNVERIFIED);
  // Occlusion on the selfie (mask/hand/sunglasses per the liveness model) →
  // a reviewer looks (v5 A6); never auto-approve an occluded selfie.
  if (selfie && selfie.occluded === true) reviews.push(R.FACE_OCCLUDED);

  if (risk) {
    if (risk.repeatedFailedAttempts) reviews.push(R.REPEATED_FAILED_ATTEMPTS);
    if (risk.deviceSharedAcrossIdentities) reviews.push(R.DEVICE_SHARED_ACROSS_IDENTITIES);
    if (risk.ipVelocityExceeded) reviews.push(R.IP_VELOCITY_EXCEEDED);
    // P0 capture integrity: a suspected virtual/injected camera is a soft
    // signal (labels are spoofable and absence proves nothing) — it routes to
    // manual review, never auto-reject.
    if (risk.virtualCameraSuspected || risk.captureAnomaly) reviews.push(R.CAPTURE_INTEGRITY_RISK);
  }

  // Active liveness challenge (server-authoritative anti-spoofing). A failed or
  // incomplete challenge is a hard gate — replay/deepfake can't satisfy an
  // unpredictable, server-issued action sequence.
  // Soft: the challenge passed on magnitude but the burst showed no motion
  // trajectory (all frames already at the angle / constant pose): review.
  if (livenessChallenge && livenessChallenge.motionUnverified) reviews.push(R.LIVENESS_MOTION_UNVERIFIED);
  // Manually captured challenge frames bypass the client-side action check —
  // a reviewer decides, never the auto path.
  if (livenessChallenge && livenessChallenge.manualCapture) reviews.push(R.LIVENESS_MANUAL_CAPTURE);
  if (livenessChallenge && (livenessChallenge.multiFaceActions || 0) >= 2) reviews.push(R.MULTIPLE_FACES_DURING_CHALLENGE);
  // Pose provider outage: queue for a human + ops alert, do not reject customers (v5 C2)
  if (livenessChallenge && livenessChallenge.poseProviderUnavailable) reviews.push(R.LIVENESS_POSE_PROVIDER_UNAVAILABLE);
  // Opposite-sign turn check failed but is not enforced: a reviewer decides
  // (the pose model's sign is not yet reliable enough to auto-reject).
  if (livenessChallenge && livenessChallenge.directionInconsistent && !(livenessChallenge.reasonCodes || []).includes("LIVENESS_DIRECTION_INCONSISTENT")) reviews.push(R.LIVENESS_DIRECTION_INCONSISTENT);
  // No nose parallax during a head turn = a flat object (print/screen). Soft
  // by default (review); the worker adds the reject code when enforced.
  if (livenessChallenge && livenessChallenge.flatObject && !(livenessChallenge.reasonCodes || []).includes("LIVENESS_FLAT_OBJECT")) reviews.push(R.LIVENESS_FLAT_OBJECT);
  // Screen-flash: the face did not answer the random colour sequence (a
  // conclusive negative — inconclusive/low-light is ok:null and never flags).
  // Only when the worker enforces it (flash.enforced); otherwise record-only.
  if (liveness && liveness.flash && liveness.flash.enforced && liveness.flash.ok !== true) reviews.push(R.LIVENESS_FLASH_UNVERIFIED);
  if (livenessChallenge && livenessChallenge.ok === false) {
    for (const code of livenessChallenge.reasonCodes || []) {
      if (R[code]) rejects.push(R[code]);
    }
    if (!(livenessChallenge.reasonCodes || []).length) rejects.push(R.LIVENESS_CHALLENGE_FAILED);
  }

  // Selfie face presence. No face = hard reject. Multiple faces = MANUAL
  // REVIEW (PRD §13.2 allows either): face detectors emit spurious secondary
  // boxes on busy backgrounds, and a false positive must not hard-reject a
  // real user — a reviewer sees the actual photo.
  if (selfie) {
    if (!Number.isInteger(selfie.faceCount) || selfie.faceCount <= 0) rejects.push(R.NO_FACE_ON_SELFIE);
    else if (selfie.faceCount > 1) reviews.push(R.MULTIPLE_FACES_DETECTED);
  }

  // Liveness bands. A selfie below the reject band whose frontal challenge
  // frames (≥2, judged by the same model) pass is CONTRADICTORY evidence —
  // a reviewer decides (borderline), never an automatic approval, never an
  // automatic rejection. Frames can never lift a selfie into approval.
  if (liveness && Number.isFinite(liveness.score) && liveness.score >= 0 && liveness.score <= 1) {
    const frontalPass = Number.isFinite(liveness.frontalMedian) && liveness.frontalMedian >= thresholds.liveness.pass && (liveness.frontalFrames || 0) >= 2;
    if (liveness.score < thresholds.liveness.reject) (frontalPass ? reviews : rejects).push(frontalPass ? R.LIVENESS_BORDERLINE : R.LIVENESS_FAILED);
    else if (liveness.score < thresholds.liveness.pass) reviews.push(R.LIVENESS_BORDERLINE);
  } else if (liveness) {
    rejects.push(R.LIVENESS_FAILED); // no score = failed check, fail closed
  }

  // ID face extraction (review, not reject — PRD §14)
  if (idFace && !idFace.found) reviews.push(R.NO_FACE_ON_DOCUMENT);

  // Face match bands (only meaningful when an ID face exists)
  if (faceMatch && (!idFace || idFace.found)) {
    if (!Number.isFinite(faceMatch.score) || faceMatch.score < 0 || faceMatch.score > 1) {
      reviews.push(R.FACE_MATCH_BORDERLINE);
    } else if (faceMatch.score < thresholds.faceMatch.reject) {
      rejects.push(R.FACE_MATCH_FAILED);
    } else if (faceMatch.score < thresholds.faceMatch.pass) {
      reviews.push(R.FACE_MATCH_BORDERLINE);
    }
  }

  // Document checks
  if (document) {
    // A selfie submitted as the "ID front" would otherwise sail through
    // face-compare (it trivially matches itself). Manual review, not reject:
    // an honest user confused by the capture UX hits this too, and the
    // reviewer sees the actual image.
    if (document.liveFaceAsDocument) reviews.push(R.DOCUMENT_IS_LIVE_FACE);
    if (document.expired) reviews.push(R.DOCUMENT_EXPIRED);
    if (document.ocrConfidence == null || document.ocrConfidence === 0) {
      reviews.push(R.DOCUMENT_OCR_FAILED);
    }
    // NOTE (product decision 2026-07-06): extraction-only OCR
    // (document.validated === false) does NOT flag review — extraction is
    // informational, and identity verification happens in a later phase
    // (government DB lookup). The flag is still recorded in rawResult; when
    // the verification phase lands, gate on ITS result, not on OCR.
  }

  if (rejects.length) {
    return { status: "rejected", riskLevel: "high", reasonCodes: rejects.concat(reviews) };
  }
  if (reviews.length) {
    return { status: "manual_review", riskLevel: "medium", reasonCodes: reviews };
  }
  return { status: "approved", riskLevel: "low", reasonCodes: [] };
}

module.exports = { decide, resolveThresholds };
