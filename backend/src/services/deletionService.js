"use strict";

const { AppError, storage } = require("@verifypass/shared");
const { getDb } = require("../lib/db");
const { destroyEvidenceImage } = require("./cloudinaryService");

/**
 * Delete biometric evidence for a customer reference (PRD §12.8).
 * Removes evidence files + rows and strips extracted PII from results;
 * retains scores/decision metadata for compliance retention.
 */
async function deleteBiometricData(scopedDb, customerReference) {
  const sessions = await scopedDb.sessions.list({ customerReference });
  if (!sessions.length) throw new AppError("NOT_FOUND", "No sessions for this customer reference");

  const db = getDb();
  let filesDeleted = 0;
  for (const session of sessions) {
    const files = await db.evidenceFile.findMany({ where: { sessionId: session.id } });
    for (const file of files) {
      await storage.removeStored(file.storagePath); // fs or s3://, idempotent
      // NDPA §12.8: also remove any plaintext Cloudinary mirror
      if (file.cloudinaryPublicId) await destroyEvidenceImage(file.cloudinaryPublicId);
      await db.evidenceFile.delete({ where: { id: file.id } });
      filesDeleted++;
    }
    await db.verificationResult.updateMany({
      where: { sessionId: session.id },
      data: { extractedData: null, rawResult: null }
    });
  }
  return { sessionsAffected: sessions.length, filesDeleted };
}

module.exports = { deleteBiometricData };
