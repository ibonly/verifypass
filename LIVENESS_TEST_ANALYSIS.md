# Liveness Check — Code & Test-Video Analysis

**Date:** 2026-09-04
**Inputs:** `Screen Recording 12.41.59AM.mov` (68 s, one full run → approved), `Screen Recording 12.45.24AM.mov` (42 s, two attempts → manual review twice), plus the current SDK/backend code (`frontend/sdk/core`, `frontend/sdk/react`, `backend/src/worker`, `backend/shared`).
**Method:** both recordings were sampled at 1 fps with timestamps and read frame by frame against the state machine in `VerificationWidget.jsx`; every observation below is tied to a timestamp and to the code path that produced it.

---

## 1. What the videos show (timeline)

### Recording 12:41 — full run, approved (0:00 → 0:22)

| Time | Step | What happened | Code path |
|---|---|---|---|
| 0:00–0:03 | turn_left (1/3) | User turns fully left within ~1.5 s; face box tracks the turn; **no trigger** | `createActionDetector` — lateral/narrowing signature not met for 2 consecutive detections |
| 0:04–0:07 | turn_left | "We haven't seen it yet — make the movement bigger and slower" shown **while the user is already fully turned**; user keeps turning/holding for 4 more seconds | `AWAIT_HINT_MS = 3500` fires on a timer, not on a diagnosis |
| 0:08 | turn_left | "Got it — hold on…" burst starts, **8 s after the action began** | trigger finally latches (likely the disappearance/miss clause) |
| 0:09–0:11 | turn_right (2/3) | Re-align ("Center your face"), then triggers in ~1 s | normal path — turn_right behaves as designed here |
| 0:12–0:16 | look_up (3/3) | "Get ready…", user tilts, trigger at ~3 s | `tiltShift = 0.09` of baseline height reached late |
| 0:17–0:18 | selfie | "Position your face" → "Hold still…" → captured. Face is slightly turned/tilted at capture (0:18) | 550 ms hold on lock; no frontal-pose check before the selfie |
| 0:19–0:22 | verifying → **Approved** | ~3 s server time | fine |
| 0:22–1:07 | result screen | "Run another" is hovered/clicked at 0:22 and 0:31; **screen does not change for 45 s**; user switches away at 0:48 | sample-app `reset()` — see §3.9 |

### Recording 12:45 — two attempts, both "under review" (0:00 → 0:40)

| Time | Step | What happened | Code path |
|---|---|---|---|
| 0:00–0:02 | look_up (1/3) | Recording starts mid-action; hint already up at 0:01; burst at 0:02 | — |
| 0:03–0:04 | between actions | **"Move closer"** for 2 s although the face fills ~45 % of the circle | `assessFraming.minRatio = 0.34` too strict for a laptop at arm's length; re-align between *every* action |
| 0:05–0:06 | turn_right | triggers in ~1 s | good |
| 0:07–0:10 | turn_left | "Center your face" again, then ~2 s to trigger | re-align cost + detection latency |
| 0:11–0:12 | selfie | captured with head leaning right (0:11 frame shows the box off-centre) | no frontal check |
| 0:13–0:15 | verifying → **Under review, attempt 1 of 5** | no reason shown | status endpoint returns `{status}` only — §3.8 |
| 0:19–0:20 | Try again | new challenge: turn_right, turn_left, look_up | `retrySession` reissue — works |
| 0:21–0:23 | turn_right | ~2 s to trigger | — |
| 0:24–0:27 | turn_left | "Center your face" then ~2 s | — |
| 0:28 | between actions | **"Move closer"** again | same as 0:03 |
| 0:29–0:35 | look_up | User tilts clearly at 0:30–0:32; hint at 0:33; **trigger only at 0:35 (6 s)**; overlay box drifts to the right edge, off the face, at 0:35 | tilt signature weak (§3.2); EMA lag (§3.4) |
| 0:36–0:39 | selfie → verifying → **Under review, attempt 2 of 5** | again no reason | §3.8 |

**Net effect for the tester:** ~50 % of the time in each run is spent waiting for the detector to acknowledge a movement that was already performed, being told to move closer when already close, or being told to make a movement "bigger and slower" that was already big and slow. Two clean-looking runs ended in manual review with no way to learn why. That is the "liveness boss" experience.

