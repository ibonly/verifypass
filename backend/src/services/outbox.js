"use strict";
const crypto = require("crypto");
async function addOutbox(db, type, payload) {
  return db.outbox.create({ data: { type, payload, status: "pending" } });
}
// At-least-once delivery; consumers fence attempts and deduplicate outcomes.
async function flushOutbox(db, send, limit = 50) {
  const now = new Date();
  await db.outbox.deleteMany({ where: { status: "sent", createdAt: { lt: new Date(now - 7 * 86400000) } } });
  await db.outbox.updateMany({ where: { status: "sending", lockedAt: { lt: new Date(now - 60000) } }, data: { status: "pending" } });
  const rows = await db.outbox.findMany({ where: { status: "pending" }, take: limit, orderBy: { createdAt: "asc" } });
  for (const row of rows) {
    const owner = crypto.randomUUID();
    const claim = await db.outbox.updateMany({ where: { id: row.id, status: "pending" }, data: { status: "sending", owner, lockedAt: now } });
    if (!claim.count) continue;
    try {
      await send(row.type, row.payload);
      await db.outbox.updateMany({ where: { id: row.id, owner }, data: { status: "sent" } });
    } catch (_) {
      await db.outbox.updateMany({ where: { id: row.id, owner }, data: { status: "pending" } });
    }
  }
}
module.exports = { addOutbox, flushOutbox };
