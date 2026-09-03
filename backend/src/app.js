"use strict";

require("./env");

const express = require("express");
const { correlationId, notFound, errorHandler } = require("./middleware/errors");
const { securityHeaders } = require("./middleware/securityHeaders");
const { standardLimiters } = require("./middleware/rateLimit");

const app = express();
const limiters = standardLimiters();
app.locals.limiters = limiters;

app.disable("x-powered-by");
// Trust the first reverse proxy (Apache/Passenger, API Gateway). Ensures
// req.ip reflects the real client, not a spoofed X-Forwarded-For header.
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS) || 1);
app.use(require("./middleware/cors").cors);
app.use(securityHeaders);
app.use(limiters.global);
// Capture routes mount their own 12mb body parser per-route, so skip the
// global parser for them — the first body parser to run wins in Express,
// and a global 1mb limit would silently cap capture uploads.
app.use((req, res, next) => {
  if (req.method === "POST" && /^\/v1\/verification-sessions\/[^/]+\//.test(req.path)) {
    return next(); // let the per-route bigBody parser handle it
  }
  express.json({ limit: "1mb" })(req, res, next);
});
app.use(correlationId);

app.use(require("./routes/health"));
// captures first (public-key SDK routes, per-route auth) — unmatched paths
// fall through to the secret-key sessions router below
app.use("/v1/verification-sessions", require("./routes/captures"));
app.use("/v1/verification-sessions", require("./routes/sessions"));
app.use("/v1/api-keys", require("./routes/keys"));
app.use("/v1/auth/login", limiters.login);
app.use("/v1/auth", require("./routes/auth"));
app.use("/v1/customers", require("./routes/customers"));
app.use("/v1/manual-review", require("./routes/review"));
app.use("/v1/dashboard", require("./routes/dashboard"));
app.use("/v1/webhooks", require("./routes/webhooks"));
app.use("/v1/reports", require("./routes/reports"));
app.use("/v1/settings", require("./routes/settings"));

app.use(notFound);
app.use(errorHandler);

module.exports = app;
