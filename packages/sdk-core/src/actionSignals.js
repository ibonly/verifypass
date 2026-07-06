"use strict";

// Action-SPECIFIC capture triggers. Pure + testable.
//
// The previous trigger fired on ANY movement (any box shift/shrink, any
// whole-frame motion spike), so leaning back "was" a head turn and a hand
// wave "was" a smile — captures didn't match the instruction. These rules
// require the movement's actual signature:
//
//   turn_*   horizontal-dominant center shift AND the box gets NARROWER
//            while height holds (aspect change). A lean shrinks both axes
//            equally → no trigger.
//   look_*   vertical-dominant center shift. A lean barely moves the center.
//   blink    motion concentrated in the EYE band of the face box.
//   smile    motion concentrated in the MOUTH band of the face box.
//
// A verdict must hold for `need` consecutive detections before triggering
// (jitter can't fire it), and turns/tilts report `holding` so the burst only
// captures while the pose is actually held.

const GEO = Object.freeze({
  turnShift: 0.08,      // |Δcx| / baseline width (lateral signature)
  turnDominance: 1.2,   // horizontal shift must dominate vertical
  turnMaxWidth: 0.97,   // lateral signature also needs SOME narrowing —
                        //   a pure sideways body slide keeps full width
  turnNarrowWidth: 0.88, // narrowing signature: width ≤88% of baseline...
  turnAspectGap: 0.06,   // ...while height stays ≥6pts fuller (lean shrinks both)
  tiltShift: 0.12,      // |Δcy| / baseline height
  tiltDominance: 1.4,   // vertical shift must dominate horizontal
  bandFloor: 4,         // mean |Δgray| a band must reach (0..255 scale)
  bandDominance: 1.5,   // target band must beat the other band by this factor
  missMinShift: 0.05,   // pre-disappearance shift for the "turned out of
                        //   detection range" clause
  missMaxStreak: 4      // how many missed detections still count as mid-turn
});

/** Center/size of a box relative to the locked baseline. */
function boxMetrics(baseline, box) {
  if (!baseline || !box) return null;
  const bw = baseline.x2 - baseline.x1;
  const bh = baseline.y2 - baseline.y1;
  if (!(bw > 0 && bh > 0)) return null;
  return {
    dx: Math.abs(((box.x1 + box.x2) / 2 - (baseline.x1 + baseline.x2) / 2) / bw),
    dy: Math.abs(((box.y1 + box.y2) / 2 - (baseline.y1 + baseline.y2) / 2) / bh),
    widthRatio: (box.x2 - box.x1) / bw,
    heightRatio: (box.y2 - box.y1) / bh
  };
}

/**
 * Per-frame geometric verdict for head-movement actions.
 * Turns accept EITHER of two independent signatures (real turns rarely show
 * all signals at once at ~140ms sampling):
 *   lateral:   horizontal-dominant shift + at least slight narrowing
 *   narrowing: strong width shrink while height holds (aspect change —
 *              a lean shrinks both axes equally and fails this)
 */
function actionGeometry(action, baseline, box, geo = GEO) {
  const m = boxMetrics(baseline, box);
  if (!m) return false;

  switch (action) {
    case "turn_left":
    case "turn_right": {
      const lateral = m.dx >= geo.turnShift &&
        m.dx >= geo.turnDominance * m.dy &&
        m.widthRatio <= geo.turnMaxWidth;
      const narrowing = m.widthRatio <= geo.turnNarrowWidth &&
        m.heightRatio - m.widthRatio >= geo.turnAspectGap;
      return lateral || narrowing;
    }
    case "look_up":
    case "look_down":
      return m.dy >= geo.tiltShift && m.dy >= geo.tiltDominance * m.dx;
    default:
      return false;
  }
}

/**
 * Mean |Δgray| inside the eye band and mouth band of a face box, between two
 * consecutive grayscale frames (Float32Array, same dimensions).
 * Bands: eyes ≈ upper 18–45% of the box, mouth ≈ lower 55–95%.
 */
function bandMotion(prevGray, gray, frameWidth, box) {
  const out = { eyes: 0, mouth: 0 };
  if (!prevGray || !gray || prevGray.length !== gray.length || !box) return out;
  const frameHeight = Math.floor(gray.length / frameWidth);
  const h = box.y2 - box.y1;

  const bands = {
    eyes: [box.y1 + 0.18 * h, box.y1 + 0.45 * h],
    mouth: [box.y1 + 0.55 * h, box.y1 + 0.95 * h]
  };
  const x1 = Math.max(0, Math.floor(box.x1));
  const x2 = Math.min(frameWidth, Math.ceil(box.x2));
  if (x2 - x1 < 4) return out;

  for (const [name, [top, bottom]] of Object.entries(bands)) {
    const y1 = Math.max(0, Math.floor(top));
    const y2 = Math.min(frameHeight, Math.ceil(bottom));
    let sum = 0;
    let n = 0;
    for (let y = y1; y < y2; y++) {
      const row = y * frameWidth;
      for (let x = x1; x < x2; x++) {
        sum += Math.abs(gray[row + x] - prevGray[row + x]);
        n++;
      }
    }
    out[name] = n ? sum / n : 0;
  }
  return out;
}

/**
 * Stateful per-action detector. Feed it one update per detection tick:
 *   update({box, eyes, mouth}) → {ok, triggered, holding}
 * `triggered` latches after `need` CONSECUTIVE ok frames; `holding` is the
 * current-frame verdict (used to gate each burst shot for turns/tilts).
 */
function createActionDetector(action, baseline, { need = 2, geo = GEO } = {}) {
  let streak = 0;
  let triggered = false;
  let lastMetrics = null; // metrics of the last SEEN box (head movements)
  let missStreak = 0;
  const isTurn = action === "turn_left" || action === "turn_right";
  const isTilt = action === "look_up" || action === "look_down";

  return {
    action,
    baseline,
    update({ box, eyes = 0, mouth = 0 } = {}) {
      let ok;
      if (action === "blink") {
        ok = eyes >= geo.bandFloor && eyes >= geo.bandDominance * mouth;
      } else if (action === "smile") {
        ok = mouth >= geo.bandFloor && mouth >= geo.bandDominance * eyes;
      } else if (box) {
        ok = actionGeometry(action, baseline, box, geo);
        lastMetrics = boxMetrics(baseline, box);
        missStreak = 0;
      } else {
        // Frontal detectors LOSE a face mid-turn/tilt — the disappearance is
        // part of the movement's signature. Count a miss as action-consistent
        // when the face had already started moving the right way before it
        // vanished, for a bounded number of misses.
        missStreak++;
        const m = lastMetrics;
        const startedMoving = !!m && (
          (isTurn && (m.dx >= geo.missMinShift || m.widthRatio <= geo.turnNarrowWidth)) ||
          (isTilt && m.dy >= geo.missMinShift)
        );
        ok = startedMoving && missStreak <= geo.missMaxStreak;
      }
      streak = ok ? streak + 1 : 0;
      if (streak >= need) triggered = true;
      return { ok, triggered, holding: ok };
    }
  };
}

module.exports = { actionGeometry, boxMetrics, bandMotion, createActionDetector, ACTION_GEO: GEO };
