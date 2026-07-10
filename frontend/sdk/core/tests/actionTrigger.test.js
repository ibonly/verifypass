"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { detectActionTrigger } = require("../src/stabilizer");

// baseline: frontal face locked at center (120x140 box)
const BASE = { x1: 100, y1: 50, x2: 220, y2: 190 };

const shifted = (dx, dy = 0, scaleW = 1, scaleH = 1) => {
  const w = (BASE.x2 - BASE.x1) * scaleW;
  const h = (BASE.y2 - BASE.y1) * scaleH;
  const cx = (BASE.x1 + BASE.x2) / 2 + dx;
  const cy = (BASE.y1 + BASE.y2) / 2 + dy;
  return { x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 };
};

test("turn: still frontal → NOT triggered; head turn (shift or narrowing) → triggered", () => {
  // unchanged box: user hasn't moved yet — must NOT capture
  assert.equal(detectActionTrigger("turn_left", BASE, shifted(0)), false);
  // small jitter is not a turn
  assert.equal(detectActionTrigger("turn_left", BASE, shifted(8)), false);
  // real turn: center shifts ~20% of face width
  assert.equal(detectActionTrigger("turn_left", BASE, shifted(26)), true);
  // real turn detected via box narrowing even without much shift
  assert.equal(detectActionTrigger("turn_right", BASE, shifted(0, 0, 0.78)), true);
});

test("look up/down: vertical shift or height shrink triggers; horizontal doesn't", () => {
  assert.equal(detectActionTrigger("look_up", BASE, shifted(0)), false);
  assert.equal(detectActionTrigger("look_up", BASE, shifted(0, -22)), true);   // ~16% of height
  assert.equal(detectActionTrigger("look_down", BASE, shifted(0, 0, 1, 0.8)), true);
  assert.equal(detectActionTrigger("look_up", BASE, shifted(30, 0)), false);   // sideways ≠ tilt
});

test("blink/smile: no box signature → motion spike gates capture", () => {
  assert.equal(detectActionTrigger("smile", BASE, shifted(0)), false);
  assert.equal(detectActionTrigger("smile", BASE, shifted(0), { motionSpike: true }), true);
  assert.equal(detectActionTrigger("blink", null, null, { motionSpike: true }), true);
});

test("fails closed on missing data", () => {
  assert.equal(detectActionTrigger("turn_left", null, shifted(30)), false);
  assert.equal(detectActionTrigger("turn_left", BASE, null), false);
  assert.equal(detectActionTrigger(null, BASE, shifted(30)), false);
  assert.equal(detectActionTrigger("turn_left", { x1: 5, y1: 5, x2: 5, y2: 5 }, shifted(30)), false);
});
