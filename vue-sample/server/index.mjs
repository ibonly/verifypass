// Minimal production server: serves the built Vue app from dist/ and mounts
// the server-side VerifyPass session API on /api. Run `npm run build` first.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createVerifyPassApi } from "./verifypassApi.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");

try { process.loadEnvFile(path.join(root, ".env")); } catch { /* .env is optional */ }

const port = Number(process.env.PORT) || 8080;
const api = createVerifyPassApi(process.env);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream"
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(self)"
};

async function serveStatic(req, res) {
  const { pathname } = new URL(req.url, "http://localhost");
  let file = path.normalize(path.join(distDir, decodeURIComponent(pathname)));
  if (!file.startsWith(distDir + path.sep) && file !== distDir) {
    res.writeHead(400).end();
    return;
  }

  let info = await stat(file).catch(() => null);
  if (info?.isDirectory()) {
    file = path.join(file, "index.html");
    info = await stat(file).catch(() => null);
  }
  if (!info) {
    // SPA fallback for extension-less routes only; never rewrite a missing
    // model/WASM/asset request to HTML.
    if (path.extname(pathname)) {
      res.writeHead(404, SECURITY_HEADERS).end("Not found");
      return;
    }
    file = path.join(distDir, "index.html");
  }

  const ext = path.extname(file);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache"
  });
  createReadStream(file).pipe(res);
}

http.createServer((req, res) => {
  api(req, res, () => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    serveStatic(req, res).catch(() => { if (!res.headersSent) res.writeHead(500).end(); });
  });
}).listen(port, () => {
  console.log(`VerifyPass Vue sample listening on http://localhost:${port}`);
  if (!process.env.VERIFYPASS_SECRET_KEY) console.warn("Warning: VERIFYPASS_SECRET_KEY is not set; session creation will fail.");
});
