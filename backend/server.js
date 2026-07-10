"use strict";

// Local dev / VPS entrypoint (PM2 etc.). Passenger uses app.js instead.
const app = require("./src/app");
const config = require("./src/config");

app.listen(config.port, () => {
  console.log(`VerifyPass API listening on :${config.port}`);
});
