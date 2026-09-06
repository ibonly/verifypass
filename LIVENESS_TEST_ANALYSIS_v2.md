# Liveness Check — Implementation & Confirmation Analysis (v2)

**Date:** 2026-09-04 · **Follows:** `LIVENESS_TEST_ANALYSIS.md` (v1)
**Method:** every recommendation from v1 was implemented, then the tester's two screen recordings (12:41 and 12:45) were replayed frame-by-frame through the *actual new SDK code* — same detector, same landmark model, same action detector the widget now runs — and compared against what the recorded app did on the same frames. Frames are 280×280 crops of the circular preview, un-mirrored, 10 fps, with the recording's own overlays baked in (so absolute numbers are slightly pessimistic).

---

## 1. The finding that changed the plan

While building the replay harness, the first thing to fall out was that **the face detector's output was being decoded wrongly — in the SDK and in the worker.**

`fr_detect.onnx` is an Ultra-Light-RFB-320 export. Its outputs are `scores [1,4420,2]` and `boxes [1,4420,4]`, and `boxes` are **already decoded** normalized corners (`x1,y1,x2,y2`, range −0.24…1.23 on real frames). Both `frontend/sdk/core/src/faceDetectMath.js` and `backend/src/worker/providers/onnxMath.js` ran RetinaFace prior-box decoding (`definePriorBox` + `decodeBoxes`) on that output, treating corners as regression deltas. The result on the tester's frames:

| | Old decoder | Fixed decoder |
|---|---|---|
| Frames where the "best face" was a whole-frame box (>50 % of the image, partly outside) | 141 / 190 (12:41) · 189 / 309 (12:45) | 0 · 0 |
| Box positions | snapped to the anchor grid (x ∈ {61, 92, 124, 156}, widths ∈ {110, 147}) | continuous, tracks the head through turns |
| Selection | largest-area → the artifact wins | plausibility-filtered (inside frame, ≤60 % area) |

`detector-old-vs-fixed.png` shows the same eight frames with the old box in red and the fixed box in green.

Consequences, now explained rather than tuned around:

* **Action detection was fed garbage.** Centre shift and "narrowing" happened only in anchor-sized jumps; the align lock and the movement baseline were often the whole-frame artifact. That is why triggers ranged from 0.3 s to 8 s with no relation to what the tester did, and why left/right behaved differently per machine.
* **The overlay looked misregistered** because it was the EMA of a box flipping between the artifact and the real face.
* **"Move closer" at a normal distance**: the artifact-vs-face flip drove the framing ratio.
* **Manual reviews**: the worker crops liveness, pose, landmarks and the face-match embedding from *its own* detector box — the same wrong box. Liveness scores and face-match similarity were computed on crops that only sometimes contained a face.

Everything in v1's §3.1–3.5 was a symptom of this. The fix is one config flag (`boxFormat: "corners"`) with the prior-box path kept behind `"deltas"` for RetinaFace-style models, plus a plausibility filter, in both places.

---

## 2. What was implemented

