"use strict";

// Suspicious attempt detection (Phase 2, PRD §14 "flag if repeated failed
// attempts exceed tenant threshold" + fraud analytics groundwork).
// All lookups are tenant-scoped: one tenant's traffic never influences
// another's risk decisions.

const HOUR_MS = 3600 * 1000;

/**
 * @param {object} db prisma-like client
 * @param {object} session the session being verified (needs id, tenantId,
 *   customerReference, deviceFingerprint, clientIp)
 * @param {object} thresholds full resolveThresholds() output
 *   (uses .risk.* windows plus top-level .maxFailedAttempts)
 * @param {Date} [now]
 * @returns {{repeatedFailedAttempts:boolean, deviceSharedAcrossIdentities:boolean,
 *            ipVelocityExceeded:boolean, counts:object}}
 */
async function computeRiskSignals(db, session, thresholds, now = new Date()) {
  const t = { ...thresholds.risk, maxFailedAttempts: thresholds.maxFailedAttempts };
  const out = {
    repeatedFailedAttempts: false,
    deviceSharedAcrossIdentities: false,
    ipVelocityExceeded: false,
    counts: { priorFailures: 0, deviceIdentities: 0, ipSessionsLastHour: 0 }
  };

  // 1. Repeated failed attempts for the same customer reference
  if (session.customerReference) {
    const since = new Date(now.getTime() - t.failedAttemptsWindowHours * HOUR_MS);
    const failures = await db.verificationSession.findMany({
      where: {
        tenantId: session.tenantId,
        customerReference: session.customerReference,
        status: { in: ["rejected", "failed"] },
        createdAt: { gte: since }
      }
    });
    const prior = failures.filter((s) => s.id !== session.id);
    out.counts.priorFailures = prior.length;
    if (prior.length >= (t.maxFailedAttempts ?? 3)) out.repeatedFailedAttempts = true;
  }

  // 2. Same device fingerprint across many distinct identities (identity farming)
  if (session.deviceFingerprint) {
    const since = new Date(now.getTime() - t.deviceWindowDays * 24 * HOUR_MS);
    const rows = await db.verificationSession.findMany({
      where: {
        tenantId: session.tenantId,
        deviceFingerprint: session.deviceFingerprint,
        createdAt: { gte: since }
      }
    });
    const identities = new Set(rows.map((s) => s.customerReference).filter(Boolean));
    out.counts.deviceIdentities = identities.size;
    if (identities.size > t.maxIdentitiesPerDevice) out.deviceSharedAcrossIdentities = true;
  }

  // 3. IP velocity: bursts of sessions from one address
  if (session.clientIp) {
    const since = new Date(now.getTime() - HOUR_MS);
    const rows = await db.verificationSession.findMany({
      where: {
        tenantId: session.tenantId,
        clientIp: session.clientIp,
        createdAt: { gte: since }
      }
    });
    out.counts.ipSessionsLastHour = rows.length;
    if (rows.length > t.maxSessionsPerIpPerHour) out.ipVelocityExceeded = true;
  }

  return out;
}

module.exports = { computeRiskSignals };
