"use strict";
async function cleanupEvidence({ storagePath, cloudinaryPublicId }) {
  if (storagePath) await require("@verifypass/shared").storage.removeStored(storagePath);
  if (cloudinaryPublicId && !await require("./cloudinaryService").destroyEvidenceImage(cloudinaryPublicId)) throw new Error("Evidence mirror cleanup failed; retry required");
}
module.exports = { cleanupEvidence };
