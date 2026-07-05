"use strict";

// Decision engine (PRD §9.9, §13.2, §14). PURE FUNCTION — no I/O, no clock,
// no randomness. Tested against a golden table; changing any rule must break
// a test.

const { DEFAULT_THRESHOLDS, THRESHOLD_BOUNDS, REASON_CODES } = require("./reasonCodes");

/** Merge tenant-configured thresholds over defaults, clamped to platform bounds. */
function resolveThresholds(tenantSettings = {}) {
  const t = tenantSettings.thresholds || {};
  const merged = {
    liveness: { ...DEFAULT_THRESHOLDS.liveness, ...(t.liveness || {}) },
    faceMatch: { ...DEFAULT_THRESHOLDS.faceMatch, ...(t.faceMatch || {}) },
    maxFailedAttempts: t.maxFailedAttempts || DEFAULT_THRESHOLDS.maxFailedAttempts,
    risk: { ...DEFAULT_THRESHOLDS.risk, ...(t.risk || {}) }
  };
  for (const k of ["liveness", "faceMatch"]) {
    const b = THRESHOLD_BOUNDS[k];
    merged[k].reject = Math.max(merged[k].reject, b.rejectMin);
    merged[k].pass = Math.min(merged[k].pass, b.passMax);
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
 * @param {object} [signals.document]  {ocrConfidence 0..1|null, expired} — omit for FACE_ONLY
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

  const { selfie, liveness, idFace, faceMatch, document, risk, livenessChallenge } = signals;

  if (risk) {
    if (risk.repeatedFailedAttempts) reviews.push(R.REPEATED_FAILED_ATTEMPTS);
    if (risk.deviceSharedAcrossIdentities) reviews.push(R.DEVICE_SHARED_ACROSS_IDENTITIES);
    if (risk.ipVelocityExceeded) reviews.push(R.IP_VELOCITY_EXCEEDED);
  }

  // Active liveness challenge (server-authoritative anti-spoofing). A failed or
  // incomplete challenge is a hard gate — replay/deepfake can't satisfy an
  // unpredictable, server-issued action sequence.
  if (livenessChallenge && livenessChallenge.ok === false) {
    for (const code of livenessChallenge.reasonCodes || []) {
      if (R[code]) rejects.push(R[code]);
    }
    if (!(livenessChallenge.reasonCodes || []).length) rejects.push(R.LIVENESS_CHALLENGE_FAILED);
  }

  // Selfie face presence (hard gates)
  if (selfie) {
    if (selfie.faceCount === 0) rejects.push(R.NO_FACE_ON_SELFIE);
    else if (selfie.faceCount > 1) rejects.push(R.MULTIPLE_FACES_DETECTED);
  }

  // Liveness bands
  if (liveness && typeof liveness.score === "number") {
    if (liveness.score < thresholds.liveness.reject) rejects.push(R.LIVENESS_FAILED);
    else if (liveness.score < thresholds.liveness.pass) reviews.push(R.LIVENESS_BORDERLINE);
  } else if (liveness) {
    rejects.push(R.LIVENESS_FAILED); // no score = failed check, fail closed
  }

  // ID face extraction (review, not reject — PRD §14)
  if (idFace && !idFace.found) reviews.push(R.NO_FACE_ON_DOCUMENT);

  // Face match bands (only meaningful when an ID face exists)
  if (faceMatch && (!idFace || idFace.found)) {
    if (typeof faceMatch.score !== "number") {
      reviews.push(R.FACE_MATCH_BORDERLINE);
    } else if (faceMatch.score < thresholds.faceMatch.reject) {
      rejects.push(R.FACE_MATCH_FAILED);
    } else if (faceMatch.score < thresholds.faceMatch.pass) {
      reviews.push(R.FACE_MATCH_BORDERLINE);
    }
  }

  // Document checks
  if (document) {
    if (document.expired) reviews.push(R.DOCUMENT_EXPIRED);
    if (document.ocrConfidence == null || document.ocrConfidence === 0) {
      reviews.push(R.DOCUMENT_OCR_FAILED);
    }
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
