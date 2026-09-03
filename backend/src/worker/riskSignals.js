"use strict";

// Suspicious attempt detection (Phase 2, PRD §14 "flag if repeated failed
// attempts exceed tenant threshold" + fraud analytics groundwork).
// All lookups are tenant-scoped: one tenant's traffic never influences
// another's risk decisions.

const HOUR_MS = 3600 * 1000;

// Known virtual-camera / injection tool label patterns (advisory — an
// attacker can rename, so a miss proves nothing; a hit is worth review).
const VIRTUAL_CAMERA_RE = /virtual|obs|manycam|snap camera|xsplit|camtwist|droidcam|iriun|epoccam|\bndi\b|vcam|screen capture|dummy|fake|emulat/i;

/**
 * @param {object} db prisma-like client
 * @param {object} session the session being verified (needs id, tenantId,
 *   customerReference, deviceFingerprint, clientIp)
 * @param {object} thresholds full resolveThresholds() output
 *   (uses .risk.* windows plus top-level .maxFailedAttempts)
 * @param {Date} [now]
 * @param {object} [opts] { env } — NODE_ENV of the worker. The device-sharing
 *   signal is DISABLED in development: every local test session comes from
 *   the same machine, so the signal is pure noise there (product decision
 *   2026-07-06). Staging/production (and unspecified env) keep it on.
 * @returns {{repeatedFailedAttempts:boolean, deviceSharedAcrossIdentities:boolean,
 *            ipVelocityExceeded:boolean, counts:object}}
 */
async function computeRiskSignals(db, session, thresholds, now = new Date(), opts = {}) {
  const t = { ...thresholds.risk, maxFailedAttempts: thresholds.maxFailedAttempts };
  const out = {
    repeatedFailedAttempts: false,
    deviceSharedAcrossIdentities: false,
    ipVelocityExceeded: false,
    virtualCameraSuspected: false,
    counts: { priorFailures: 0, deviceIdentities: 0, ipSessionsLastHour: 0 }
  };

  // 0. Capture integrity (P0): the SDK reports the active camera's label and
  //    track metadata at submit; the server ALSO re-checks the label here so a
  //    doctored client can't simply clear the client-computed flag. Absence of
  //    capture metadata is NOT flagged — direct API integrations legitimately
  //    have none. Soft signal → manual review only.
  const capture = session.deviceMeta && session.deviceMeta.capture;
  if (capture) {
    const serverLabelHit = VIRTUAL_CAMERA_RE.test(String(capture.cameraLabel || ""));
    if (capture.virtualCameraSuspected === true || serverLabelHit) {
      out.virtualCameraSuspected = true;
    }
  }

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

  // 2. Same device fingerprint across many distinct identities (identity
  //    farming). Skipped in development — one dev machine legitimately
  //    creates dozens of throwaway identities.
  if (session.deviceFingerprint && opts.env !== "development") {
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
