"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const sharp = require("sharp");
const { prepareWebhookSelfie, MAX_SELFIE_BYTES } = require("../src/services/webhookSelfie");

test("webhook selfie GET bytes are JPEG or PNG and no larger than 2 MB", async () => {
  const png = await sharp(crypto.randomBytes(1200 * 1200 * 3), { raw: { width: 1200, height: 1200, channels: 3 } })
    .png().toBuffer();
  assert.ok(png.length > MAX_SELFIE_BYTES);
  const served = await prepareWebhookSelfie(png);
  assert.equal(served.contentType, "image/jpeg");
  assert.ok(served.bytes.length <= MAX_SELFIE_BYTES);
  assert.equal((await sharp(served.bytes).metadata()).format, "jpeg");
});
