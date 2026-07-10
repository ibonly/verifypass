"use strict";

// TOTP (RFC 6238, SHA-1, 6 digits, 30s step) — dependency-free.
// Compatible with Google Authenticator / Authy / 1Password.

const crypto = require("crypto");

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = str.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function totpAt(secretBase32, timeSeconds, { digits = 6, stepSeconds = 30 } = {}) {
  const counter = Math.floor(timeSeconds / stepSeconds);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", base32Decode(secretBase32)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits);
  return String(code).padStart(digits, "0");
}

/** Accepts current step ±1 to absorb clock drift. */
function verifyTotp(secretBase32, token, { now = Math.floor(Date.now() / 1000), stepSeconds = 30 } = {}) {
  if (!/^\d{6}$/.test(String(token || ""))) return false;
  for (const drift of [-1, 0, 1]) {
    if (totpAt(secretBase32, now + drift * stepSeconds) === String(token)) return true;
  }
  return false;
}

function otpauthUrl(secretBase32, { email, issuer = "VerifyPass" }) {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}`;
}

module.exports = { generateTotpSecret, totpAt, verifyTotp, otpauthUrl, base32Encode, base32Decode };
