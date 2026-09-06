# Liveness Check — Direction Matching: Root Cause & Fix (v4)

**Date:** 2026-09-04 · **Report:** "moving the face in any direction triggers capture; the instructed direction isn't matched."

## 1. Root cause (with evidence)

`direction-evidence.png` shows your own recording, in the orientation you saw on screen, with the yaw value the SDK computed under each frame:

* Every time the instruction said **turn LEFT** (arrow ←), your nose moved toward **screen-RIGHT** — away from the arrow.
* Every time it said **turn RIGHT** (arrow →), your nose moved toward **screen-LEFT**.

You turned your real left and right. The preview showed the opposite because **your camera delivers frames that are already mirrored**, and the widget applies its own CSS mirror on top, which un-mirrors them. On a phone (native, un-mirrored stream) the same code shows a true mirror. So any direction convention defined as "the user's anatomical left" is right on one class of devices and inverted on the other — and the SDK cannot detect which class it is on from the pixels.

Two further defects compounded this:

* **Box geometry was still a trigger source.** A face-box detector that hugs the whole head produces the same centre shift for a head *rotating* and a head *moving sideways*; and a vertical shift for a head *moving up* and a head *tilting*. That is why plain movement "completed" actions.
* **Without the landmark model the widget silently degraded to geometry** instead of stopping.

## 2. Fix

1. **Direction is defined toward the on-screen arrow, in preview space.** The arrow is drawn on a known side; the preview is a known CSS mirror of the analysed frame (`mirrorPreview=true` on all face steps); therefore the expected sign of yaw in the analysed frame is fixed *regardless of what the camera does*: `turn_left` (arrow on preview-left) expects the nose to move to preview-left = frame-right = **+Δyaw**; `turn_right` expects **−Δyaw**. Non-mirrored previews flip both (`expectedYawSign(action, mirrorPreview)`).
2. **Instruction copy no longer says LEFT/RIGHT** — it says "Slowly turn your head toward the arrow", and the coaching says "Other way — turn your head toward the arrow". Words were the ambiguity; the arrow is the truth.
3. **Head actions trigger only from landmark pose.** Box geometry never triggers a head action any more (kept as a diagnostic). Without a pose channel the detector reports `blind` and the widget **fails closed** to manual capture with an explicit message — for the liveness step to auto-capture, the landmark model must be loaded (`detector.hasLandmarks`).
4. Frontal-reference arming (from v3) kept; `look_down` threshold raised to 0.30 so the return overshoot after a look-up cannot read as a look-down; the frontal pitch band widened (0.20–0.95) so a phone held below eye level can still establish a reference.

Tests: 97 SDK-core tests, including a new matrix test that feeds turns, tilts, sideways slides and face loss to every head-action detector and asserts only the matching pose-defined movement fires; `mirrorPreview=false` is covered. Bundles rebuilt (`sample-app`, `verify-page`).

## 3. Validation on your recordings (new code)

| Instructed | What your nose did on screen | turn_left | turn_right | look_up | look_down | wrongWay coached |
|---|---|---|---|---|---|---|
| turn_left (A) | → screen-right (away from ←) | — | 2.3 s | — | — | yes |
| turn_right (A) | → screen-left (away from →) | 1.2 s | — | — | — | yes |
| look_up (A) | chin up | — | — | 1.9 s | — | — |
| turn_right (B) | → screen-left | 1.2 s | — | — | — | yes |
| turn_left (B) | → screen-right | — | 2.1 s | — | — | yes |
| turn_right (B) | → screen-left | 1.6 s | — | — | — | yes |
| turn_left (B) | → screen-right | — | 1.8 s | — | — | yes |
| look_up (B) | no real tilt | — | — | — | — | — |

Reading: because you turned away from the arrow every time, the instructed detector now correctly refuses and coaches "turn toward the arrow", and only the arrow-side detector fires. No turn ever fires a tilt; no tilt ever fires a turn. Flipping the yaw sign (a user who follows the arrow) makes each instructed detector — and only it — fire at 1.2–2.3 s.

## 4. What you should see now

* Turn toward the **arrow** (on your machine that means turning the way the preview shows, not the way you'd turn in a mirror) → capture within ~1–2 s. Turning the other way → "Other way — turn your head toward the arrow", no capture.
* Moving your head sideways/up/down without rotating → nothing. Tilting up when asked to turn → nothing.
* If the landmark model didn't load on a device → "Automatic detection isn't available here — do the movement, then tap Capture manually" instead of auto-capturing.
* `?vpdebug` shows `armed`, Δyaw/Δpitch and `wrongWay` live.

Restart nothing server-side for this one (client-only); hard-refresh both pages.
