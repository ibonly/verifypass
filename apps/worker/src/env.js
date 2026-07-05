"use strict";

// Loads environment from the repo-root .env (single source of truth) for the
// worker process. In production the file is absent and real env vars are used.

const path = require("path");

try {
  require("dotenv").config({ path: path.resolve(__dirname, "../../../.env") });
} catch (_) {
  // dotenv not installed — rely on real env vars.
}

module.exports = {};
