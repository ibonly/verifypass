"use strict";

// Pluggable evidence object storage — the keystone for Lambda/ECS/split
// deployments (any topology where the API and worker don't share a disk).
//
//   EVIDENCE_BACKEND=local  (default) — encrypted files on the local disk,
//                            exactly the original behavior. Right for the
//                            dev stack, single-VPS and cPanel deployments.
//   EVIDENCE_BACKEND=s3     — encrypted objects in any S3-compatible store
//                            (AWS S3, Cloudflare R2, Backblaze B2). Required
//                            for Lambda (no persistent disk) and for running
//                            API and worker on separate machines.
//
// Storage paths are self-describing URIs, so MIXED estates work: rows written
// under the local backend keep their filesystem paths and remain readable
// after the switch — reads dispatch on the path scheme, not on the env.
//
// Encryption is OURS (AES-256-GCM in evidenceStore) and happens before the
// bytes reach any backend — S3-compatible providers only ever see ciphertext,
// which keeps the NDPA story identical across backends. SSE on the bucket is
// defense-in-depth, not the primary control.
//
// @aws-sdk/client-s3 is an optional dependency, lazy-required so local-mode
// deployments and the test suite never need it installed.

const fs = require("fs/promises");

const S3_SCHEME = "s3://";

function backend() {
  return (process.env.EVIDENCE_BACKEND || "local").toLowerCase();
}

function s3Settings() {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error("EVIDENCE_BACKEND=s3 requires S3_BUCKET");
  return {
    bucket,
    region: process.env.S3_REGION || "us-east-1",
    // Non-AWS S3-compatibles (R2, B2, MinIO) set an explicit endpoint
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true"
  };
}

let s3Client = null;
let s3Sdk = null;

function getSdk() {
  if (!s3Sdk) {
    try {
      s3Sdk = require("@aws-sdk/client-s3");
    } catch {
      throw new Error("EVIDENCE_BACKEND=s3 requires @aws-sdk/client-s3 (npm i @aws-sdk/client-s3)");
    }
  }
  return s3Sdk;
}

function getClient() {
  if (!s3Client) {
    const { S3Client } = getSdk();
    const { region, endpoint, forcePathStyle } = s3Settings();
    s3Client = new S3Client({ region, ...(endpoint ? { endpoint, forcePathStyle } : {}) });
  }
  return s3Client;
}

/** TEST-ONLY: inject a fake S3 client + command constructors. */
function __setTestClient(client, sdk) {
  s3Client = client;
  s3Sdk = sdk || {
    PutObjectCommand: function (input) { this.input = input; this._type = "put"; },
    GetObjectCommand: function (input) { this.input = input; this._type = "get"; },
    DeleteObjectCommand: function (input) { this.input = input; this._type = "delete"; }
  };
}

function isRemote(storagePath) {
  return typeof storagePath === "string" && storagePath.startsWith(S3_SCHEME);
}

function parseRemote(storagePath) {
  const rest = storagePath.slice(S3_SCHEME.length);
  const slash = rest.indexOf("/");
  return { bucket: rest.slice(0, slash), key: rest.slice(slash + 1) };
}

async function bodyToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (typeof body.transformToByteArray === "function") {
    return Buffer.from(await body.transformToByteArray());
  }
  // stream fallback
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Persist an (already encrypted) buffer under the configured backend.
 * @param {string} key logical object key, e.g. "tnt_x/vps_y/selfie_...enc"
 * @param {Buffer} buffer ciphertext
 * @param {string} localPath absolute filesystem path used by the local backend
 * @returns {string} storagePath to record on the evidence row
 */
async function writeStored(key, buffer, { localPath } = {}) {
  if (backend() === "s3") {
    const { bucket } = s3Settings();
    const { PutObjectCommand } = getSdk();
    await getClient().send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: "application/octet-stream"
    }));
    return `${S3_SCHEME}${bucket}/${key}`;
  }
  if (!localPath) throw new Error("local storage backend requires localPath");
  await fs.writeFile(localPath, buffer, { mode: 0o600 });
  return localPath;
}

/** Read stored ciphertext — dispatches on the path scheme, not the env. */
async function readStored(storagePath) {
  if (isRemote(storagePath)) {
    const { bucket, key } = parseRemote(storagePath);
    const { GetObjectCommand } = getSdk();
    const out = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return bodyToBuffer(out.Body);
  }
  return fs.readFile(storagePath);
}

/** Delete stored ciphertext. Returns false when already gone (idempotent). */
async function removeStored(storagePath) {
  if (isRemote(storagePath)) {
    const { bucket, key } = parseRemote(storagePath);
    const { DeleteObjectCommand } = getSdk();
    await getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return true; // S3 deletes are idempotent — no existence signal
  }
  try {
    await fs.unlink(storagePath);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

module.exports = {
  storageBackend: backend,
  isRemote,
  writeStored,
  readStored,
  removeStored,
  __setTestClient
};
