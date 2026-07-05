"use strict";

// Security response headers (PRD §16.2). TLS/HSTS is handled by Apache in
// front of Passenger; headers here cover the app layer.

function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store"); // API responses carry PII — never cache
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  next();
}

module.exports = { securityHeaders };
