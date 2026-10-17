"use strict";
// The prebuilt SDKs load ONNX Runtime's WASM from the hosted origin at a
// versioned path and verify its SHA-256. Pin, dependency and installed
// binary must agree or detection silently degrades for every integrator.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const sdk = path.join(__dirname, "..", "..");
const assets = fs.readFileSync(path.join(sdk, "react", "src", "assets.js"), "utf8");
const pinned = /ORT_VERSION = "([^"]+)"/.exec(assets)[1];
const sha = /ORT_WASM_SHA256 = "([0-9a-f]{64})"/.exec(assets)[1];

test("react and sdk-js depend on exactly the pinned onnxruntime-web", () => {
  const react = JSON.parse(fs.readFileSync(path.join(sdk, "react", "package.json"), "utf8"));
  const js = JSON.parse(fs.readFileSync(path.join(sdk, "js", "package.json"), "utf8"));
  assert.equal(react.dependencies["onnxruntime-web"], pinned);
  assert.equal(js.devDependencies["onnxruntime-web"], pinned);
});

test("installed onnxruntime-web WASM matches the pinned checksum", (t) => {
  const wasm = path.join(sdk, "react", "node_modules", "onnxruntime-web", "dist", "ort-wasm-simd-threaded.wasm");
  if (!fs.existsSync(wasm)) return t.skip("onnxruntime-web not installed");
  const version = JSON.parse(fs.readFileSync(path.join(sdk, "react", "node_modules", "onnxruntime-web", "package.json"), "utf8")).version;
  assert.equal(version, pinned);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(wasm)).digest("hex"), sha);
});
