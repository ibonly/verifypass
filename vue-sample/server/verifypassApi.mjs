// Server-side half of the integration. This is the code that lives in YOUR
// backend: it holds the VerifyPass secret key, creates verification sessions,
// and reads server-verified results. The browser only ever receives
// { sessionId, sdkToken }.
//
// It also relays the browser widget's session-scoped /v1 calls (see
// sdkProxy.mjs) so the widget never needs a CORS grant from VerifyPass.
//
// Exposed as a plain Node (req, res, next) handler so it can run both as Vite
// dev/preview middleware and inside the production server in server/index.mjs.

import { createSdkProxy } from "./sdkProxy.mjs";

export const LIVE_TEST_API_BASE = "https://uybb6wv27prwyijtkcteovvvke0hfkqw.lambda-url.us-east-2.on.aws";

const VERIFICATION_TYPES = new Set(["ID_AND_FACE", "FACE_ONLY", "ID_ONLY"]);
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_BODY_BYTES = 4 * 1024;

export function createVerifyPassApi(env = process.env) {
  const secretKey = (env.VERIFYPASS_SECRET_KEY || "").trim();
  const apiBase = (env.VERIFYPASS_API_BASE || LIVE_TEST_API_BASE).replace(/\/+$/, "");
  const sdkProxy = createSdkProxy(apiBase);

  async function callVerifyPass(pathname, init = {}) {
    const res = await fetch(`${apiBase}${pathname}`, {
      ...init,
      headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json", ...init.headers }
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, body };
  }

  async function createSession(req, res) {
    const input = await readJson(req);
    const verificationType = VERIFICATION_TYPES.has(input.verificationType) ? input.verificationType : "ID_AND_FACE";
    // In a real app, derive the reference from your authenticated user.
    const customerReference = typeof input.customerReference === "string" && input.customerReference.trim()
      ? input.customerReference.trim().slice(0, 128)
      : `VUE-SAMPLE-${Date.now()}`;

    const upstream = await callVerifyPass("/v1/verification-sessions", {
      method: "POST",
      body: JSON.stringify({ customerReference, verificationType })
    });
    if (!upstream.ok) return sendUpstreamError(res, upstream);

    // Forward only what the browser widget needs.
    const { sessionId, sdkToken, expiresAt } = upstream.body;
    return sendJson(res, 201, { sessionId, sdkToken, expiresAt, verificationType });
  }

  async function getResult(res, sessionId) {
    // In a real app, also check that this session belongs to the signed-in user.
    const upstream = await callVerifyPass(`/v1/verification-sessions/${encodeURIComponent(sessionId)}/result`);
    if (!upstream.ok) return sendUpstreamError(res, upstream);
    return sendJson(res, 200, upstream.body);
  }

  return async function verifyPassApi(req, res, next) {
    const { pathname } = new URL(req.url, "http://localhost");
    const notFound = () => (next ? next() : sendJson(res, 404, { error: { message: "Not found" } }));
    if (pathname.startsWith("/v1/")) return sdkProxy(req, res, notFound);
    if (!pathname.startsWith("/api/")) return notFound();

    try {
      if (pathname === "/api/config" && req.method === "GET") {
        return sendJson(res, 200, { configured: Boolean(secretKey), apiBase });
      }
      if (!secretKey) {
        return sendJson(res, 503, { error: { message: "Server is missing VERIFYPASS_SECRET_KEY. Add it to vue-sample/.env and restart." } });
      }
      if (pathname === "/api/verification-sessions" && req.method === "POST") {
        return await createSession(req, res);
      }
      const match = pathname.match(/^\/api\/verification-sessions\/([^/]+)\/result$/);
      if (match && req.method === "GET") {
        if (!SESSION_ID.test(match[1])) return sendJson(res, 400, { error: { message: "Invalid session id" } });
        return await getResult(res, match[1]);
      }
      return sendJson(res, 404, { error: { message: "Not found" } });
    } catch (err) {
      const status = err.statusCode || 502;
      return sendJson(res, status, { error: { message: status === 502 ? "VerifyPass API request failed" : err.message } });
    }
  };
}

function sendUpstreamError(res, upstream) {
  const message = upstream.body?.error?.message || `VerifyPass API returned HTTP ${upstream.status}`;
  return sendJson(res, upstream.status >= 500 ? 502 : upstream.status, { error: { message } });
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch {
        reject(Object.assign(new Error("Invalid JSON body"), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}
