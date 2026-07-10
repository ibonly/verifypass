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
app.use(require("./middleware/cors").cors);
app.use(securityHeaders);
app.use(limiters.global);
app.use(express.json({ limit: "1mb" })); // capture routes use a 12mb body parser of their own
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
