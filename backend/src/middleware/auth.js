"use strict";

const { AppError } = require("@verifypass/shared");
const { resolveKey } = require("../services/apiKeyService");

/**
 * Bearer-key auth. Resolves the key to exactly one tenant and attaches
 * req.tenant / req.apiKey / req.isLive. Every downstream query MUST be
 * scoped through req.scopedDb (attached by tenantScope middleware).
 *
 * @param {"secret"|"public"} expectedType secret for server API, public for SDK endpoints
 */
function requireApiKey(expectedType = "secret") {
  return async function apiKeyAuth(req, res, next) {
    try {
      const header = req.headers.authorization || "";
      const [scheme, token] = header.split(" ");
      if (scheme !== "Bearer" || !token) throw new AppError("INVALID_API_KEY");

      const { tenant, apiKey, isLive } = await resolveKey(token, expectedType);
      req.tenant = tenant;
      req.apiKey = apiKey;
      req.isLive = isLive;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Domain allowlist check for public-key (SDK) endpoints (PRD §9.2).
 * Applied after requireApiKey("public").
 */
function requireAllowedDomain(req, res, next) {
  const origin = req.headers.origin || req.headers.referer || "";
  const allowed = Array.isArray(req.tenant?.allowedDomains) ? req.tenant.allowedDomains : [];
  if (allowed.length === 0) {
    if (req.isLive) return next(new AppError("DOMAIN_NOT_ALLOWED"));
    return next();
  }
  let host = null;
  try {
    host = new URL(origin).hostname;
  } catch (_) { /* no/invalid origin */ }
  const ok = host && allowed.some((d) => host === d || host.endsWith(`.${d}`));
  if (!ok) return next(new AppError("DOMAIN_NOT_ALLOWED"));
  next();
}

/**
 * SDK auth for capture endpoints, two accepted modes:
 * 1. Embedded SDK: Bearer public key (+ domain allowlist) — tenant from key.
 * 2. Hosted page: no Authorization header; the per-session sdkToken (body or
 *    query) authenticates. Tenant is resolved FROM the session row, so the
 *    token can never reach another tenant's data. Route services re-verify
 *    the token against the session hash regardless of mode.
 */
function sdkOrHostedAuth(req, res, next) {
  if (req.headers.authorization) {
    return requireApiKey("public")(req, res, (err) => {
      if (err) return next(err);
      return requireAllowedDomain(req, res, next);
    });
  }
  return (async () => {
    const { getDb } = require("../lib/db");
    const { verifySdkToken } = require("../services/sessionService");
    const sessionUid = req.params.sessionId;
    const token = req.body?.sdkToken || req.query?.sdkToken;
    if (!sessionUid || !token) throw new AppError("INVALID_API_KEY");

    const db = getDb();
    const session = await db.verificationSession.findFirst({ where: { sessionUid } });
    if (!session || !session.sdkTokenHash || !verifySdkToken(sessionUid, token, session.sdkTokenHash)) {
      throw new AppError("INVALID_API_KEY");
    }
    const tenant = await db.tenant.findFirst({ where: { id: session.tenantId } });
    if (!tenant || tenant.status === "suspended" || tenant.status === "disabled") {
      throw new AppError("INVALID_API_KEY");
    }
    req.tenant = tenant;
    req.isLive = session.isLive;
    req.apiKey = { prefix: "hosted" };
    next();
  })().catch(next);
}

module.exports = { requireApiKey, requireAllowedDomain, sdkOrHostedAuth };
