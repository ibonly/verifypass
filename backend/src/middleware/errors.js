"use strict";

const crypto = require("crypto");
const { AppError } = require("@verifypass/shared");

/** Attach a correlation id to every request (PRD §20). */
function correlationId(req, res, next) {
  const raw = req.headers["x-correlation-id"];
  req.correlationId = typeof raw === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : crypto.randomUUID();
  res.setHeader("X-Correlation-Id", req.correlationId);
  next();
}

function notFound(req, res, next) {
  next(new AppError("NOT_FOUND"));
}

function errorHandler(err, req, res, next) {
  if (err && err.type === "entity.parse.failed") {
    err = new AppError("VALIDATION_ERROR", "Malformed JSON request body");
  } else if (err && err.type === "entity.too.large") {
    err = new AppError("VALIDATION_ERROR", "Request payload too large");
  }
  const isApp = err instanceof AppError;
  const http = isApp ? err.http : 500;
  const code = isApp ? err.code : "INTERNAL_ERROR";
  if (!isApp) {
    console.error("UNHANDLED_ERROR", { correlationId: req.correlationId, err: err.stack });
  }
  res.status(http).json({
    success: false,
    error: {
      code,
      message: isApp ? err.message : "Internal server error",
      ...(isApp && err.details ? { details: err.details } : {})
    },
    correlationId: req.correlationId
  });
}

module.exports = { correlationId, notFound, errorHandler };
