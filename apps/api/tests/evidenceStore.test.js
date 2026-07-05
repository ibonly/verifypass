"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const {
  saveEvidence, readEvidence, deleteEvidence,
  signEvidenceAccess, verifyEvidenceAccess
} = require("../src/services/evidenceStore");

const KEY = crypto.randomBytes(32).toString("hex");

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "vp-evidence-"));
}

test("encrypt/decrypt roundtrip preserves content, records checksum + retention", async () => {
  const dir = await tmpDir();
  const plaintext = crypto.randomBytes(50_000);

  const stored = await saveEvidence({
    tenantUid: "tnt_X", sessionUid: "vps_Y", fileType: "selfie",
    buffer: plaintext, retentionDays: 30, baseDir: dir, key: KEY
  });

  assert.ok(stored.storagePath.startsWith(path.join(dir, "tnt_X", "vps_Y")));
  assert.equal(stored.checksum, crypto.createHash("sha256").update(plaintext).digest("hex"));

  const days = (stored.retentionExpiresAt - Date.now()) / 86_400_000;
  assert.ok(days > 29.9 && days < 30.1);

  // On-disk bytes are NOT the plaintext
  const onDisk = await fs.readFile(stored.storagePath);
  assert.equal(onDisk.includes(plaintext.subarray(0, 64)), false);

  const decrypted = await readEvidence(stored.storagePath, { key: KEY });
  assert.deepEqual(decrypted, plaintext);
});

test("tampered ciphertext fails decryption (GCM auth)", async () => {
  const dir = await tmpDir();
  const stored = await saveEvidence({
    tenantUid: "t", sessionUid: "s", fileType: "id_front",
    buffer: crypto.randomBytes(5_000), baseDir: dir, key: KEY
  });

  const raw = await fs.readFile(stored.storagePath);
  raw[raw.length - 1] ^= 0xff; // flip one bit of ciphertext
  await fs.writeFile(stored.storagePath, raw);

  await assert.rejects(() => readEvidence(stored.storagePath, { key: KEY }));
});

test("wrong key fails decryption", async () => {
  const dir = await tmpDir();
  const stored = await saveEvidence({
    tenantUid: "t", sessionUid: "s", fileType: "id_front",
    buffer: crypto.randomBytes(5_000), baseDir: dir, key: KEY
  });
  await assert.rejects(() => readEvidence(stored.storagePath, { key: crypto.randomBytes(32).toString("hex") }));
});

test("deleteEvidence removes file, is idempotent", async () => {
  const dir = await tmpDir();
  const stored = await saveEvidence({
    tenantUid: "t", sessionUid: "s", fileType: "selfie",
    buffer: crypto.randomBytes(2_000), baseDir: dir, key: KEY
  });
  assert.equal(await deleteEvidence(stored.storagePath), true);
  assert.equal(await deleteEvidence(stored.storagePath), false);
});

test("signed evidence access: valid, wrong id, expired", () => {
  const { token } = signEvidenceAccess("ev_1", { secret: "s3cret" });
  assert.equal(verifyEvidenceAccess("ev_1", token, { secret: "s3cret" }), true);
  assert.equal(verifyEvidenceAccess("ev_2", token, { secret: "s3cret" }), false);
  assert.equal(verifyEvidenceAccess("ev_1", token, { secret: "other" }), false);

  const expired = signEvidenceAccess("ev_1", { ttlSeconds: -10, secret: "s3cret" });
  assert.equal(verifyEvidenceAccess("ev_1", expired.token, { secret: "s3cret" }), false);

  assert.equal(verifyEvidenceAccess("ev_1", "garbage", { secret: "s3cret" }), false);
  assert.equal(verifyEvidenceAccess("ev_1", null, { secret: "s3cret" }), false);
});
