"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { actionGeometry, bandMotion, createActionDetector } = require("../src/actionSignals");

// baseline: frontal face at center, 120w x 140h
const BASE = { x1: 100, y1: 50, x2: 220, y2: 190 };

function boxAt({ dx = 0, dy = 0, scaleW = 1, scaleH = 1 }) {
  const w = (BASE.x2 - BASE.x1) * scaleW;
  const h = (BASE.y2 - BASE.y1) * scaleH;
  const cx = (BASE.x1 + BASE.x2) / 2 + dx;
  const cy = (BASE.y1 + BASE.y2) / 2 + dy;
  return { x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 };
}

test("turn: lateral signature (shift + slight narrowing) triggers", () => {
  const turning = boxAt({ dx: 16, scaleW: 0.9, scaleH: 1.0 });
  assert.equal(actionGeometry("turn_left", BASE, turning), true);
});

test("turn: narrowing signature (strong aspect change, little shift) triggers", () => {
  // some people rotate in place: box barely moves but narrows sharply
  const rotating = boxAt({ dx: 2, scaleW: 0.8, scaleH: 1.0 });
  assert.equal(actionGeometry("turn_right", BASE, rotating), true);
});

test("turn: LEANING BACK (uniform shrink, no lateral shift) does NOT trigger", () => {
  const leanBack = boxAt({ scaleW: 0.85, scaleH: 0.85 });
  assert.equal(actionGeometry("turn_left", BASE, leanBack), false);
});

test("turn: sideways BODY SLIDE (shift with full width) does NOT trigger", () => {
  const slide = boxAt({ dx: 20, scaleW: 1.0, scaleH: 1.0 });
  assert.equal(actionGeometry("turn_left", BASE, slide), false);
});

test("turn: sitting still / jitter does NOT trigger", () => {
  assert.equal(actionGeometry("turn_right", BASE, boxAt({})), false);
  assert.equal(actionGeometry("turn_right", BASE, boxAt({ dx: 5, scaleW: 0.96 })), false);
});

test("turn: vertical-dominant drift without narrowing does NOT trigger", () => {
  const drift = boxAt({ dx: 12, dy: 30, scaleW: 0.93 });
  assert.equal(actionGeometry("turn_left", BASE, drift), false);
});

test("detector: face DISAPPEARING mid-turn counts as the turn (frontal detectors lose profiles)", () => {
  const det = createActionDetector("turn_left", BASE, { need: 2 });
  // head starts moving (below full trigger threshold), then detection drops
  det.update({ box: boxAt({ dx: 8, scaleW: 0.95 }) });     // moving, not yet "ok"
  const m1 = det.update({ box: null });                     // vanished mid-turn → ok
  const m2 = det.update({ box: null });                     // still gone → 2nd consecutive
  assert.equal(m1.ok, true);
  assert.equal(m2.triggered, true);
  assert.equal(m2.holding, true, "burst must be allowed while the face is turned away");
});

test("detector: disappearance WITHOUT prior movement does not trigger (covering the lens ≠ turn)", () => {
  const det = createActionDetector("turn_left", BASE, { need: 2 });
  det.update({ box: boxAt({}) });    // still frontal
  const r1 = det.update({ box: null });
  const r2 = det.update({ box: null });
  assert.equal(r1.ok, false);
  assert.equal(r2.triggered, false);
});

test("detector: disappearance clause expires after missMaxStreak (walked away ≠ turn)", () => {
  const det = createActionDetector("turn_left", BASE, { need: 2 });
  det.update({ box: boxAt({ dx: 8, scaleW: 0.95 }) });
  for (let i = 0; i < 4; i++) det.update({ box: null });
  const r = det.update({ box: null }); // 5th miss — beyond the window
  assert.equal(r.ok, false);
});

test("look up/down: vertical-dominant shift triggers; lean/horizontal does not", () => {
  assert.equal(actionGeometry("look_up", BASE, boxAt({ dy: -20 })), true);
  assert.equal(actionGeometry("look_down", BASE, boxAt({ dy: 22 })), true);
  // leaning back: center barely moves, both axes shrink
  assert.equal(actionGeometry("look_up", BASE, boxAt({ scaleW: 0.85, scaleH: 0.85 })), false);
  // horizontal move is not a tilt
  assert.equal(actionGeometry("look_up", BASE, boxAt({ dx: 25 })), false);
});

test("bandMotion: change localized to mouth region shows mouth ≫ eyes", () => {
  const W = 320;
  const H = 240;
  const prev = new Float32Array(W * H).fill(100);
  const cur = new Float32Array(W * H).fill(100);
  const box = { x1: 110, y1: 60, x2: 210, y2: 200 };
  // paint change ONLY in the mouth band (lower part of the box)
  const h = box.y2 - box.y1;
  for (let y = Math.floor(box.y1 + 0.6 * h); y < Math.floor(box.y1 + 0.9 * h); y++) {
    for (let x = box.x1; x < box.x2; x++) cur[y * W + x] = 160;
  }
  const m = bandMotion(prev, cur, W, box);
  assert.ok(m.mouth > 10, `mouth band should light up (${m.mouth})`);
  assert.ok(m.eyes < 1, `eye band should stay quiet (${m.eyes})`);
});

test("detector: requires CONSECUTIVE ok frames — a single blip never triggers", () => {
  const det = createActionDetector("turn_left", BASE, { need: 2 });
  const turning = boxAt({ dx: 16, scaleW: 0.85 });

  assert.equal(det.update({ box: turning }).triggered, false);   // 1st ok frame
  assert.equal(det.update({ box: boxAt({}) }).triggered, false); // streak broken
  assert.equal(det.update({ box: turning }).triggered, false);   // 1st again
  const r = det.update({ box: turning });                        // 2nd consecutive
  assert.equal(r.triggered, true);
  assert.equal(r.holding, true);

  // pose released → still triggered (latched) but no longer holding
  const after = det.update({ box: boxAt({}) });
  assert.equal(after.triggered, true);
  assert.equal(after.holding, false);
});

test("detector: smile fires on mouth-band dominance, not eye motion or stillness", () => {
  const det = createActionDetector("smile", BASE, { need: 2 });
  assert.equal(det.update({ eyes: 0.5, mouth: 0.5 }).ok, false);  // still
  assert.equal(det.update({ eyes: 9, mouth: 2 }).ok, false);      // blink-like → not a smile
  det.update({ eyes: 2, mouth: 8 });
  const r = det.update({ eyes: 2, mouth: 8 });
  assert.equal(r.triggered, true);
});

test("detector: blink fires on eye-band dominance", () => {
  const det = createActionDetector("blink", BASE, { need: 2 });
  assert.equal(det.update({ eyes: 2, mouth: 9 }).ok, false); // mouth-dominant → not a blink
  det.update({ eyes: 8, mouth: 1 });
  assert.equal(det.update({ eyes: 8, mouth: 1 }).triggered, true);
});
