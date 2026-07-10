"use strict";

/** Error codes per PRD §32. HTTP status attached for API responses. */
const ERROR_CODES = {
  SESSION_EXPIRED: { http: 410, message: "Verification session expired" },
  SESSION_NOT_FOUND: { http: 404, message: "Verification session not found" },
  INVALID_API_KEY: { http: 401, message: "API key invalid or revoked" },
  DOMAIN_NOT_ALLOWED: { http: 403, message: "SDK used from unauthorized domain" },
  DOCUMENT_BLURRY: { http: 422, message: "ID image too blurry" },
  DOCUMENT_GLARE_DETECTED: { http: 422, message: "ID image has glare" },
  NO_FACE_ON_DOCUMENT: { http: 422, message: "No face found on ID" },
  NO_FACE_ON_SELFIE: { http: 422, message: "No face found in selfie" },
  MULTIPLE_FACES_DETECTED: { http: 422, message: "More than one face detected" },
  LIVENESS_FAILED: { http: 422, message: "Liveness check failed" },
  FACE_MISMATCH: { http: 422, message: "Selfie does not match ID" },
  OCR_FAILED: { http: 422, message: "OCR extraction failed" },
  MANUAL_REVIEW_REQUIRED: { http: 200, message: "Case requires review" },
  WEBHOOK_FAILED: { http: 502, message: "Webhook delivery failed" },
  VALIDATION_ERROR: { http: 400, message: "Request validation failed" },
  RETRY_LIMIT_REACHED: { http: 409, message: "Maximum verification attempts reached" },
  RATE_LIMITED: { http: 429, message: "Too many requests" },
  FORBIDDEN: { http: 403, message: "Not allowed" },
  NOT_FOUND: { http: 404, message: "Resource not found" },
  INTERNAL_ERROR: { http: 500, message: "Internal server error" }
};

class AppError extends Error {
  /**
   * @param {keyof typeof ERROR_CODES} code
   * @param {string} [message] override default message
   * @param {object} [details]
   */
  constructor(code, message, details) {
    const def = ERROR_CODES[code] || ERROR_CODES.INTERNAL_ERROR;
    super(message || def.message);
    this.code = code;
    this.http = def.http;
    this.details = details;
  }
}

module.exports = { ERROR_CODES, AppError };
