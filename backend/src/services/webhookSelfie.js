"use strict";

const sharp = require("sharp");
const { sniffImageType } = require("./uploadService");

const MAX_SELFIE_BYTES = 2 * 1024 * 1024;

// Serve the captured selfie itself when it fits. Older, larger captures are
// compressed in memory so the webhook's plain GET always meets the receiver's
// image limit without changing the evidence used for the decision.
async function prepareWebhookSelfie(bytes) {
  const type = sniffImageType(bytes);
  if (type !== "image/jpeg" && type !== "image/png") throw new Error("Webhook selfie is not JPEG or PNG");
  if (bytes.length <= MAX_SELFIE_BYTES) return { bytes, contentType: type };

  for (const width of [1600, 1200, 900]) {
    for (const quality of [80, 65, 50]) {
      const compressed = await sharp(bytes, { failOn: "warning", limitInputPixels: 24_000_000 })
        .rotate().resize({ width, withoutEnlargement: true }).jpeg({ quality, mozjpeg: true }).toBuffer();
      if (compressed.length <= MAX_SELFIE_BYTES) return { bytes: compressed, contentType: "image/jpeg" };
    }
  }
  throw new Error("Webhook selfie cannot be reduced to 2 MB");
}

module.exports = { prepareWebhookSelfie, MAX_SELFIE_BYTES };
