"use strict";

// Lazy Prisma singleton. Tests replace this via setDb() so the whole API
// layer is testable without a database.
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

/** Test hook: inject a mock DB. Pass null to reset. */
function setDb(mock) {
  override = mock;
}

module.exports = { getDb, setDb };
