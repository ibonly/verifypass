// Publishes the zero-config SDK assets from the hosted verification origin:
//   /sdk-assets/ort/<version>/ort-wasm-simd-threaded.wasm  ONNX Runtime WASM the prebuilt SDKs load
//   /sdk/v1/*                                              CDN bundles of @verifypass/sdk-js (+ playground)
// Face models are already served from /models/. The WASM version must equal
// the SDK's pinned ORT_VERSION or the prebuilt SDKs would request a missing
// file — the build fails instead.
import fs from "node:fs";
import path from "node:path";

export function verifyPassSdkAssets({ root }) {
  // onnxruntime-web's exports map hides package.json; read it from disk.
  const ortDir = path.join(root, "node_modules", "onnxruntime-web");
  const ortVersion = JSON.parse(fs.readFileSync(path.join(ortDir, "package.json"), "utf8")).version;
  const assetsSrc = fs.readFileSync(path.join(root, "../sdk/react/src/assets.js"), "utf8");
  const pinned = /ORT_VERSION = "([^"]+)"/.exec(assetsSrc)?.[1];
  if (pinned !== ortVersion) {
    throw new Error(`onnxruntime-web ${ortVersion} in verify-page does not match the SDK's ORT_VERSION ${pinned}`);
  }
  const files = {
    [`sdk-assets/ort/${ortVersion}/ort-wasm-simd-threaded.wasm`]: path.join(ortDir, "dist", "ort-wasm-simd-threaded.wasm")
  };
  const sdkDist = path.join(root, "../sdk/js/dist");
  for (const name of ["verifypass.js", "verifypass-liveness.js", "element.mjs", "index.mjs"]) {
    const file = path.join(sdkDist, name);
    if (fs.existsSync(file)) files[`sdk/v1/${name}`] = file;
  }
  files["sdk/v1/playground.html"] = path.join(root, "../sdk/js/examples/playground.html");

  const types = { ".wasm": "application/wasm", ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html" };
  return {
    name: "verifypass-sdk-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || "").split("?")[0].replace(/^\//, "");
        const file = files[url];
        if (!file || !fs.existsSync(file)) return next();
        res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const [fileName, file] of Object.entries(files)) {
        if (fs.existsSync(file)) this.emitFile({ type: "asset", fileName, source: fs.readFileSync(file) });
      }
    }
  };
}
