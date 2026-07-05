"use strict";

const { getDb } = require("../lib/db");

/** Enqueue a background job (worker polls job_queue). */
function enqueue(type, payload = {}, { runAfter = new Date(), maxAttempts = 5 } = {}) {
  return getDb().jobQueue.create({
    data: { type, payload, status: "pending", runAfter, maxAttempts }
  });
}

module.exports = { enqueue };
