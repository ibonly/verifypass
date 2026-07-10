"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createFramingStabilizer } = require("../src/stabilizer");

const GOOD = { present: true, inFrame: true, guide: "ok", box: { x1: 100, y1: 60, x2: 200, y2: 180 } };
const CLOSER = { present: true, inFrame: false, guide: "move_closer", box: { x1: 130, y1: 90, x2: 170, y2: 140 } };
const NONE = { present: false, inFrame: false, guide: "no_face", box: null };

test("locks after majority of good frames; a single blip does NOT unlock", () => {
  const s = createFramingStabilizer();
  let t = 0;
  let st;
  for (let i = 0; i < 3; i++) st = s.update(GOOD, (t += 140));
  assert.equal(st.locked, true);
  const lockedAt = st.lockedSince;

  // jitter blip: one bad detection — previously this reset the hold timer
  st = s.update(NONE, (t += 140));
  assert.equal(st.locked, true, "one bad frame must not unlock");
  assert.equal(st.lockedSince, lockedAt, "lock time survives blips");

  // sustained loss (4 consecutive) does unlock
  for (let i = 0; i < 4; i++) st = s.update(NONE, (t += 140));
  assert.equal(st.locked, false);
});

test("alternating good/bad detections (threshold flapping) stays locked", () => {
  const s = createFramingStabilizer();
  let t = 0;
  for (let i = 0; i < 3; i++) s.update(GOOD, (t += 140));
  // knife-edge flapping: ok, closer, ok, closer...
  let st;
  for (let i = 0; i < 20; i++) st = s.update(i % 2 ? CLOSER : GOOD, (t += 140));
  assert.equal(st.locked, true, "flapping around a threshold must not unlock");
  assert.equal(st.guide, "ok", "guide stays ok while locked");
});

test("guide changes respect dwell time (no flicker), promotion to ok is instant", () => {
  const s = createFramingStabilizer({ guideDwellMs: 650 });
  let t = 0;
  let st = s.update(CLOSER, (t += 140));
  assert.equal(st.guide, "move_closer"); // first guide publishes immediately

  // rapid alternation between two non-ok guides must not flip the text
  const CENTER = { present: true, inFrame: false, guide: "center", box: null };
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    st = s.update(i % 2 ? CENTER : CLOSER, (t += 100));
    seen.add(st.guide);
  }
  assert.deepEqual([...seen], ["move_closer"], "guide must not flicker within dwell window");

  // sustained new state eventually promotes (after dwell)
  for (let i = 0; i < 10; i++) st = s.update(CENTER, (t += 140));
  assert.equal(st.guide, "center");

  // good news is instant: lock → "ok" with no dwell
  for (let i = 0; i < 3; i++) st = s.update(GOOD, (t += 140));
  assert.equal(st.guide, "ok");
});

test("box is EMA-smoothed and survives brief dropouts", () => {
  const s = createFramingStabilizer();
  let t = 0;
  s.update(GOOD, (t += 140));
  const jumped = { ...GOOD, box: { x1: 140, y1: 100, x2: 240, y2: 220 } }; // +40px jump
  const st = s.update(jumped, (t += 140));
  assert.ok(st.box.x1 > 100 && st.box.x1 < 140, "box moves toward target, not teleports");

  const during = s.update(NONE, (t += 140)); // brief dropout keeps last box
  assert.ok(during.box, "box survives a single missed detection");
});

test("reset clears everything", () => {
  const s = createFramingStabilizer();
  let t = 0;
  for (let i = 0; i < 3; i++) s.update(GOOD, (t += 140));
  s.reset();
  const st = s.update(NONE, (t += 140));
  assert.equal(st.locked, false);
  assert.equal(st.box, null);
});
