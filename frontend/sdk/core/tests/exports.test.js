"use strict";
// Every name the UI layers import from @verifypass/sdk-core must actually be
// exported. Vite's CJS interop turns a missing named export into `undefined`
// at runtime instead of a build error — it surfaced as
// "frontalRefFromSamples is not a function" in the widget's tick loop.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const core = require("../src/index.js");

const SOURCES = [
  "../../react/src/VerificationWidget.jsx",
  "../../react/src/faceDetector.js",
  "../../js/src/global.js"
].map((p) => path.join(__dirname, p)).filter(fs.existsSync);

test("sdk-core exports every name the react/js SDK layers import", () => {
  const names = new Set();
  for (const file of SOURCES) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/import \{([^}]*)\} from "@verifypass\/sdk-core"/g)) {
      m[1].split(",").map((s) => s.trim()).filter(Boolean).forEach((n) => names.add(n));
    }
    for (const m of src.matchAll(/const \{([^}]*)\} = require\("@verifypass\/sdk-core"\)/g)) {
      m[1].split(",").map((s) => s.trim()).filter(Boolean).forEach((n) => names.add(n));
    }
  }
  assert.ok(names.size > 10, "should have found imports");
  const missing = [...names].filter((n) => typeof core[n] === "undefined");
  assert.deepEqual(missing, [], `missing sdk-core exports: ${missing.join(", ")}`);
});
