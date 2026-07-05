"use strict";

// One-off: prove Cloudinary upload works end-to-end through the real API.
// Creates a session with the secret key, then uploads one liveness frame with
// a genuine JPEG and prints whether a cloudinaryUrl came back.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const API = process.env.PROBE_API || "http://localhost:3000";
const SECRET = process.env.PROBE_SECRET || "vp_sec_test_TKs49O7wwg0Vycqa3hu0m0ltLyt58ye3";
const PUBLIC = process.env.PROBE_PUBLIC || "vp_pub_test_Txw0Q8jHGIHVpkn3M6mra8mGFS0Q5g4m";

async function main() {
  const sharp = require("sharp");
  // A real, sanitizable JPEG (solid color, big enough to pass MIN_IMAGE_BYTES).
  const jpeg = await sharp({
    create: { width: 480, height: 480, channels: 3, background: { r: 120, g: 90, b: 70 } }
  }).jpeg({ quality: 90 }).toBuffer();
  const base64 = `data:image/jpeg;base64,${jpeg.toString("base64")}`;

  const sessionRes = await fetch(`${API}/v1/verification-sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ customerReference: `CLOUD-PROBE-${Date.now()}`, verificationType: "FACE_ONLY" })
  });
  const session = await sessionRes.json();
  if (!sessionRes.ok) throw new Error(`session create failed: ${JSON.stringify(session)}`);
  const action = session.livenessChallenge?.actions?.[0] || "blink";
  console.log("session:", session.sessionId, "action:", action);

  const upRes = await fetch(`${API}/v1/verification-sessions/${session.sessionId}/liveness-frame`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PUBLIC}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sdkToken: session.sdkToken, action, imageBase64: base64 })
  });
  const up = await upRes.json();
  console.log("upload status:", upRes.status);
  console.log("upload result:", JSON.stringify(up, null, 2));
  if (up.cloudinaryUrl) {
    console.log("\n✅ Cloudinary upload OK →", up.cloudinaryUrl);
  } else {
    console.log("\n❌ No cloudinaryUrl returned — check the API log for a 'cloudinaryService' warning.");
  }
}

main().catch((e) => { console.error("PROBE ERROR:", e.message); process.exit(1); });
