"use strict";

// AWS Lambda entry for the VerifyPass API.
//
// app.js exports the Express app without listening (the Passenger pattern) —
// exactly what serverless-http needs, so the ENTIRE API (auth, tenant
// scoping, uploads, consent, retry, dashboard, reports) runs unchanged.
//
// Payload limit — READ THIS BEFORE RAISING IMAGE CAPS:
//   Lambda invocations cap request bodies at ~6MB (Function URLs and API
//   Gateway both inherit it). Uploads are base64 JSON, so the effective
//   binary image cap on this topology is ~4MB. Camera captures are far
//   smaller (~0.1–1MB JPEG); the 8MB manual-file cap only fits when the API
//   runs on a server. If larger uploads matter on Lambda, move uploads to
//   presigned S3 PUTs.
//
// Warm state (Prisma pool, tesseract, config) lives in module scope and
// survives between invocations on a warm container.

let cachedHandler = null;

function getHandler() {
  if (!cachedHandler) {
    let serverless;
    try {
      serverless = require("serverless-http");
    } catch {
      throw new Error("API Lambda entry requires serverless-http (npm i serverless-http)");
    }
    const app = require("./app");
    cachedHandler = serverless(app, {
      // evidence images stream back as binary
      binary: ["image/*", "application/pdf", "application/octet-stream"]
    });
  }
  return cachedHandler;
}

exports.handler = async (event, context) => getHandler()(event, context);
