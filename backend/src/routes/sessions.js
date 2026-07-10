"use strict";

const { Router } = require("express");
const { requireApiKey } = require("../middleware/auth");
const { tenantScope } = require("../middleware/tenantScope");
const { createSession, getSession } = require("../services/sessionService");
const { audit } = require("../services/auditLogger");

const router = Router();

router.use(requireApiKey("secret"), tenantScope);

function publicApiUrlForRequest(req) {
  if (process.env.API_PUBLIC_URL || process.env.NODE_ENV === "production") return undefined;
  const host = req.get("x-forwarded-host") || req.get("host");
  if (!host) return undefined;
  const proto = req.get("x-forwarded-proto") || req.protocol || "http";
  return `${proto.split(",")[0]}://${host.split(",")[0]}`.replace(/\/$/, "");
}

// POST /v1/verification-sessions (PRD §12.1)
router.post("/", async (req, res, next) => {
  try {
    const result = await createSession(req.scopedDb, req.body, req.isLive, { publicApiUrl: publicApiUrlForRequest(req) });
    await audit({
      tenantId: req.tenant.id,
      actorType: "api",
      actorId: `key:${req.apiKey.prefix}`,
      action: "session.created",
      req,
      metadata: { sessionId: result.sessionId, verificationType: req.body?.verificationType || "ID_AND_FACE" }
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /v1/verification-sessions/:sessionId/result (PRD §12.6, shape §30)
router.get("/:sessionId/result", async (req, res, next) => {
  try {
    const { AppError } = require("@verifypass/shared");
    const session = await req.scopedDb.sessions.findByUid(req.params.sessionId);
    if (!session) throw new AppError("SESSION_NOT_FOUND");
    const r = await req.scopedDb.results.latestForSession(session.id);

    // ID verification and FACE verification are INDEPENDENT products:
    //   FACE_ONLY  — liveness + selfie; there is no document and nothing to
    //                extract, so no document section exists in the result.
    //   ID_ONLY    — document capture + extraction; no liveness check runs,
    //                so no liveness/faceMatch sections exist in the result.
    //   ID_AND_FACE — both, plus the cross-check (face match).
    // Sections are OMITTED (not null-filled) so consumers can't mistake
    // "check not applicable" for "check ran and returned nothing".
    const type = session.verificationType || "ID_AND_FACE";
    const hasFace = type !== "ID_ONLY";
    const hasDocument = type !== "FACE_ONLY";

    res.json({
      success: true,
      sessionId: session.sessionUid,
      customerReference: session.customerReference,
      verificationType: type,
      status: session.status,
      riskLevel: session.riskLevel || null,
      ...(hasDocument ? {
        document: r ? {
          status: r.documentStatus,
          ocrConfidence: r.ocrConfidence != null ? Number(r.ocrConfidence) : null,
          extractedData: r.extractedData || null
        } : null
      } : {}),
      ...(hasFace ? {
        liveness: r ? {
          status: r.livenessStatus,
          score: r.livenessScore != null ? Number(r.livenessScore) : null
        } : null
      } : {}),
      ...(hasFace && hasDocument ? {
        faceMatch: r ? {
          status: r.faceMatchStatus,
          similarityScore: r.faceMatchScore != null ? Number(r.faceMatchScore) : null
        } : null
      } : {}),
      decision: {
        status: session.status,
        reasonCodes: session.decisionReason?.reasonCodes || []
      },
      completedAt: session.completedAt ? new Date(session.completedAt).toISOString() : null
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/verification-sessions/:sessionId (PRD §12.2)
router.get("/:sessionId", async (req, res, next) => {
  try {
    const result = await getSession(req.scopedDb, req.params.sessionId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
