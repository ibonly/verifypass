"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { actionGeometry, bandMotion, createActionDetector } = require("../src/actionSignals");

// baseline: frontal face at center, 120w x 140h
// Direction convention is PREVIEW-SPACE, toward the arrow, with the preview a
// CSS mirror of the analysed frame (mirrorPreview=true): turn_left's arrow is
// on preview-left, the nose/box moves to preview-left = frame-RIGHT (+dx);
// turn_right → −dx.
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
  // SIGNED: the same movement is NOT a right turn
  assert.equal(actionGeometry("turn_right", BASE, turning), false);
  assert.equal(actionGeometry("turn_right", BASE, boxAt({ dx: -16, scaleW: 0.9 })), true);
});

test("turn: narrowing signature (strong aspect change, little shift) triggers", () => {
  // some people rotate in place: box barely moves but narrows sharply
  const rotating = boxAt({ dx: -4, scaleW: 0.8, scaleH: 1.0 });
  assert.equal(actionGeometry("turn_right", BASE, rotating), true);
  // ...but a rotation whose centre drifts the OTHER way is not this action
  assert.equal(actionGeometry("turn_left", BASE, rotating), false);
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



// --- Head actions: POSE ONLY, arrow-relative, frontal-armed --------------------
// Field report 2026-09-04: one LEFT turn completed turn_left, turn_right AND
// look_up; on another machine every turn read as the opposite direction
// (camera delivered pre-mirrored frames). Geometry is no longer a trigger
// source and direction is defined toward the on-screen arrow.

const REF = { yaw: 0.05, pitch: 0.55 };
const P = (yaw, pitch = 0.55) => ({ box: BASE, pose: { yaw, pitch, interOcular: 40 } });
function feed(det, seq) { let st; for (const f of seq) st = det.update(f); return st; }

test("head action: box geometry alone NEVER triggers, however far the box moves (rotation vs translation is indistinguishable)", () => {
  for (const action of ["turn_left", "turn_right", "look_up", "look_down"]) {
    const det = createActionDetector(action, BASE, { need: 2 });
    let trig = false;
    for (const b of [boxAt({}), boxAt({ dx: 30 }), boxAt({ dx: -40, scaleW: 0.8 }), boxAt({ dy: 40 }), null, null, boxAt({ dy: -50 })]) {
      trig = det.update({ box: b }).triggered || trig;
    }
    assert.equal(trig, false, action);
  }
});

test("head action: without any pose channel the detector reports blind (widget fails closed)", () => {
  const det = createActionDetector("turn_left", BASE, { need: 2 });
  let st; for (let i = 0; i < 12; i++) st = det.update({ box: boxAt({ dx: i * 3 }) });
  assert.equal(st.blind, true);
  assert.equal(st.triggered, false);
});

test("turn_left (arrow on preview-left, mirrored preview): nose moving to frame-RIGHT (+yaw) triggers; frame-LEFT is wrongWay", () => {
  const det = createActionDetector("turn_left", BASE, { need: 2, frontalRef: REF });
  feed(det, [P(0.05), P(0.05)]); // arm
  let st = feed(det, [P(0.35), P(0.4), P(0.45)]);
  assert.equal(st.triggered, true);
  const det2 = createActionDetector("turn_left", BASE, { need: 2, frontalRef: REF });
  feed(det2, [P(0.05), P(0.05)]);
  st = feed(det2, [P(-0.35), P(-0.4), P(-0.45)]);
  assert.equal(st.triggered, false);
  assert.equal(st.wrongWay, true);
});

test("turn_right is the mirror image; non-mirrored preview (mirrorPreview=false) flips the expected sign", () => {
  const r = createActionDetector("turn_right", BASE, { need: 2, frontalRef: REF });
  feed(r, [P(0.05), P(0.05)]);
  assert.equal(feed(r, [P(-0.35), P(-0.4), P(-0.45)]).triggered, true);
  const rn = createActionDetector("turn_right", BASE, { need: 2, frontalRef: REF, mirrorPreview: false });
  feed(rn, [P(0.05), P(0.05)]);
  assert.equal(feed(rn, [P(0.35), P(0.4), P(0.45)]).triggered, true);
});

test("a turn never satisfies look_up/look_down, and a tilt never satisfies a turn", () => {
  const turnSeq = [P(0.05), P(0.05), P(0.3), P(0.45), P(0.5), P(0.5)];
  for (const a of ["look_up", "look_down"]) assert.equal(feed(createActionDetector(a, BASE, { need: 2, frontalRef: REF }), turnSeq).triggered, false, a);
  const tiltSeq = [P(0.05), P(0.05), P(0.05, 0.3), P(0.05, 0.15), P(0.05, 0.12), P(0.05, 0.12)];
  for (const a of ["turn_left", "turn_right"]) assert.equal(feed(createActionDetector(a, BASE, { need: 2, frontalRef: REF }), tiltSeq).triggered, false, a);
  assert.equal(feed(createActionDetector("look_up", BASE, { need: 2, frontalRef: REF }), tiltSeq).triggered, true);
  assert.equal(feed(createActionDetector("look_down", BASE, { need: 2, frontalRef: REF }), tiltSeq).wrongWay, true);
});

test("arming: still turned when the instruction appears → returning to centre is NOT a movement", () => {
  const det = createActionDetector("turn_right", BASE, { need: 2, frontalRef: REF });
  const seq = [0.5, 0.5, 0.4, 0.3, 0.15, 0.05, 0.05, 0.05].map((y) => P(y));
  let trig = false, armedAt = null;
  seq.forEach((f, i) => { const st = det.update(f); if (st.armed && armedAt == null) armedAt = i; trig = trig || st.triggered; });
  assert.equal(trig, false);
  assert.ok(armedAt >= 5, `armed at ${armedAt}`);
  assert.equal(feed(det, [P(-0.3), P(-0.4), P(-0.45)]).triggered, true); // now a real turn toward the arrow
});

test("a single-tick pose spike does not trigger (median-3 smoothing + 2 consecutive)", () => {
  const det = createActionDetector("turn_left", BASE, { need: 2, frontalRef: REF });
  feed(det, [P(0.05), P(0.05)]);
  const st = feed(det, [P(0.9), P(0.05), P(0.05)]);
  assert.equal(st.triggered, false);
});
