"use strict";

// One error shape for every SDK callback: `code` is stable and safe to branch
// on, `message` is human-readable, `cause` keeps the original (DOMException,
// TypeError, ...) for debugging.

class VerifyPassError extends Error {
  constructor(code, message, { cause, http } = {}) {
    super(message);
    this.code = code;
    if (http !== undefined) this.http = http;
    if (cause !== undefined) this.cause = cause;
  }
}

// getUserMedia DOMException names → SDK codes.
const CAMERA_ERROR_CODES = Object.freeze({
  NotAllowedError: "CAMERA_PERMISSION_DENIED",
  PermissionDeniedError: "CAMERA_PERMISSION_DENIED",
  SecurityError: "CAMERA_PERMISSION_DENIED",
  NotFoundError: "CAMERA_NOT_FOUND",
  DevicesNotFoundError: "CAMERA_NOT_FOUND",
  OverconstrainedError: "CAMERA_NOT_FOUND",
  NotReadableError: "CAMERA_IN_USE",
  TrackStartError: "CAMERA_IN_USE"
});

/**
 * Normalise anything thrown inside the SDK into a VerifyPassError.
 * Errors that already carry a string `code` (API errors, CAMERA_UNSUPPORTED)
 * keep it; camera DOMExceptions are mapped when `camera` is set; fetch
 * failures become NETWORK_ERROR; everything else gets `fallbackCode`.
 */
function toVerifyPassError(err, fallbackCode = "UNKNOWN_ERROR", { camera = false } = {}) {
  if (err instanceof VerifyPassError) return err;
  const message = (err && err.message) || String(err || "Unknown error");
  const name = err && err.name;
  let code;
  if (err && typeof err.code === "string" && err.code) code = err.code;
  else if (camera && CAMERA_ERROR_CODES[name]) code = CAMERA_ERROR_CODES[name];
  else if (name === "TypeError" && /fetch|network|load failed/i.test(message)) code = "NETWORK_ERROR";
  else code = fallbackCode;
  return new VerifyPassError(code, message, { cause: err, http: err && typeof err.http === "number" ? err.http : undefined });
}

module.exports = { VerifyPassError, toVerifyPassError, CAMERA_ERROR_CODES };
