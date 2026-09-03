"use strict";

// Capture upload handling (PRD §12.3/§12.4).
// Uploads arrive as base64 JSON from the SDK (multipart can be added later
// without changing this service). Validation is defense-in-depth: the SDK
// pre-checks quality, but the server never trusts the client.

const { AppError, CHALLENGE_ACTIONS } = require("@verifypass/shared");
const { verifySdkToken } = require("./sessionService");

// sharp is required in production; in dev environments where its native
// binary can't load (cross-OS node_modules, CI sandboxes) we fall back to a
// JPEG-only passthrough so the stack stays runnable end-to-end.
let sharp = null;
try {
  sharp = require("sharp");
} catch (err) {
  if (process.env.NODE_ENV === "production") throw err;
  console.warn("uploadService: sharp unavailable — DEV JPEG passthrough (no sanitization). Do not use in production.");
}
const { saveEvidence } = require("./evidenceStore");
const { uploadEvidenceImage } = require("./cloudinaryService");

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MIN_IMAGE_BYTES = 1024;

// FV-3: per-session upload budgets. A valid session token must not be able to
// enqueue unbounded evidence — every frame is decrypted, run through liveness
// inference, and (optionally) mirrored to Cloudinary during verification, so an
// unbounded frame count is a worker-compute + third-party-cost DoS. These caps
// sit well above what an honest capture flow produces (a few frames per action).
const MAX_EVIDENCE_PER_SESSION = Number(process.env.MAX_EVIDENCE_PER_SESSION || 40);
const MAX_LIVENESS_FRAMES_PER_ACTION = Number(process.env.MAX_LIVENESS_FRAMES_PER_ACTION || 6);
const MAX_SELFIES_PER_SESSION = Number(process.env.MAX_SELFIES_PER_SESSION || 8);

const MAGIC = [
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { type: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { type: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46], extra: (b) => b.length > 11 && b.toString("ascii", 8, 12) === "WEBP" }
];

/** Sniff real content type from magic bytes — never trust declared MIME. */
function sniffImageType(buffer) {
  for (const m of MAGIC) {
    if (buffer.length >= m.bytes.length && m.bytes.every((v, i) => buffer[i] === v)) {
      if (m.extra && !m.extra(buffer)) continue;
      return m.type;
    }
  }
  return null;
}

function decodeImage(imageBase64) {
  if (typeof imageBase64 !== "string" || !imageBase64) {
    throw new AppError("VALIDATION_ERROR", "imageBase64 is required");
  }
  // Allow data-URL prefix from naive clients
  const b64 = imageBase64.replace(/^data:image\/[a-z+]+;base64,/, "");
  // Buffer.from(str, "base64") never throws — it silently drops invalid chars.
  // Validate explicitly: re-encode and compare to catch malformed input.
  const buffer = Buffer.from(b64, "base64");
  if (buffer.length === 0 && b64.length > 0) {
    throw new AppError("VALIDATION_ERROR", "imageBase64 is not valid base64");
  }
  if (buffer.length < MIN_IMAGE_BYTES) throw new AppError("VALIDATION_ERROR", "image too small to be a real capture");
  if (buffer.length > MAX_IMAGE_BYTES) throw new AppError("VALIDATION_ERROR", `image exceeds ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit`);
  const contentType = sniffImageType(buffer);
  if (!contentType) throw new AppError("VALIDATION_ERROR", "unsupported image format (jpeg/png/webp only)");
  return { buffer, contentType };
}

async function sanitizeImage(buffer) {
  if (!sharp) {
    // dev fallback (never reached in production — see require guard above)
    if (sniffImageType(buffer) !== "image/jpeg") {
      throw new AppError("VALIDATION_ERROR", "dev image pipeline accepts JPEG only (sharp unavailable)");
    }
    return { buffer, contentType: "image/jpeg" };
  }
  try {
    const sanitized = await sharp(buffer, { failOn: "warning", limitInputPixels: 24_000_000 })
      .rotate()
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer();
    if (sanitized.length > MAX_IMAGE_BYTES) {
      throw new AppError("VALIDATION_ERROR", `sanitized image exceeds ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit`);
    }
    return { buffer: sanitized, contentType: "image/jpeg" };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("VALIDATION_ERROR", "image could not be decoded safely");
  }
}

const UPLOAD_KINDS = {
  document: { fileTypes: { front: "id_front", back: "id_back" }, nextStatus: "started" },
  face: { fileTypes: { selfie: "selfie", frame: "liveness_frame" }, nextStatus: "started" },
  liveness: { fileTypes: { frame: "liveness_frame" }, nextStatus: "started" }
};

/**
 * Validate token + session state, store encrypted evidence, advance status.
 * @param {"document"|"face"|"liveness"} kind
 */
