// Same-origin pass-through for the browser widget's VerifyPass API calls.
//
// The VerifyPass API only answers CORS preflights from origins on its
// CORS_ORIGINS allowlist. Rather than requiring every integrator origin
// (including localhost dev ports) to be allowlisted, the widget is pointed at
// this app's own origin and these requests are relayed server-side.
//
// The proxy is deliberately narrow: it only relays the SDK's session-scoped
// capture routes, forwards an allowlist of headers, and NEVER adds the secret
// key. The browser's short-lived sdkToken (X-VP-SDK-Token) remains the only
// credential, exactly as if the widget called the API directly.
import http from "node:http";
import https from "node:https";

const SDK_ROUTE = /^\/v1\/verification-sessions\/[A-Za-z0-9_-]{1,128}\/[a-z][a-z/-]{0,63}$/;
const FORWARD_REQUEST_HEADERS = ["accept", "content-type", "content-length", "x-vp-sdk-token", "x-correlation-id", "user-agent"];
const FORWARD_RESPONSE_HEADERS = ["content-type", "content-length", "cache-control", "deprecation", "x-vp-deprecated", "x-correlation-id"];
// SDK uploads are base64 JPEG frames; keep a generous but bounded ceiling.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 60_000;

export function createSdkProxy(apiBase) {
  const target = new URL(apiBase);
  const transport = target.protocol === "https:" ? https : http;

  return function sdkProxy(req, res, next) {
    const { pathname, search } = new URL(req.url, "http://localhost");
    if (!pathname.startsWith("/v1/")) return next();
    if (!SDK_ROUTE.test(pathname) || !["GET", "POST"].includes(req.method) || search) {
      return sendJson(res, 404, { success: false, error: { code: "NOT_FOUND", message: "Not found" } });
    }

    const declared = Number(req.headers["content-length"] || 0);
    if (declared > MAX_UPLOAD_BYTES) {
      return sendJson(res, 413, { success: false, error: { code: "PAYLOAD_TOO_LARGE", message: "Upload too large" } });
    }

    const headers = {};
    for (const name of FORWARD_REQUEST_HEADERS) {
      if (req.headers[name] !== undefined) headers[name] = req.headers[name];
    }
    const clientIp = req.socket.remoteAddress;
    if (clientIp) headers["x-forwarded-for"] = clientIp;

    const upstream = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: req.method,
      path: `${target.pathname.replace(/\/+$/, "")}${pathname}`,
      headers,
      timeout: UPSTREAM_TIMEOUT_MS
    }, (upstreamRes) => {
      const out = { "Cache-Control": "no-store" };
      for (const name of FORWARD_RESPONSE_HEADERS) {
        if (upstreamRes.headers[name] !== undefined) out[name] = upstreamRes.headers[name];
      }
      res.writeHead(upstreamRes.statusCode || 502, out);
      upstreamRes.pipe(res);
    });

    upstream.on("timeout", () => upstream.destroy(new Error("Upstream timeout")));
    upstream.on("error", () => {
      if (!res.headersSent) sendJson(res, 502, { success: false, error: { code: "UPSTREAM_UNAVAILABLE", message: "VerifyPass API unreachable" } });
      else res.destroy();
    });

    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        upstream.destroy();
        if (!res.headersSent) sendJson(res, 413, { success: false, error: { code: "PAYLOAD_TOO_LARGE", message: "Upload too large" } });
        req.destroy();
      }
    });
    req.pipe(upstream);
  };
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}
