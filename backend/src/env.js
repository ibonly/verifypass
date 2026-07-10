"use strict";

// Loads environment from the repo-root .env (single source of truth) so the
// API behaves the same whether started via `npm run dev -w backend` (cwd =
// backend) or from the repo root. In production (cPanel/Passenger) the .env
// file is absent and real environment variables are used untouched — dotenv
// never overrides variables that are already set.

const path = require("path");

try {
  require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
} catch (_) {
  // dotenv not installed (e.g. minimal prod image) — rely on real env vars.
}

module.exports = {};