| v1 rec. | Status | Where |
|---|---|---|
| — | **Detector decode fixed (root cause)** + plausibility filter, SDK and worker | `faceDetectMath.js`, `onnxMath.js` |
| 4.1 Landmarks for pose | **Done.** `fr_landmark.onnx` (1.1 MB, already used by the worker) now runs in the browser per detection tick on the face crop; 68→5 points → signed `yaw` (nose offset / inter-ocular) and `pitch` (nose height between eye and mouth lines), median-3 smoothed. Detector = pose primary (signed, direction-aware), corrected box geometry as backup. Reports `wrongWay` and `magnitude` for coaching. | `core/src/landmarks.js`, `actionSignals.js`, `react/src/faceDetector.js` |
| 4.2 Undistorted model frame | **Not applied — replay said no.** Letterboxing the square into 320×240 gave the landmark model 25 % fewer face pixels and *slower* triggers than the current stretch; with the decoder fixed, the stretch is not the problem. Left as-is, documented. | — |
| 4.3 Framing gate | **Done.** `minRatio` 0.34 → 0.24 (measured median face width at laptop distance = 0.34, so half of good frames read "Move closer"); `centerTol` 0.11 → 0.13; the framing stabilizer persists across liveness actions and the re-lock is 120 ms instead of 350 ms when already locked; align→await additionally requires a frontal pose so the movement baseline is always frontal. | `VerificationWidget.jsx` |
| 4.4 Diagnosis-driven coaching | **Done.** Hint is derived from detector state, not a timer: `wrong_way` ("Other way — turn to YOUR LEFT"), `face_lost`, `further` ("Almost — turn a little further and hold it"), `none`. Rate-limited, re-evaluated as the state changes; the 9 s fallback burst remains. | `VerificationWidget.jsx` (`COACH_COPY`, `coachDiag`) |
| 4.5 Raw box during movement | **Done.** EMA box only while aligning; raw detection during await/capture. | `VerificationWidget.jsx` |
| 4.6 Reason codes | **Done.** `GET …/status` returns `decision.reasonCodes` for terminal outcomes, filtered through a server-side user-safe allow-list (quality/behaviour codes only; device, IP, velocity, integrity, screening and binding codes never reach the SDK). The widget's dormant reasons UI now renders, for manual review too ("What to improve if you try again"). Tenant `GET …/result` gains `livenessChallenge.perAction` with observed pose magnitudes. | `captures.js`, `sessions.js`, widget |
| 4.7 Multi-frame trajectory | **Done as a soft signal.** With ≥3 posed, timestamped frames per action the worker requires the burst to start near frontal, vary by ≥40 % of threshold and reach threshold; failure → `LIVENESS_MOTION_UNVERIFIED` → manual review (never reject — the fallback burst can legitimately start mid-movement). | `livenessChallenge.js` (`assessTrajectory`), `decisionEngine.js`, `pipeline.js` |
| 4.8 Tester ergonomics | **Done.** `?vpdebug` live panel (phase, guide, face ratio, yaw/pitch and deltas, ok/holding/wrongWay, frame budget). Sample app shows a developer-details block after each result: full reason codes, liveness/face-match scores, per-action present/live/pose/yaw°/pitch°. "Run another" state-clear guarded; the detail fetch is cancelled on reset. | widget, `sample-app/src/App.jsx` |
| Selfie frontal gate (v1 §3.7) | **Done.** Selfie capture additionally waits for `isFrontalPose` (|yaw| ≤ 0.25, pitch in 0.35–0.85) when landmarks are available. | widget |
| Challenge pool | `look_down` added (four head movements, three drawn → 24 sequences instead of 6). Motivated by §4 below. | `livenessChallenge.js` |

Tests: SDK core 95 (+10), shared 73 (+4), backend 212 (+1); the only failure remains `uploadFlow.test.js`, which needs the macOS `sharp` binary this Linux workspace can't load. Bundles rebuilt (`sample-app/dist`, `frontend/verify-page/dist`); `fr_landmark.onnx` is served from `sample-app/public/models/`.

---

## 3. Confirmation replay — recorded app vs new SDK, same frames

### 3.1 Action trigger latency (seconds from the instruction appearing; includes the tester's own reaction time)

| Action | Recording | As recorded | New SDK | Channel that fired |
|---|---|---|---|---|
| turn_left | 12:41 | **8.0 s** | **2.3 s** | pose |
| turn_right | 12:41 | 1.2 s | 0.9 s | geometry |
| look_up | 12:41 | 3.0 s | 1.8 s | pose |
| turn_right | 12:45 #1 | 1.2 s | 0.3 s | geometry |
| turn_left | 12:45 #1 | 2.2 s | 1.8 s | pose |
| turn_right | 12:45 #2 | 2.2 s | 0.3 s | geometry |
| turn_left | 12:45 #2 | 2.2 s | 1.5 s | geometry |
| look_up | 12:45 #2 | 6.0 s | *not triggered* — see §4.1 | — |

Median 2.2 s → 1.5 s; worst case 8.0 s → 2.3 s. In the 12:41 turn_left the tester begins moving at ~1.3 s and the new detector fires at 2.3 s — i.e. ~1 s of movement, versus the recorded app which needed 8 s and a coaching hint that told him to do it "bigger and slower" while he was already fully turned. Direction was read correctly on all six turns (left → negative yaw, right → positive); `wrongWay` never fired.

Pose trace, 12:41 turn_left (yaw): `0.06, 0.09, 0.09, 0.09 → −0.08 (2.0 s) → −0.36 (2.5 s) → −0.40 → −0.31 → 0.05 (back)`. Clean, signed, with a noise floor under 0.1.

### 3.2 False triggers

15 static windows (user holding still) × 3 actions each, through the full new detector: **0 / 15** false triggers.

### 3.3 Framing guidance on the frames where the recorded app said "Move closer"

12:45 0:03–0:04 → `ok` 16 / 19 frames (2 `move_closer`, absorbed by the stabilizer dwell); 12:45 0:28 → `ok` 9 / 11. The spurious "Move closer" is gone; the remaining `center` verdicts at 12:41 0:12 are real (the tester was still re-centering after a turn).

