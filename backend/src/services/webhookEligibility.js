"use strict";

// Bind each verification event to the stored liveness result for its attempt.
// ID_ONLY and reviewable results have no automatic verification event.
async function hasLivenessStatus(db, sessionId, attemptId, expectedStatus) {
  const result = await db.verificationResult.findFirst({
    where: {
      sessionId,
      ...(attemptId
        ? { attemptId }
        : { OR: [{ attemptId: null }, { attemptId: { isSet: false } }] })
    },
    orderBy: { createdAt: "desc" }
  });
  return result?.livenessStatus === expectedStatus;
}

module.exports = { hasLivenessStatus };
