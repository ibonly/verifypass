"use strict";

// Lazy Prisma singleton — MySQL (DATABASE_URL) is the ONLY runtime database.
// setDb() exists exclusively for unit tests (in-memory mock, no MySQL needed);
// it refuses to run outside test/development so no environment can ever be
// switched onto a fake database by accident.
let client = null;
let override = null;

function getDb() {
  if (override) return override;
  if (!client) {
    const { PrismaClient } = require("@prisma/client");
    client = new PrismaClient();
  }
  return client;
}

/** TEST-ONLY hook: inject a mock DB. Pass null to reset. Throws in production/staging. */
function setDb(mock) {
  const env = process.env.NODE_ENV || "development";
  if (env === "production" || env === "staging") {
    throw new Error("setDb() is a test-only hook — refusing to override the database in " + env);
  }
  override = mock;
}

module.exports = { getDb, setDb };
