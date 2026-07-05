"use strict";

// cPanel/Passenger entrypoint: export the app, do NOT listen here.
// Passenger handles port binding and process management (PRD §10.2).
module.exports = require("./src/app");
