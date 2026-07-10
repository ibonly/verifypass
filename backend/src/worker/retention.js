"use strict";

// Per-tenant retention enforcement (Phase 2, PRD §15.4).
// Evidence of failed/abandoned/expired sessions must not linger for the full
// raw-evidence window: cap its retention to the tenant's failedSessionDays,
// measured from when the session ended. The normal delete phase of
// retention_cleanup then removes it.

const { DEFAULT_RETENTION } = require("@verifypass/shared");

const DAY_MS = 24 * 3600 * 1000;
const DEAD_STATUSES = ["failed", "abandoned", "expired"];

async function capFailedSessionRetention(db, now = new Date()) {
  const tenants = await db.tenant.findMany({});
  let capped = 0;

  for (const tenant of tenants) {
    const policy = { ...DEFAULT_RETENTION, ...((tenant.settings || {}).retention || {}) };
    const sessions = await db.verificationSession.findMany({
      where: { tenantId: tenant.id, status: { in: DEAD_STATUSES } }
    });
    for (const session of sessions) {
      const endedAt = session.completedAt || session.updatedAt || now;
      const cap = new Date(new Date(endedAt).getTime() + policy.failedSessionDays * DAY_MS);
      const res = await db.evidenceFile.updateMany({
        where: { sessionId: session.id, retentionExpiresAt: { gt: cap } },
        data: { retentionExpiresAt: cap }
      });
      capped += res.count;
    }
  }
  return capped;
}

module.exports = { capFailedSessionRetention, DEAD_STATUSES };
