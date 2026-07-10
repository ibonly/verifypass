"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDocumentGate, assessDocumentShape, isDominantFace } = require("../src/documentGate");

const W = 40;
const H = 30;

/** Uniform gray frame with an optional bright "document" region. */
function frame({ doc = false, shift = 0 } = {}) {
  const g = new Float32Array(W * H).fill(100);
  if (doc) {
    // document occupies the center ~half of the frame
    for (let y = 8; y < 24; y++) {
      for (let x = 8 + shift; x < 32 + shift && x < W; x++) g[y * W + x] = 200;
    }
  }
  return g;
}

function feed(gate, frames) {
  let last;
  for (const f of frames) last = gate.update(f);
  return last;
}

test("EMPTY scene never becomes ready — the exact bug: steady room ≠ document", () => {
  const gate = createDocumentGate();
  const r = feed(gate, Array.from({ length: 40 }, () => frame()));
  assert.equal(r.armed, true);
  assert.equal(r.present, false, "empty scene must not count as a document");
  assert.equal(r.ready, false);
});

test("document enters and is held still → ready", () => {
  const gate = createDocumentGate();
  feed(gate, Array.from({ length: 12 }, () => frame()));       // arm on empty scene
  const r = feed(gate, Array.from({ length: 10 }, () => frame({ doc: true }))); // ID held steady
  assert.equal(r.present, true);
  assert.equal(r.steady, true);
  assert.equal(r.ready, true);
});

test("document MOVING in frame → present but not ready", () => {
  const gate = createDocumentGate();
  feed(gate, Array.from({ length: 12 }, () => frame())); // arm
  // build a settled ID first, then wiggle it every frame
  feed(gate, Array.from({ length: 6 }, () => frame({ doc: true })));
  const r = feed(gate, Array.from({ length: 6 }, (_, i) => frame({ doc: true, shift: (i % 2) * 4 })));
  assert.equal(r.present, true);
  assert.equal(r.ready, false, "a moving document must not capture");
});

test("removing the document resets presence", () => {
  const gate = createDocumentGate();
  feed(gate, Array.from({ length: 12 }, () => frame()));
  feed(gate, Array.from({ length: 8 }, () => frame({ doc: true })));
  const r = feed(gate, Array.from({ length: 6 }, () => frame()));
  assert.equal(r.present, false);
  assert.equal(r.ready, false);
});

test("brief hand pass (1-2 frames of change) does not count as a document", () => {
  const gate = createDocumentGate();
  feed(gate, Array.from({ length: 12 }, () => frame()));
  gate.update(frame({ doc: true })); // 1 frame of change
  const r = gate.update(frame());    // gone again
  assert.equal(r.present, false, "presence requires sustained change");
});

test("isDominantFace: a live face filling the frame blocks — the exact bug", () => {
  // person leaning in at 320px frame → face box easily 120+ px wide
  assert.equal(isDominantFace({ x1: 90, y1: 40, x2: 230, y2: 220 }, 320), true);
});

test("isDominantFace: the small printed portrait on an ID card does NOT block", () => {
  // card at capture distance → portrait ~30-50px of a 320px frame
  assert.equal(isDominantFace({ x1: 60, y1: 90, x2: 105, y2: 150 }, 320), false);
});

test("isDominantFace: no face detected → never blocks", () => {
  assert.equal(isDominantFace(null, 320), false);
  assert.equal(isDominantFace(undefined, 320), false);
  assert.equal(isDominantFace({ x1: 0, y1: 0, x2: 100, y2: 100 }, 0), false);
});

test("isDominantFace relative rule: real ID portrait is small vs the card → clear", () => {
  // card spans 256px of the 320 frame; its printed portrait ~60px (23% of card)
  assert.equal(isDominantFace({ x1: 80, y1: 60, x2: 140, y2: 140 }, 320, { docWidthPx: 256 }), false);
});

test("isDominantFace relative rule: photo/selfie shown as 'document' is mostly face → blocks", () => {
  // 200px "document" whose face fills 120px (60% of it)
  assert.equal(isDominantFace({ x1: 60, y1: 40, x2: 180, y2: 200 }, 320, { docWidthPx: 200 }), true);
});

// --------------------------------------------------------------------------
// assessDocumentShape — positive card detection (fail-closed gate)
// --------------------------------------------------------------------------

const SW = 160;
const SH = 120;

function shapeBaseline() {
  return new Float32Array(SW * SH).fill(100);
}

/** Card: solid bright rectangle, optionally tilted (linear row shift). */
function cardFrame({ tilt = 0 } = {}) {
  const g = shapeBaseline();
  for (let y = 30; y <= 90; y++) {
    const shift = Math.round((y - 30) * tilt);
    for (let x = 30 + shift; x <= 130 + shift && x < SW; x++) g[y * SW + x] = 200;
  }
  return g;
}

/** Person: elliptical head + curved shoulders running to the frame bottom. */
function personFrame() {
  const g = shapeBaseline();
  const cx = 80, cy = 50, rx = 25, ry = 30;
  for (let y = cy - ry; y <= cy + ry; y++) {
    const dy = (y - cy) / ry;
    const halfW = Math.round(rx * Math.sqrt(Math.max(0, 1 - dy * dy)));
    for (let x = cx - halfW; x <= cx + halfW; x++) g[y * SW + x] = 210;
  }
  for (let y = 85; y < SH; y++) {
    const halfW = Math.round(20 + 38 * Math.sqrt((y - 85) / (SH - 85)));
    for (let x = cx - halfW; x <= cx + halfW; x++) g[y * SW + x] = 190;
  }
  return g;
}

test("shape: a held card (straight edges, solid) is cardLike", () => {
  const s = assessDocumentShape(shapeBaseline(), cardFrame(), SW, SH);
  assert.equal(s.found, true);
  assert.equal(s.cardLike, true, `expected cardLike (fill=${s.fill.toFixed(2)}, edges=${s.straightEdges})`);
});

test("shape: a TILTED card still passes (linear fit, not axis alignment)", () => {
  const s = assessDocumentShape(shapeBaseline(), cardFrame({ tilt: 0.15 }), SW, SH);
  assert.equal(s.cardLike, true, `tilted card must pass (edges=${s.straightEdges})`);
});

test("shape: a person leaning into frame is NOT cardLike — the exact bug", () => {
  const s = assessDocumentShape(shapeBaseline(), personFrame(), SW, SH);
  assert.equal(s.found, true, "the person IS a presence change");
  assert.equal(s.cardLike, false, "curved silhouette must never count as a document");
});

test("shape: empty scene → nothing found", () => {
  const s = assessDocumentShape(shapeBaseline(), shapeBaseline(), SW, SH);
  assert.equal(s.found, false);
  assert.equal(s.cardLike, false);
});

test("gate with dims: card enters and holds → ready", () => {
  const gate = createDocumentGate();
  for (let i = 0; i < 12; i++) gate.update(shapeBaseline(), SW, SH);
  let r;
  for (let i = 0; i < 10; i++) r = gate.update(cardFrame(), SW, SH);
  assert.equal(r.ready, true);
  assert.equal(r.shape.cardLike, true);
});

test("gate with dims is FAIL-CLOSED: a person present and steady NEVER becomes ready", () => {
  const gate = createDocumentGate();
  for (let i = 0; i < 12; i++) gate.update(shapeBaseline(), SW, SH);
  let r;
  for (let i = 0; i < 30; i++) r = gate.update(personFrame(), SW, SH);
  assert.equal(r.present, true, "the person is a sustained presence");
  assert.equal(r.steady, true, "and perfectly steady");
  assert.equal(r.ready, false, "but must never be captured as a document");
});
