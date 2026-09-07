"use strict";
// Retry write conflicts only; callback must contain database operations only.
async function transaction(db, fn) {
  for (let i = 0; ; i++) {
    try { return await db.$transaction(fn, { maxWait: 5000, timeout: 15000 }); }
    catch (e) { if (e.code !== "P2034" || i >= 3) throw e; }
  }
}
module.exports = { transaction };
