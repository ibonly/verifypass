"use strict";

/** Decision reason codes (PRD §9.9, §13.2, §14). Attached to decision output. */
const REASON_CODES = Object.freeze({
  LIVENESS_FAILED: "LIVENESS_FAILED",
  LIVENESS_BORDERLINE: "LIVENESS_BORDERLINE",
  FACE_MATCH_FAILED: "FACE_MATCH_FAILED",
  FACE_MATCH_BORDERLINE: "FACE_MATCH_BORDERLINE",
  DOCUMENT_IMAGE_LOW_QUALITY: "DOCUMENT_IMAGE_LOW_QUALITY",
  DOCUMENT_EXPIRED: "DOCUMENT_EXPIRED",
  DOCUMENT_OCR_FAILED: "DOCUMENT_OCR_FAILED",
  DOCUMENT_IS_LIVE_FACE: "DOCUMENT_IS_LIVE_FACE",
  DOCUMENT_UNVERIFIED: "DOCUMENT_UNVERIFIED",
  NO_FACE_ON_DOCUMENT: "NO_FACE_ON_DOCUMENT",
  NO_FACE_ON_SELFIE: "NO_FACE_ON_SELFIE",
  MULTIPLE_FACES_DETECTED: "MULTIPLE_FACES_DETECTED",
  LIVENESS_CHALLENGE_FAILED: "LIVENESS_CHALLENGE_FAILED",
  LIVENESS_CHALLENGE_INCOMPLETE: "LIVENESS_CHALLENGE_INCOMPLETE",
  LIVENESS_CHALLENGE_DUPLICATE_FRAME: "LIVENESS_CHALLENGE_DUPLICATE_FRAME",
  LIVENESS_CHALLENGE_EXPIRED: "LIVENESS_CHALLENGE_EXPIRED",
  REPEATED_FAILED_ATTEMPTS: "REPEATED_FAILED_ATTEMPTS",
  DEVICE_SHARED_ACROSS_IDENTITIES: "DEVICE_SHARED_ACROSS_IDENTITIES",
  IP_VELOCITY_EXCEEDED: "IP_VELOCITY_EXCEEDED",
  SESSION_TIMEOUT: "SESSION_TIMEOUT"
});

/** Default tenant thresholds (PRD §14). Tenant settings may override within bounds. */
const DEFAULT_THRESHOLDS = Object.freeze({
  liveness: { reject: 0.7, pass: 0.85 },
  faceMatch: { reject: 0.65, pass: 0.82 },
  maxFailedAttempts: 3,
  risk: Object.freeze({
    failedAttemptsWindowHours: 24, // window for counting prior rejected/failed attempts
    maxIdentitiesPerDevice: 3,     // distinct customerReferences per device fingerprint (7-day window)
    deviceWindowDays: 7,
    maxSessionsPerIpPerHour: 20
  })
});

/** Hard bounds the platform enforces on tenant-configured thresholds. */
const THRESHOLD_BOUNDS = Object.freeze({
  liveness: { rejectMin: 0.5, passMax: 0.99 },
  faceMatch: { rejectMin: 0.5, passMax: 0.99 },
  risk: Object.freeze({
    // caps sized to accommodate sandbox/testing tenants (one device running
    // hundreds of test identities is normal in integration testing)
    maxFailedAttempts: { min: 1, max: 100 },
    failedAttemptsWindowHours: { min: 1, max: 168 },
    maxIdentitiesPerDevice: { min: 1, max: 500 },
    deviceWindowDays: { min: 1, max: 90 },
    maxSessionsPerIpPerHour: { min: 5, max: 5000 }
  })
});

/**
 * Per-provider threshold profiles (FV-5). Similarity/liveness SCORE SCALES
 * differ by provider, so one set of numbers can't fit all:
 *   - faceplugin: the container returns a calibrated 0..1 similarity; the
 *     platform defaults above are tuned for it.
 *   - onnx: the dependency-free provider scores face-match as raw COSINE
 *     similarity of ArcFace embeddings (genuine pairs ~0.4-0.7, impostors
 *     <~0.3) and liveness as a softmax "real" probability. The platform
 *     defaults (faceMatch reject 0.65 / pass 0.82) sit ABOVE where genuine
 *     onnx matches land, so applying them would reject real users. This
 *     profile — and its bounds — put the thresholds on the cosine scale.
 * resolveThresholds(settings, providerName) selects the profile; an unknown
 * provider falls back to DEFAULT_THRESHOLDS / THRESHOLD_BOUNDS (faceplugin).
 */
const THRESHOLD_PROFILES = Object.freeze({
  faceplugin: Object.freeze({
    defaults: Object.freeze({ liveness: { reject: 0.7, pass: 0.85 }, faceMatch: { reject: 0.65, pass: 0.82 } }),
    bounds: Object.freeze({ liveness: { rejectMin: 0.5, passMax: 0.99 }, faceMatch: { rejectMin: 0.5, passMax: 0.99 } })
  }),
  onnx: Object.freeze({
    defaults: Object.freeze({ liveness: { reject: 0.5, pass: 0.65 }, faceMatch: { reject: 0.28, pass: 0.42 } }),
    bounds: Object.freeze({ liveness: { rejectMin: 0.3, passMax: 0.99 }, faceMatch: { rejectMin: 0.15, passMax: 0.9 } })
  })
});

/** Per-tenant retention policy defaults + platform bounds (PRD §15.4). */
const DEFAULT_RETENTION = Object.freeze({
  rawEvidenceDays: 30,   // raw selfie/ID images after capture
  failedSessionDays: 7   // evidence of failed/abandoned/expired sessions
});

const RETENTION_BOUNDS = Object.freeze({
  rawEvidenceDays: { min: 7, max: 365 },
  failedSessionDays: { min: 1, max: 30 }
});

const SESSION_STATUSES = Object.freeze([
  "created", "started", "submitted", "approved", "rejected",
  "manual_review", "expired", "failed", "abandoned"
]);

const WEBHOOK_EVENTS = Object.freeze([
  "verification.created", "verification.started", "verification.submitted",
  "verification.approved", "verification.rejected", "verification.manual_review",
  "verification.expired", "verification.failed"
]);

const DOCUMENT_TYPES = Object.freeze([
  "NIN_SLIP", "PASSPORT", "DRIVERS_LICENSE", "VOTERS_CARD"
]);

module.exports = {
  REASON_CODES,
  DEFAULT_THRESHOLDS,
  THRESHOLD_BOUNDS,
  THRESHOLD_PROFILES,
  DEFAULT_RETENTION,
  RETENTION_BOUNDS,
  SESSION_STATUSES,
  WEBHOOK_EVENTS,
  DOCUMENT_TYPES
};
