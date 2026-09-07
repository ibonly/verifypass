"use strict";

const { Router } = require("express");

const router = Router();

router.get("/health", (req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString(), release: require("../lib/release").releaseIdentity() });
});

module.exports = router;
