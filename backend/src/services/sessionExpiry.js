"use strict";

const { transaction } = require("./atomic");

function isSessionOverdue(session, now = new Date()) {
  return ["created", "started"].includes(session.status)
    && !!session.expiresAt && new Date(session.expiresAt) <= now;
}

function effectiveSessionStatus(session, now = new Date()) {
  return isSessionOverdue(session, now) ? "expired" : session.status;
}

async function expireSessions(db, { now = new Date(), take = 200 } = {}) {
  const sessions = await db.verificationSession.findMany({
    where: { status: { in: ["created", "started"] }, expiresAt: { lte: now } },
    orderBy: { expiresAt: "asc" }, take
  });
  let expired = 0;
  for (const session of sessions) {
    const snapshot = { ...session };
    const committed = await transaction(db, async tx => {
      const changed = await tx.verificationSession.updateMany({
        where: {
          id: snapshot.id, status: snapshot.status, expiresAt: { lte: now },
          ...(snapshot.attemptId ? { attemptId: snapshot.attemptId } : { OR: [{ attemptId: null }, { attemptId: { isSet: false } }] })
        },
        data: { status: "expired", completedAt: now, updatedAt: now, revision: { increment: 1 }, decisionReason: { reasonCodes: ["SESSION_EXPIRED"] } }
      });
      if (!changed.count) return false;
      await tx.auditLog.create({ data: {
        tenantId: snapshot.tenantId, sessionId: snapshot.id, actorType: "system", action: "session.expired",
        metadata: { attemptId: snapshot.attemptId || null, previousStatus: snapshot.status, expiresAt: new Date(snapshot.expiresAt).toISOString() },
        riskEvent: false
      } });
      return true;
    });
    if (committed) expired++;
  }
  return expired;
}

module.exports = { expireSessions, effectiveSessionStatus, isSessionOverdue };