---

## 2. Root-cause map

Everything observed traces to five root causes; the fixes in §4 are ordered by how many symptoms each one removes.

| # | Root cause | Symptoms it explains |
|---|---|---|
| A | **Movement is inferred from face-box geometry only** (centre shift + width shrink), and the detector is frontal-biased so it *loses* the face at exactly the moment the geometry would prove the turn | slow/missed turn_left (12:41 0:00–0:08), slow look_up (12:45 0:29–0:35), left/right asymmetry on some setups, the need for the 9 s fallback burst |
| B | **Model frame is the centre square stretched to 320×240** (vertical squash ≈ 0.75) | lower detection confidence on turned/tilted heads, taller-than-wide boxes, framing thresholds tuned against a distorted frame |
| C | **Framing gate re-runs between every action with a strict `minRatio = 0.34`** | "Move closer" at normal distance (12:45 0:03, 0:28), ~1–2 s of "Center your face" between each action |
| D | **Coaching is timer-based, not diagnosis-based** | "make the movement bigger and slower" while already turned (12:41 0:04), contradicting "Slowly turn…" |
| E | **No reason codes reach the SDK / sample app** | two "under review" outcomes with nothing to act on; widget code for `result.decision.reasonCodes` is dead |

---

## 3. Detailed findings

### 3.1 Turn detection is slow and setup-dependent (High)

`actionSignals.js` accepts a turn when either **lateral** (`dx ≥ 0.06` of baseline width, horizontal dominance ≥ 1.2, `widthRatio ≤ 0.97`) or **narrowing** (`widthRatio ≤ 0.91` with `heightRatio − widthRatio ≥ 0.05`) holds for `need = 2` consecutive detections at `DETECT_MS = 110` ms. In practice:

* The RetinaFace-style detector (`fr_detect.onnx`) is frontal-biased: past ~30–40° of yaw the box either vanishes or its confidence drops under `0.65`, so the "narrowing" signature is often never observed — the box disappears before it narrows.
* The **miss clause** rescues this only if the last *seen* box already had `dx ≥ 0.04` or `widthRatio ≤ 0.91`. A person who turns quickly and cleanly (as in 12:41 0:00–0:02) goes from frontal to "gone" in one or two detection ticks and never satisfies it; a person who turns slowly and sloppily does. That is why "slowly" in the instruction is accidentally correct — and why the tester who turns crisply is punished.
* Which side is lost first depends on lighting and the camera's position relative to the face, which is the whole explanation for "turn right works, turn left doesn't" on one machine and the reverse on another. The code is symmetric; the detector's loss profile is not.
* Detection latency floor: 2 × 110 ms cadence + ONNX WASM inference (~60–150 ms on a laptop) ≈ 350–500 ms *after* the signature first holds — acceptable — but the signature itself is what arrives late or never.

### 3.2 Look-up detection is weaker than turns (High)

Tilt requires `dy ≥ 0.09` of baseline height with vertical dominance 1.25. Looking up mostly changes the box's **height and the position of features inside it**, not its centre — the chin rises, the box top barely moves. In 12:45 (0:29–0:35) the tester is clearly looking up from 0:30 and the trigger only fires at 0:35, after the fallback hint. There is no aspect-based signature for tilts equivalent to the "narrowing" clause for turns.

### 3.3 The model frame is geometrically distorted (Medium)

`grabSquareFrame` crops the centre square and **stretches it to 320×240**. Faces are squashed vertically by 25 %. Consequences: (a) detection confidence is lower than the model was trained for, especially for non-frontal poses — compounding 3.1/3.2; (b) `assessFraming` ratios and `GEO` thresholds were tuned on distorted boxes; (c) the overlay canvas maps `x/320`, `y/240` back onto a square, so the drawn box is correct on average but any detector error is anisotropic. The fix is to feed the model its native aspect (crop a 4:3 region of the video, or letterbox the square) and keep a single source-of-truth transform for overlay mapping.

### 3.4 Overlay lags and looks mis-registered during movement (Medium)

