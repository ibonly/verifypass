"use strict";

// Temporal stabilizer for face-framing signals. Pure + injectable clock, so it
// is unit-testable in Node and shared by any UI layer.
//
// Problems it solves (observed in real capture sessions):
//  - Raw per-detection decisions flap: boxes jitter a few % frame-to-frame, so
//    knife-edge thresholds (ratio/center/focus) flip the guide text several
//    times per second ("instructions flicker").
//  - A single bad detection reset the auto-capture hold timer, so capture
//    rarely fired even when the user was correctly positioned ("not stable").
//
// Design:
//  - LOCK with hysteresis: enter locked after `enterGood` of the last
//    `windowSize` detections are in-frame; leave only after `exitBad`
//    CONSECUTIVE misses. Transient dropouts don't unlock.
//  - Guide dwell: a new instruction only replaces the current one after it has
//    been the majority candidate for `guideDwellMs` (promotion to "ok" is
//    immediate — good news never lags).
//  - Box EMA: overlay box is exponentially smoothed so it glides instead of
//    twitching.

const DEFAULTS = Object.freeze({
  windowSize: 5,
  enterGood: 3,
  exitBad: 4,
  guideDwellMs: 650,
  boxAlpha: 0.35
});

function createFramingStabilizer(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  let recent = [];
  let locked = false;
  let lockedSince = 0;
  let badStreak = 0;
  let currentGuide = null;
  let candidateGuide = null;
  let candidateSince = 0;
  let emaBox = null;
  let missStreak = 0;

  function majorityGuide() {
    const counts = new Map();
    for (const r of recent) counts.set(r.guide, (counts.get(r.guide) || 0) + 1);
    let best = "no_face";
    let bestN = -1;
    for (const [g, n] of counts) if (n > bestN) { best = g; bestN = n; }
    return best;
  }

  return {
    /**
     * @param {object|null} assessment {present, inFrame, guide, box?}
     * @param {number} now ms clock (performance.now())
     * @returns {{locked, lockedSince, guide, box, present}}
     */
    update(assessment, now) {
      const a = assessment || { present: false, inFrame: false, guide: "no_face", box: null };
      recent.push({ inFrame: !!a.inFrame, present: !!a.present, guide: a.guide || "no_face" });
      if (recent.length > cfg.windowSize) recent.shift();

      // --- lock state with hysteresis ---
      const good = recent.filter((r) => r.inFrame).length;
      if (!locked) {
        if (good >= cfg.enterGood) {
          locked = true;
          lockedSince = now;
          badStreak = 0;
        }
      } else if (a.inFrame) {
        badStreak = 0;
      } else {
        badStreak++;
        if (badStreak >= cfg.exitBad) {
          locked = false;
          lockedSince = 0;
        }
      }

      // --- guide with dwell time ---
      const target = locked ? "ok" : majorityGuide();
      if (target !== currentGuide) {
        if (candidateGuide !== target) {
          candidateGuide = target;
          candidateSince = now;
        }
        const dwell = currentGuide === null || target === "ok" ? 0 : cfg.guideDwellMs;
        if (now - candidateSince >= dwell) {
          currentGuide = target;
          candidateGuide = null;
        }
      } else {
        candidateGuide = null;
      }

      // --- smoothed overlay box ---
      if (a.box) {
        missStreak = 0;
        emaBox = emaBox
          ? {
              x1: emaBox.x1 + cfg.boxAlpha * (a.box.x1 - emaBox.x1),
              y1: emaBox.y1 + cfg.boxAlpha * (a.box.y1 - emaBox.y1),
              x2: emaBox.x2 + cfg.boxAlpha * (a.box.x2 - emaBox.x2),
              y2: emaBox.y2 + cfg.boxAlpha * (a.box.y2 - emaBox.y2)
            }
          : { x1: a.box.x1, y1: a.box.y1, x2: a.box.x2, y2: a.box.y2 };
      } else {
        missStreak++;
        if (missStreak >= cfg.exitBad) emaBox = null; // keep box through brief dropouts
      }

      return {
        locked,
        lockedSince,
        guide: currentGuide,
        box: emaBox,
        present: recent.some((r) => r.present)
      };
    },

    reset() {
      recent = [];
      locked = false;
      lockedSince = 0;
      badStreak = 0;
      currentGuide = null;
      candidateGuide = null;
      candidateSince = 0;
      emaBox = null;
      missStreak = 0;
    }
  };
}

// How far the face box must move/shrink (relative to the locked baseline)
// before we believe the requested action is actually underway.
const TRIGGER = Object.freeze({
  turnShiftX: 0.16,   // |Δcenter-x| as fraction of baseline width
  turnShrink: 0.82,   // box width shrinks to ≤82% on a yaw
  tiltShiftY: 0.13,   // |Δcenter-y| as fraction of baseline height
  tiltShrink: 0.84
});

/**
 * Has the user actually STARTED the requested liveness action?
 * Uses face-box dynamics vs the frontal baseline captured at lock time —
 * a head turn shifts the box laterally and narrows it; a tilt shifts it
 * vertically. blink/smile have no box signature, so they fall back to a
 * frame-motion spike. Direction is intentionally not enforced client-side
 * (mirrored previews make it error-prone); the server verifies direction
 * authoritatively from pose.
 *
 * @param {string} action challenge action ("turn_left", "look_up", "smile", ...)
 * @param {{x1,y1,x2,y2}|null} baseline box at frontal lock
 * @param {{x1,y1,x2,y2}|null} box latest detection
 * @param {{motionSpike?:boolean}} [signals]
 * @returns {boolean}
 */
function detectActionTrigger(action, baseline, box, { motionSpike = false } = {}) {
  if (!action) return false;
  if (action === "blink" || action === "smile") return motionSpike;
  if (!baseline || !box) return false;
  const bw = baseline.x2 - baseline.x1;
  const bh = baseline.y2 - baseline.y1;
  if (!(bw > 0 && bh > 0)) return false;

  const dx = Math.abs(((box.x1 + box.x2) / 2 - (baseline.x1 + baseline.x2) / 2) / bw);
  const dy = Math.abs(((box.y1 + box.y2) / 2 - (baseline.y1 + baseline.y2) / 2) / bh);
  const widthRatio = (box.x2 - box.x1) / bw;
  const heightRatio = (box.y2 - box.y1) / bh;

  switch (action) {
    case "turn_left":
    case "turn_right":
      return dx >= TRIGGER.turnShiftX || widthRatio <= TRIGGER.turnShrink;
    case "look_up":
    case "look_down":
      return dy >= TRIGGER.tiltShiftY || heightRatio <= TRIGGER.tiltShrink;
    default:
      return motionSpike;
  }
}

module.exports = { createFramingStabilizer, detectActionTrigger, STABILIZER_DEFAULTS: DEFAULTS, ACTION_TRIGGER: TRIGGER };
