"use strict";
const { transaction } = require("./atomic");
const { cleanupEvidence } = require("./cleanupEvidence");
// Claims stale staging records before deleting external objects. API commits
// consume a pending staging record in the same transaction as the evidence
// row, so reconciliation and successful capture cannot both win.
async function reconcileEvidence(db, now = new Date()) {
  const cutoff = new Date(now.getTime() - 30 * 60000);
  const rows = await db.evidenceStaging.findMany({ where: { createdAt: { lt: cutoff } }, take: 100 });
  let cleaned = 0;
  for (const row of rows) {
    const claimed = await transaction(db, async tx => {
      const current = await tx.evidenceStaging.findFirst({ where: { id: row.id } });
      if (!current) return false;
      if (await tx.evidenceFile.findFirst({ where: { storagePath: row.storagePath } })) {
        await tx.evidenceStaging.delete({ where: { id: row.id } });
        return false;
      }
      await tx.evidenceStaging.update({ where: { id: row.id }, data: { status: "cleaning" } });
      return true;
    });
    if (!claimed) continue;
    try {
      await cleanupEvidence(row);
      await db.evidenceStaging.deleteMany({ where: { id: row.id, status: "cleaning" } });
      cleaned++;
    } catch (error) { console.error("EVIDENCE_RECONCILIATION_RETRY", { id: row.id, error: error.message }); }
  }
  return { cleaned };
}
module.exports = { reconcileEvidence };
