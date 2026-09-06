"use strict";
// Calibration math (pure parts) — the DB-facing main() is exercised manually.
const test = require("node:test");
const assert = require("node:assert/strict");
const src = require("fs").readFileSync(require("path").join(__dirname, "../scripts/calibrate-thresholds.js"), "utf8");
// extract the pure helpers without running main()
const sandbox = {};
new Function("module", "require", src.replace(/main\(\)\.catch[\s\S]*$/, "module.exports = { quantiles, rates, recommend };"))(sandbox, require);
const { quantiles, rates, recommend } = sandbox.exports;

test("rates: FAR counts impostors accepted, FRR counts genuines rejected", () => {
  const r = rates([0.9, 0.8, 0.6], [0.2, 0.7], 0.75);
  assert.equal(r.far, 0);           // 0.7 < 0.75 → no impostor accepted
  assert.equal(+r.frr.toFixed(3), 0.333); // 0.6 rejected
});

test("recommend: separable distributions give reject <= pass with a review band, insufficient data is flagged", () => {
  const genuine = Array.from({ length: 60 }, (_, i) => 0.8 + (i % 10) * 0.015);
  const impostor = Array.from({ length: 20 }, (_, i) => 0.2 + (i % 10) * 0.03);
  const r = recommend(genuine, impostor);
  assert.ok(r.reject !== null && r.pass !== null && r.reject <= r.pass, JSON.stringify(r));
  assert.ok(recommend([0.9], [0.1]).note);
  assert.equal(quantiles([3, 1, 2]).median, 2);
});
