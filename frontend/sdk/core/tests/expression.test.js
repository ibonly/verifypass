"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { eyeAspectRatio, mouthAspectRatio, exprFromLandmarks, EXPRESSION } = require("../src/landmarks");
const { createActionDetector } = require("../src/actionSignals");

// Synthetic 68-point face: only the eye (36–47) and inner-lip (60–67) points matter.
function face({ eyeOpen = 6, mouthOpen = 2 } = {}) {
  const lm = new Array(136).fill(0);
  const set = (i, x, y) => { lm[2 * i] = x; lm[2 * i + 1] = y; };
  const eye = (o, cx) => {
    set(o, cx - 10, 50); set(o + 3, cx + 10, 50);                 // corners
    set(o + 1, cx - 4, 50 - eyeOpen / 2); set(o + 2, cx + 4, 50 - eyeOpen / 2); // upper lid
    set(o + 5, cx - 4, 50 + eyeOpen / 2); set(o + 4, cx + 4, 50 + eyeOpen / 2); // lower lid
  };
  eye(36, 30); eye(42, 70);
  set(60, 35, 90); set(64, 65, 90);                                // mouth corners
  set(61, 42, 90 - mouthOpen / 2); set(62, 50, 90 - mouthOpen / 2); set(63, 58, 90 - mouthOpen / 2);
  set(67, 42, 90 + mouthOpen / 2); set(66, 50, 90 + mouthOpen / 2); set(65, 58, 90 + mouthOpen / 2);
  return lm;
}

test("EAR / MAR follow lid and lip opening", () => {
  assert.ok(Math.abs(eyeAspectRatio(face({ eyeOpen: 6 })) - 0.3) < 1e-9);
  assert.ok(eyeAspectRatio(face({ eyeOpen: 1 })) < 0.06);
  assert.ok(Math.abs(mouthAspectRatio(face({ mouthOpen: 3 })) - 0.1) < 1e-9);
  assert.ok(mouthAspectRatio(face({ mouthOpen: 15 })) >= 0.5);
  assert.equal(eyeAspectRatio(null), null);
});

test("exprFromLandmarks denormalises through the box", () => {
  const raw = face({ eyeOpen: 6, mouthOpen: 3 }).map((v) => v / 100); // normalised to a 100×100 crop
  const e = exprFromLandmarks(raw, { x1: 10, y1: 20, x2: 210, y2: 220 });
  assert.ok(Math.abs(e.ear - 0.3) < 1e-9);
  assert.ok(Math.abs(e.mar - 0.1) < 1e-9);
});

test("blink detector: needs a confirmed closure THEN a re-open; squints and stillness never fire", () => {
  const det = createActionDetector("blink", null, { need: 2 });
  const open = { ear: 0.3, mar: 0.05 };
  for (let i = 0; i < EXPRESSION.baselineSamples; i++) assert.equal(det.update({ expr: open }).ok, false);
  // staying open: nothing
  for (let i = 0; i < 10; i++) assert.equal(det.update({ expr: open }).triggered, false);
  // a squint (75 % of open) is not a blink
  for (let i = 0; i < 4; i++) assert.equal(det.update({ expr: { ear: 0.225 } }).ok, false);
  // one-tick dip (jitter) does not confirm
  det.update({ expr: { ear: 0.1 } });
  assert.equal(det.update({ expr: open }).triggered, false);
  // real blink: closed for 2 ticks, then open
  const c1 = det.update({ expr: { ear: 0.12 } });
  assert.equal(c1.ok, true); assert.equal(c1.triggered, false);
  det.update({ expr: { ear: 0.1 } });
  const r = det.update({ expr: open });
  assert.equal(r.triggered, true);
});

test("open_mouth detector: absolute or relative MAR, held for `need` ticks; talking jitter does not fire", () => {
  const det = createActionDetector("open_mouth", null, { need: 2 });
  const rest = { ear: 0.3, mar: 0.08 };
  for (let i = 0; i < EXPRESSION.baselineSamples; i++) det.update({ expr: rest });
  assert.equal(det.update({ expr: { mar: 0.12 } }).ok, false); // slight movement
  assert.equal(det.update({ expr: { mar: 0.4 } }).ok, true);   // one tick open
  assert.equal(det.update({ expr: { mar: 0.1 } }).triggered, false); // released → no trigger
  det.update({ expr: { mar: 0.36 } });
  assert.equal(det.update({ expr: { mar: 0.38 } }).triggered, true);
  // relative rule: resting 0.1 → 0.2 (2×) fires even below the absolute floor
  const det2 = createActionDetector("open_mouth", null, { need: 2 });
  for (let i = 0; i < EXPRESSION.baselineSamples; i++) det2.update({ expr: { mar: 0.1 } });
  det2.update({ expr: { mar: 0.2 } });
  assert.equal(det2.update({ expr: { mar: 0.2 } }).triggered, true);
});

test("expression detectors: head movement never fires them; no ratios → open_mouth reports blind", () => {
  const det = createActionDetector("blink", null, { need: 2, frontalRef: { yaw: 0, pitch: 0.5 } });
  const open = { ear: 0.3, mar: 0.05 };
  for (let i = 0; i < 6; i++) det.update({ expr: open, pose: { yaw: 0.6 * (i % 2 ? 1 : -1), pitch: 0.5 } });
  assert.equal(det.update({ expr: open, pose: { yaw: 0, pitch: 0.1 } }).triggered, false);
  const blind = createActionDetector("open_mouth", null, { need: 2 });
  let s;
  for (let i = 0; i < 12; i++) s = blind.update({ box: { x1: 0, y1: 0, x2: 10, y2: 10 }, pose: { yaw: 0, pitch: 0.5 } });
  assert.equal(s.blind, true);
  assert.equal(s.triggered, false);
});
