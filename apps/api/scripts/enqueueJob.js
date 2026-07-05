"use strict";

// Cron helper: node scripts/enqueueJob.js <type>
// e.g. */5 * * * *  node scripts/enqueueJob.js expire_sessions
//      0 2 * * *    node scripts/enqueueJob.js retention_cleanup

const { enqueue } = require("../src/services/jobService");
const { getDb } = require("../src/lib/db");

const ALLOWED = ["expire_sessions", "retention_cleanup"];

async function main() {
  const type = process.argv[2];
  if (!ALLOWED.includes(type)) {
    console.error(`Usage: node scripts/enqueueJob.js <${ALLOWED.join("|")}>`);
    process.exit(1);
  }
  await enqueue(type, {});
  console.log(`enqueued ${type}`);
  await getDb().$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
