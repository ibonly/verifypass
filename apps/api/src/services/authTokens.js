"use strict";

// Dashboard session tokens: HMAC-signed, expiring, dependency-free.
// Format: vpu_<base64url(json)>.<hmac>

const crypto = require("crypto");
const config = require("../config");

function secret() {
  return config.authTokenSecret;
}

function signToken(payload, { ttlSeconds = 8 * 3600, now = Math.floor(Date.now() / 1000) } = {}) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: now + ttlSeconds })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return `vpu_${body}.${sig}`;
}

function verifyToken(token, { now = Math.floor(Date.now() / 1000) } = {}) {
  const m = String(token || "").match(/^vpu_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const [, body, sig] = m;
  const expected = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString());
  } catch (_) {
    return null;
  }
  if (!payload.exp || payload.exp < now) return null;
  return payload;
}

module.exports = { signToken, verifyToken };
