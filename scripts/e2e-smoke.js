"use strict";

// End-to-end smoke test against a RUNNING stack (real API + MySQL + worker).
//
//   BASE=http://localhost:3010 SECRET=vp_sec_test_xxx node scripts/e2e-smoke.js
//
// Drives the full integration path a real client uses:
//   create session → upload ID → upload selfie → verify → poll → fetch result
//
// Images are generated with sharp (real JPEGs), so they pass server-side
// magic-byte + re-encode sanitization. Final scoring requires the Faceplugin
// containers to be running + licensed; without them the worker fails closed
// and the session ends "failed" (which still proves the real pipeline runs —
// no stubs, no mock data).

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const fs = require("fs");
const sharp = require("sharp");

const BASE = process.env.BASE || `http://localhost:${process.env.PORT || 3000}`;

function readSecret() {
  if (process.env.SECRET) return process.env.SECRET;
  const credFile = path.resolve(__dirname, "../.dev-credentials.json");
  if (fs.existsSync(credFile)) return JSON.parse(fs.readFileSync(credFile, "utf8")).secretKey;
  throw new Error("Set SECRET=vp_sec_... or run scripts/setup-inhouse.js first");
}

async function api(pathname, { method = "GET", body, bearer } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${pathname} → HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function jpegBase64(tint) {
  const buf = await sharp({
    create: { width: 480, height: 640, channels: 3, background: tint }
  })
    // add noise so it survives the >1KB minimum after compression
    .composite([{ input: Buffer.from(new Array(480 * 640 * 3).fill(0).map(() => Math.floor(Math.random() * 255))), raw: { width: 480, height: 640, channels: 3 } }])
    .jpeg({ quality: 92 })
    .toBuffer();
  return buf.toString("base64");
}

async function main() {
  const secret = readSecret();
  console.log(`[e2e] BASE=${BASE}`);

  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  console.log(`[e2e] health: ${JSON.stringify(health)}`);

  const session = await api("/v1/verification-sessions", {
    method: "POST", bearer: secret, body: { customerReference: `E2E-${Date.now()}` }
  });
  const id = session.sessionId;
  const sdkToken = session.sdkToken;
  console.log(`[e2e] created session ${id}`);

  await api(`/v1/verification-sessions/${id}/document`, {
    method: "POST", body: { sdkToken, side: "front", imageBase64: await jpegBase64({ r: 30, g: 60, b: 120 }) }
  });
  console.log("[e2e] uploaded ID document");

  // Active-liveness challenge: upload one frame per server-issued action.
  const actions = Array.isArray(session.livenessChallenge?.actions) ? session.livenessChallenge.actions : [];
  for (const action of actions) {
    await api(`/v1/verification-sessions/${id}/liveness-frame`, {
      method: "POST", body: { sdkToken, action, imageBase64: await jpegBase64({ r: 200, g: 170, b: 150 }) }
    });
  }
  console.log(`[e2e] uploaded ${actions.length} liveness frame(s): ${actions.join(", ") || "(none)"}`);

  await api(`/v1/verification-sessions/${id}/face`, {
    method: "POST", body: { sdkToken, imageBase64: await jpegBase64({ r: 200, g: 170, b: 150 }) }
  });
  console.log("[e2e] uploaded selfie");

  await api(`/v1/verification-sessions/${id}/verify`, { method: "POST", body: { sdkToken } });
  console.log("[e2e] submitted for verification");

  const terminal = ["approved", "rejected", "manual_review", "failed", "expired"];
  let status = "submitted";
  for (let i = 0; i < 30 && !terminal.includes(status); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const s = await api(`/v1/verification-sessions/${id}/status?sdkToken=${encodeURIComponent(sdkToken)}`);
    status = s.status;
    process.stdout.write(`\r[e2e] status: ${status}   `);
  }
  process.stdout.write("\n");

  const result = await api(`/v1/verification-sessions/${id}/result`, { bearer: secret });
  console.log("[e2e] final result:");
  console.log(JSON.stringify(result, null, 2));

  if (status === "failed") {
    console.log("\n[e2e] NOTE: 'failed' is expected when the Faceplugin containers are not running/licensed.");
    console.log("      Start them (deploy/faceplugin-compose.yml) for real approved/rejected/manual_review outcomes.");
  }
}

main().catch((err) => { console.error("\n[e2e] FAILED:", err.message); process.exit(1); });
