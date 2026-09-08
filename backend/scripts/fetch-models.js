"use strict";

// Fetch the MIT-licensed Faceplugin ONNX models into backend/models/.
// These power the server-side ONNX provider (no license/activation, no Docker).
//
//   node scripts/fetch-models.js
//
// Source: https://github.com/Faceplugin-ltd/FaceRecognition-LivenessDetection-Javascript (MIT)

const fs = require("fs");
const path = require("path");
const https = require("https");

const BASE = "https://raw.githubusercontent.com/Faceplugin-ltd/FaceRecognition-LivenessDetection-Javascript/main/model";
const crypto = require("crypto");
const MANIFEST = require("./model-manifest.json");
const checksum = p => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const OUT_DIR = path.resolve(__dirname, "../models");

// Required by the ONNX provider; eye/expression/age/gender are optional extras.
const MODELS = [
  "fr_detect.onnx",
  "fr_landmark.onnx",
  "fr_liveness.onnx",
  "fr_pose.onnx",
  "fr_feature.onnx"
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close(); fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close(); fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
    }).on("error", (err) => { fs.unlink(dest, () => reject(err)); });
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const name of MODELS) {
    const dest = path.join(OUT_DIR, name);
    if (fs.existsSync(dest) && checksum(dest) === MANIFEST[name]) {
      console.log(`✓ ${name} (already present)`);
      continue;
    }
    process.stdout.write(`↓ ${name} … `);
    const partial = `${dest}.${process.pid}.partial`;
    try {
      await download(`${BASE}/${name}`, partial);
      if (!MANIFEST[name] || checksum(partial) !== MANIFEST[name]) throw new Error(`Unrecognized model checksum: ${name}`);
      fs.renameSync(partial, dest);
    } finally { if (fs.existsSync(partial)) fs.unlinkSync(partial); }
    console.log(`${(fs.statSync(dest).size / 1024).toFixed(0)} KB`);
  }
  console.log(`\nModels ready in ${OUT_DIR}`);
  console.log("Set VP_PROVIDER=onnx (default) to use the server-side ONNX provider.");
}

main().catch((err) => { console.error("fetch failed:", err.message); process.exit(1); });
