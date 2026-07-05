"use strict";

const crypto = require("crypto");
const { AppError } = require("@verifypass/shared");

/** Attach a correlation id to every request (PRD §20). */
function correlationId(req, res, next) {
  req.correlationId = req.headers["x-correlation-id"] || crypto.randomUUID();
  res.setHeader("X-Correlation-Id", req.correlationId);
  next();
}

function notFound(req, res, next) {
  next(new AppError("NOT_FOUND"));
}

function errorHandler(err, req, res, next) {
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
