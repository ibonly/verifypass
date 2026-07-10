"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { collectDeviceSignals } = require("../src/device");

test("collectDeviceSignals returns null outside browsers (Node)", () => {
  assert.equal(collectDeviceSignals(), null);
});