async function handleUpload({ scopedDb, tenantUid, sessionUid, sdkToken, kind, side, action, imageBase64, evidenceDir, retentionDays }) {
  const spec = UPLOAD_KINDS[kind];
  if (!spec) throw new AppError("VALIDATION_ERROR", "unknown upload kind");

  const session = await scopedDb.sessions.findByUid(sessionUid);
  if (!session) throw new AppError("SESSION_NOT_FOUND");

  if (!sdkToken || !session.sdkTokenHash || !verifySdkToken(sessionUid, sdkToken, session.sdkTokenHash)) {
    throw new AppError("INVALID_API_KEY", "invalid SDK token for this session");
  }

  if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
    await scopedDb.sessions.update(sessionUid, { status: "expired" });
    throw new AppError("SESSION_EXPIRED");
  }
  if (!["created", "started"].includes(session.status)) {
    throw new AppError("VALIDATION_ERROR", `cannot upload to a session in status '${session.status}'`);
  }

  // NDPA: no biometric processing without recorded consent. Enforced in
  // production (config.requireConsent); the SDK records consent at its
  // consent screen before any capture, so legitimate flows never hit this.
  const config = require("../config");
  if (config.requireConsent && !session.consentAt) {
    throw new AppError("VALIDATION_ERROR", "consent has not been recorded for this session (POST /consent first)");
  }

  // Liveness challenge frames are tagged with the action they capture.
  let label = null;
  if (kind === "liveness") {
    if (!action || !CHALLENGE_ACTIONS.includes(action)) {
      throw new AppError("VALIDATION_ERROR", `liveness frame requires a valid action (${CHALLENGE_ACTIONS.join(", ")})`);
    }
    label = action;
  }

  const sideKey = side || (kind === "document" ? "front" : "frame" in spec.fileTypes && kind === "liveness" ? "frame" : "selfie");
  const fileType = spec.fileTypes[sideKey];
  if (!fileType) throw new AppError("VALIDATION_ERROR", `invalid side '${sideKey}' for ${kind} upload`);

  // FV-3: enforce per-session / per-action upload budgets before doing the
  // expensive decode + sanitize + encrypt + Cloudinary work.
  const existing = await scopedDb.evidence.listForSession(session.id);
  if (existing.length >= MAX_EVIDENCE_PER_SESSION) {
    throw new AppError("VALIDATION_ERROR", `evidence upload limit reached for this session (max ${MAX_EVIDENCE_PER_SESSION})`);
  }
  if (fileType === "liveness_frame") {
    const forAction = existing.filter((e) => e.fileType === "liveness_frame" && e.label === label).length;
    if (forAction >= MAX_LIVENESS_FRAMES_PER_ACTION) {
      throw new AppError("VALIDATION_ERROR", `too many liveness frames for action '${label}' (max ${MAX_LIVENESS_FRAMES_PER_ACTION})`);
    }
  } else if (fileType === "selfie") {
    const selfies = existing.filter((e) => e.fileType === "selfie").length;
    if (selfies >= MAX_SELFIES_PER_SESSION) {
      throw new AppError("VALIDATION_ERROR", `too many selfie captures for this session (max ${MAX_SELFIES_PER_SESSION})`);
    }
  }

  const decoded = decodeImage(imageBase64);
  const sanitized = await sanitizeImage(decoded.buffer);

  const stored = await saveEvidence({
    tenantUid,
    sessionUid,
    fileType,
    buffer: sanitized.buffer,
    retentionDays,
    baseDir: evidenceDir
  });

  // Best-effort Cloudinary mirror for visual review/comparison. The filename
  // reflects the required action (e.g. liveness_smile_...). Never blocks the
  // verification if Cloudinary is unconfigured or the upload fails.
  const cloud = await uploadEvidenceImage({
    tenantUid,
    sessionUid,
    fileType,
    label,
    buffer: sanitized.buffer
  });

  await scopedDb.evidence.create({
    sessionId: session.id,
    fileType,
    label,
    storagePath: stored.storagePath,
    checksum: stored.checksum,
    encrypted: true,
    retentionExpiresAt: stored.retentionExpiresAt,
    cloudinaryUrl: cloud?.url || null,
    cloudinaryPublicId: cloud?.publicId || null
  });

  if (session.status === "created") {
    await scopedDb.sessions.update(sessionUid, { status: spec.nextStatus });
  }

  return {
    success: true,
    sessionId: sessionUid,
    fileType,
    label,
    contentType: sanitized.contentType,
    originalContentType: decoded.contentType,
    checksum: stored.checksum,
    sizeBytes: sanitized.buffer.length,
    cloudinaryUrl: cloud?.url || null,
    cloudinaryPublicId: cloud?.publicId || null
  };
}

module.exports = { handleUpload, decodeImage, sanitizeImage, sniffImageType, MAX_IMAGE_BYTES };
