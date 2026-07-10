"use strict";

const crypto = require("crypto");

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

function randomBase32(len) {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % 32];
  return out;
}

/** Sortable-ish unique id: time prefix + randomness (ULID-like, dependency-free). */
function uid(prefix) {
  const t = Date.now().toString(32).toUpperCase().padStart(9, "0");
  return `${prefix}_${t}${randomBase32(12)}`;
}

module.exports = { uid, randomBase32 };
