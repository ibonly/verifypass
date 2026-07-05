"use strict";

// Cloudinary upload for captured evidence so reviewers can visually compare a
// liveness frame against the action it was supposed to satisfy. This is an
// OPTIONAL, best-effort mirror of the encrypted local store — uploads never
// block or fail a verification. The uploaded public_id (filename) is built from
// the required action so the asset name reflects what the user was asked to do
// (e.g. "liveness_smile_...", "liveness_turn_right_...").

const config = require("../config");

let cloudinary = null;
let configured = false;

/** Lazily require + configure the SDK. Returns the client or null if disabled. */
function getClient() {
  if (!config.cloudinary.enabled) return null;
  if (configured) return cloudinary;
  try {
    cloudinary = require("cloudinary").v2;
  } catch (err) {
    console.warn("cloudinaryService: 'cloudinary' package not installed — skipping uploads.");
    return null;
  }
  if (config.cloudinary.url) {
    // CLOUDINARY_URL is parsed automatically by config() with no args, but set
    // secure explicitly.
    cloudinary.config({ secure: true });
  } else {
    // Discrete credentials. Remove any (possibly placeholder) CLOUDINARY_URL
    // from the environment first so the SDK can't auto-pick it up and shadow
    // these values.
    delete process.env.CLOUDINARY_URL;
    cloudinary.config({
      cloud_name: config.cloudinary.cloudName,
      api_key: config.cloudinary.apiKey,
      api_secret: config.cloudinary.apiSecret,
      secure: true
    });
  }
  configured = true;
  console.log(`cloudinaryService: enabled (cloud: ${cloudinary.config().cloud_name || "?"}, folder: ${config.cloudinary.folder}).`);
  return cloudinary;
}

/** Filesystem-safe token for a Cloudinary public_id segment. */
function safeSegment(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/**
 * Build a public_id whose filename reflects the required action.
 * liveness → "liveness_<action>_<ts>"; others → "<fileType>_<ts>".
 */
function buildPublicId({ fileType, label }) {
  const ts = Date.now();
  const name = label ? `liveness_${safeSegment(label)}_${ts}` : `${safeSegment(fileType)}_${ts}`;
  return name;
}

/**
 * Upload a sanitized image buffer to Cloudinary as an AUTHENTICATED asset
 * (not publicly accessible). Delivery is via a signed URL. Best-effort: returns
 * null on any failure or when Cloudinary is not configured.
 * @returns {Promise<{url:string, publicId:string, bytes:number}|null>}
 */
async function uploadEvidenceImage({ tenantUid, sessionUid, fileType, label, buffer }) {
  const client = getClient();
  if (!client) return null;

  const folder = `${config.cloudinary.folder}/${safeSegment(tenantUid)}/${safeSegment(sessionUid)}`;
  const publicId = buildPublicId({ fileType, label });

  try {
    const result = await new Promise((resolve, reject) => {
      const stream = client.uploader.upload_stream(
        {
          resource_type: "image",
          // Biometric evidence must not be publicly reachable. "authenticated"
          // assets can only be delivered through a signed URL.
          type: "authenticated",
          folder,
          public_id: publicId,
          overwrite: false,
          // Tag with the action so review tooling can filter/compare by action.
          tags: ["verifypass", fileType, label ? `action:${label}` : "no_action"].filter(Boolean),
          context: { action: label || "", fileType, sessionUid }
        },
        (err, res) => (err ? reject(err) : resolve(res))
      );
      stream.end(buffer);
    });
    // Store a signed delivery URL (not guessable without the account secret).
    const url = signedUrl(result.public_id, { format: result.format });
    return { url, publicId: result.public_id, bytes: result.bytes };
  } catch (err) {
    console.warn(`cloudinaryService: upload failed (${fileType}${label ? `/${label}` : ""}): ${err.message}`);
    return null;
  }
}

/**
 * Build a signed delivery URL for an authenticated asset. Optionally expiring
 * when `expiresInSeconds` is provided (requires the asset to be authenticated).
 * Returns null if Cloudinary is not configured.
 */
function signedUrl(publicId, { format = "jpg", expiresInSeconds } = {}) {
  const client = getClient();
  if (!client || !publicId) return null;
  const opts = {
    resource_type: "image",
    type: "authenticated",
    secure: true,
    sign_url: true,
    format
  };
  if (expiresInSeconds) {
    opts.expires_at = Math.floor(Date.now() / 1000) + expiresInSeconds;
  }
  return client.url(publicId, opts);
}

module.exports = { uploadEvidenceImage, buildPublicId, safeSegment, signedUrl };
