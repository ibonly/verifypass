"use strict";

// Storage abstraction: local fs vs S3-compatible, dispatching on the
// storagePath SCHEME so mixed estates (old local rows + new s3 rows) work.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const storage = require("../src/storage");

/** Fake S3 client: an in-memory object map keyed by bucket/key. */
function fakeS3() {
  const objects = new Map();
  return {
    objects,
    async send(cmd) {
      const { Bucket, Key, Body } = cmd.input;
      const id = `${Bucket}/${Key}`;
      if (cmd._type === "put") { objects.set(id, Buffer.from(Body)); return {}; }
      if (cmd._type === "get") {
        if (!objects.has(id)) throw new Error("NoSuchKey");
        return { Body: { transformToByteArray: async () => objects.get(id) } };
      }
      if (cmd._type === "delete") { objects.delete(id); return {}; }
      throw new Error("unknown command");
    }
  };
}

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; process.env[k] = v; }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

test("local backend: write/read/remove round-trip on disk (the default)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vp-store-"));
  const localPath = path.join(dir, "x.enc");
  const stored = await storage.writeStored("tnt/vps/x.enc", Buffer.from("cipher"), { localPath });
  assert.equal(stored, localPath, "local mode records the fs path");
  assert.equal((await storage.readStored(stored)).toString(), "cipher");
  assert.equal(await storage.removeStored(stored), true);
  assert.equal(await storage.removeStored(stored), false, "idempotent second delete");
});

test("s3 backend: writes return s3:// URIs; read/remove dispatch to the client", async () => {
  const client = fakeS3();
  storage.__setTestClient(client);
  await withEnv({ EVIDENCE_BACKEND: "s3", S3_BUCKET: "vp-evidence" }, async () => {
    const stored = await storage.writeStored("tnt_a/vps_b/selfie.enc", Buffer.from("cipher2"));
    assert.equal(stored, "s3://vp-evidence/tnt_a/vps_b/selfie.enc");
    assert.equal((await storage.readStored(stored)).toString(), "cipher2");
    await storage.removeStored(stored);
    assert.equal(client.objects.size, 0);
  });
});

test("MIXED estate: s3 env still reads OLD local-disk rows (scheme dispatch)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vp-store-"));
  const legacy = path.join(dir, "legacy.enc");
  await fs.writeFile(legacy, "old-cipher");
  storage.__setTestClient(fakeS3());
  await withEnv({ EVIDENCE_BACKEND: "s3", S3_BUCKET: "vp-evidence" }, async () => {
    assert.equal((await storage.readStored(legacy)).toString(), "old-cipher",
      "rows written before the cutover must stay readable");
  });
});

test("s3 backend without S3_BUCKET fails loudly, not mysteriously", async () => {
  await withEnv({ EVIDENCE_BACKEND: "s3", S3_BUCKET: "" }, async () => {
    await assert.rejects(() => storage.writeStored("k", Buffer.alloc(1)), /S3_BUCKET/);
  });
});
