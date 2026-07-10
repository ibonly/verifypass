"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createFacepluginProvider } = require("../src/worker/providers/faceplugin");

function providerWith(body) {
  return createFacepluginProvider({
    livenessUrl: "http://lv:8888", faceUrl: "http://fr:8889",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => body })
  });
}

test("compareFaces surfaces the container's own verdict for calibration", async () => {
  // The model may say "Same Person" even when the raw similarity sits below
  // OUR thresholds — that combination means the thresholds are miscalibrated
  // for this model's scale, not that the user failed.
  const same = await providerWith({ result: { similarity: 0.42, status: "Same Person", message: "Success" } })
    .compareFaces(Buffer.alloc(1), Buffer.alloc(1));
  assert.equal(same.score, 0.42);
  assert.equal(same.providerMatch, true);

  const diff = await providerWith({ result: { similarity: 0.12, status: "Different Person", message: "Success" } })
    .compareFaces(Buffer.alloc(1), Buffer.alloc(1));
  assert.equal(diff.providerMatch, false);

  const noVerdict = await providerWith({ result: { similarity: 0, status: null, message: "Failed to extract feature on image2" } })
    .compareFaces(Buffer.alloc(1), Buffer.alloc(1));
  assert.equal(noVerdict.providerMatch, null);
});