The overlay draws the **EMA-smoothed** box (`boxAlpha = 0.35`) at the detection cadence, so during a head movement it trails the face by 2–4 ticks (200–450 ms). In the 1 fps samples the box sits beside the face (12:45 0:35, 12:41 0:09). Users read that as "it can't see me" and over-correct. During `await`/`capturing` phases the raw box (or no box) should be drawn; smoothing is for the *align* phase only.

### 3.5 Framing gate is too strict and re-runs between every action (Medium)

`assessFraming` demands face width ≥ 34 % of the (square) frame and centre within 11 % — a laptop user at 55–70 cm reads "Move closer". Then `phase = "align"` restarts for **each** action with a fresh 350 ms lock, so each action pays 1–2 s of "Center your face" (12:45 0:07, 0:24, 0:28). Between actions the baseline should be re-established silently if the face is still present and roughly framed; only a lost face should re-prompt.

### 3.6 Coaching copy fires on a timer and contradicts itself (Medium)

`AWAIT_HINT_MS = 3500` shows "make the movement bigger and slower" regardless of what was observed. In 12:41 at 0:04 the tester is already fully turned and holding. The copy blames the user for a detector miss. Coaching should be derived from the detector state: face lost → "Turn back a little so we can still see your face"; no change at all → "Turn your head further"; face fine but no trigger after N s → "Hold the turn for a moment".

### 3.7 Selfie can be captured off-frontal (Medium)

The selfie step captures 550 ms after the framing lock; there is no yaw/pitch check. Both recordings show a slightly turned or leaning face at capture (12:41 0:18, 12:45 0:11). Passive liveness and face-match models score frontal faces best, so this is the most likely contributor to the two manual reviews. Landmarks (see §4.1) give a cheap frontal check.

### 3.8 Manual review gives the user and the tester nothing to act on (High for testability)

`GET /:sessionId/status` returns `{ success, sessionId, status }`. The widget contains rendering code for `result.decision?.reasonCodes` that can never execute. For end users, a curated, non-enumerable hint ("Lighting was too low", "Face was not fully visible") is appropriate; for developers the sample app should show the full `reasonCodes` and `rawResult.livenessChallenge.perAction` from the tenant API. Without this, every "under review" during testing is a black box — exactly the situation in 12:45.

### 3.9 "Run another" appears unresponsive (Low–Medium, unconfirmed)

In 12:41 the tester hovers/clicks "Run another" at 0:22 and 0:31 and the approved card stays for 45 s. `reset()` just clears React state, so either the clicks did not land or an exception during the widget's unmount/cleanup swallowed the update. Add a loading state and `console.error` guard on `reset`, and confirm with the browser console.

### 3.10 Remaining security gaps in the active-liveness path (carry-over)

* **Single still frame satisfies an action** — no trajectory continuity across the burst; a photo held up and moved would pass the geometry check client-side and only the server pose magnitude stands in the way.
* **`hasCapabilities === false` is collected but unused** — log its distribution before making it a signal.
* **Client-side direction is never checked** — the detector uses `|Δcx|`, so "turn left" is satisfied by a right turn. Landmarks fix this for free (§4.1); server `strictDirection` can then be calibrated and enabled.

---

## 4. Recommended improvements (ordered by impact)

### 4.1 Use the detector's landmarks for pose (fixes 3.1, 3.2, 3.7, 3.10) — **P0**

Two ways to get landmarks in the browser, in order of preference:

1. `fr_detect.onnx` is a RetinaFace-family model; if it exposes the landmark head, it is a third output with last dim 10 (5 points: eyes, nose tip, mouth corners). `faceDetector.js` currently keeps only the outputs whose last dim is 4 (boxes) and 2 (scores) and ignores anything else — log `session.outputNames`/dims once to confirm. Decoding it is the same priorbox math as `decodeBoxes` with `variance[0]`.
2. Otherwise ship `fr_landmark.onnx` (already used server-side in `providers/onnx.js`, 1.1 MB, 64×64 grayscale crop of the face box → 68 points, cheap enough to run every detection tick) and take the 5 anchor points via the existing `convert68pts5pts` logic in `onnxMath.js`. `fr_pose.onnx` (5.8 MB, 224×224) is the fallback if neither is workable, but it is heavier than a browser tick budget wants.

