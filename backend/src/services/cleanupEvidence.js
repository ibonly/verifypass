"use strict";
async function cleanupEvidence({ storagePath, cloudinaryPublicId }) {
  if (storagePath) await require("./evidenceStore").deleteEvidence(storagePath);
  if (cloudinaryPublicId && !await require("./cloudinaryService").destroyEvidenceImage(cloudinaryPublicId)) throw new Error("Evidence mirror cleanup failed; retry required");
}
module.exports = { cleanupEvidence };