### 3.4 Selfie frontal gate

All three recorded selfie windows pass the gate within 0.1–0.2 s of the window opening, while the 12:45 attempt-1 window (where the recorded selfie was taken mid-lean, yaw down to −0.42) would now wait for one of the 13 / 17 frontal frames instead.

### 3.5 Detection quality

Face box on 183 / 190 (12:41) and 281 / 309 (12:45) frames, a pose on every one of them, and zero whole-frame boxes.

---

## 4. New issues identified

### 4.1 "Look up" is physically small on a laptop (High for UX)

In the 12:45 second attempt the tester was asked to look up for 6 s; the pose trace is flat the whole time (`pitch 0.55–0.64`, box height stable). He was tilting, but toward a camera mounted *above* eye level, which makes the face *more* frontal, not less. The recorded app's "Got it" at 6 s was a spurious geometry event on a garbage box; the new detector correctly does not fire, coaches `none` ("tilt your head slowly and hold"), and would fall back to a burst at 9 s — which the server then judges on pose magnitude (and now trajectory), so this session would likely end in review again. Mitigations shipped: `look_down` added to the pool so not every challenge contains look_up. Recommended next: coach look-up as "lift your chin toward the ceiling", and/or weight the pool by camera facing/height (mobile front cameras sit *below* eye level, where look-up is large and look-down is small).

### 4.2 Worker score distributions have shifted (High for calibration)

Every liveness score, pose angle and face-match similarity produced before this fix was computed on crops from the wrong box. `liveness.pass = 0.85 / reject = 0.7`, `faceMatch.pass = 0.82 / reject = 0.65` and the challenge floors were effectively tuned against noise. Expect approvals to become *more* consistent, but re-calibrate thresholds on a week of post-fix traffic (`rawResult` carries the observed magnitudes) before trusting the borderline bands. `ENFORCE_POSE=false` remains the calibration switch.

### 4.3 Direction sign assumes camera-native frames (Medium)

Signed coaching relies on getUserMedia delivering un-mirrored frames (true on every browser tested; the preview mirror is CSS). A device that delivers pre-mirrored frames would invert `wrongWay` coaching; the flow still completes (pose magnitude backup + fallback burst), but the hint would be wrong. Add a one-time sign self-check on the first completed turn (if the first turn of a session lands `wrongWay` on both a left and a right action, flip the sign for that session) before enabling `strictDirection` server-side.

### 4.4 Fallback bursts can fail the trajectory check (Low)

A 9 s fallback burst starts mid-movement, so its frames may all sit at the angle → `LIVENESS_MOTION_UNVERIFIED` → review. With pose-based detection the fallback should be rare; monitor `perAction.trajectory` in `rawResult` and, if it is common, take the early shot in fallback mode as well.

### 4.5 Per-tick cost went up (Low)

Each detection tick now also runs the 64×64 landmark model (~2–6 ms WASM). At `DETECT_MS = 110` this is well within budget on a laptop; on low-end Android it may push the tick to ~150 ms. The `?vpdebug` panel is the place to read the real cadence if a device feels sluggish.

### 4.6 Harness limitations (for honesty)

The replay frames are screen-recording crops with the app's pill, arrow and old box overlays baked in, recompressed, at 10 fps. Real camera frames are cleaner and 9 fps faster, so the latencies above are upper bounds; the false-trigger count is the number most worth re-checking on live video.

---

## 5. Before / after against v1's targets

| Metric | v1 (recorded) | Now (replay) | v1 target |
|---|---|---|---|
| Time to trigger, turn | 1.2–8.0 s | 0.3–2.3 s | < 1 s of movement ✔ |
| Time to trigger, look up | 3–6 s | 1.8 s (12:41); correctly none when no tilt (12:45) | < 1.5 s (needs §4.1) |
| Spurious "Move closer" | 2 per run | 0 | 0 ✔ |
| Misleading "bigger and slower" hints | 1–2 per run | 0 (diagnosis copy) | 0 ✔ |
| Whole-frame detector boxes | ~50–75 % of frames | 0 | — |
| Unexplained manual reviews | 2 of 2 | reasons shown; per-action detail for testers | ✔ |

## 6. To run it

`cd backend && npx prisma generate` (unchanged schema this round; still needed if not done since the binding fields), restart API and worker; hard-refresh the sample app (new bundle + `fr_landmark.onnx`); open with `?vpdebug` to see pose numbers live.