Either way, per frame you get:

* **yaw proxy:** nose-x relative to the eye midpoint, normalised by inter-ocular distance — signed, so direction is known;
* **pitch proxy:** nose-y relative to the eye line vs. the eye-to-mouth distance;
* **frontal check:** both proxies near zero → gate the selfie capture.

Detection then becomes "yaw proxy crosses ±θ for 2 ticks" instead of "box narrows before it disappears", which is what fires late. The miss clause stays as a backstop. Expected effect: turn/tilt triggers in the first 300–500 ms of the movement on both sides, no more left/right asymmetry, direction enforceable client-side, and the selfie is always frontal.

### 4.2 Feed the model an undistorted frame (fixes 3.3) — **P0**

Replace the square→320×240 stretch with a centred 4:3 crop of the video scaled uniformly to 320×240, and derive the overlay transform from the same crop rectangle. Re-tune `minRatio`/`GEO` once — they were fitted to the distorted frame.

### 4.3 Relax and de-duplicate the framing gate (fixes 3.5) — **P1**

`minRatio` 0.34 → ~0.26 for the liveness step (the selfie step can stay stricter); between actions, skip the align phase when the face is present and within tolerance — re-baseline silently and go straight to `await`.

### 4.4 Diagnosis-driven coaching (fixes 3.6) — **P1**

Replace the single timer hint with three states computed from `actionState` and `stable`: face lost mid-movement, no movement detected, movement seen but not held. Copy per state as in §3.6. Keep the 9 s fallback burst as the final safety net.

### 4.5 Draw the raw box during movement (fixes 3.4) — **P2**

Use the EMA box only in the align phase; in `await`/`capturing` draw the last raw detection (or hide the box and show only the arrow), so the overlay never trails the face.

### 4.6 Surface reasons safely (fixes 3.8) — **P1**

Add `reasonCodes` (and `perAction` for challenge failures) to the SDK status response **only for terminal, retryable outcomes**, mapped through a small allow-list to user-safe hints in the widget; expose the full set in the sample app from the tenant `GET /v1/verification-sessions/:id` for testing. The dead `result.decision.reasonCodes` branch then comes alive.

### 4.7 Multi-frame trajectory check in the worker (closes 3.10) — **P1**

With landmarks stored per frame (or yaw/pitch from the pose provider), require the burst to show a monotonic yaw/pitch trajectory from near-zero to past threshold across ≥2 frames with consistent inter-ocular scale. A single still frame, or a photo waved sideways, fails; a real head turn passes.

### 4.8 Sample-app and tester ergonomics — **P2**

Loading state on "Run another"; show reason codes and `perAction`; add a `?vpdebug` panel with live yaw/pitch proxies, detection latency, and frame-budget counters so future "it doesn't see my turn" reports come with numbers instead of a screen recording.

---

## 5. Expected outcome after 4.1–4.4

| Metric (from the two recordings) | Today | Target |
|---|---|---|
| Time to trigger, turn | 1–8 s (median ~2 s, worst 8 s) | < 1 s, both sides |
| Time to trigger, look up | 3–6 s | < 1.5 s |
| Spurious "Move closer" between actions | 2 per run | 0 |
| Misleading "bigger and slower" hints | 1–2 per run | 0 (hint names the actual problem) |
| Full liveness + selfie wall-clock | 17–20 s | 8–10 s |
| Unexplained manual reviews during testing | 2 of 2 | 0 (reason visible) |

---

## 6. What was already fixed in this cycle (for context)

Frame-budget dead-end on retry (nonce-fenced budgets), fallback burst after 9 s so a detector-blind movement can't stall the flow forever, frame↔challenge HMAC binding, pose enforcement on by default with `LIVENESS_POSE_UNAVAILABLE`, `LIVENESS_FRAME_BINDING_FAILED` metrics, smile removed from the challenge pool, virtual-camera capture-integrity signal. The recordings were made *before* the fallback-burst and pose changes were rebuilt into the sample app, so the 8 s turn_left in 12:41 would today resolve at ~9 s via fallback rather than only by luck — but the underlying detection latency is what §4.1 removes.
