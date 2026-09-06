# Liveness Check — Action-Matching Defects: Independent Analysis & Fix (v3)

**Date:** 2026-09-04 · **Report:** "turning the head LEFT completed all three actions" on webcam and on mobile.
**Method:** the widget's liveness state machine was re-derived from source without reference to earlier reports, each candidate defect was reproduced on the tester's recorded frames through the SDK's own detector code, then fixed and re-validated the same way.

---

## 1. Reproduction (before the fix)

One recorded LEFT turn (12:41, 0–8.5 s) fed to the three action detectors, exactly as the widget runs them:

| Scenario | turn_left | turn_right | look_up |
|---|---|---|---|
| 1. Instruction shown while frontal, user turns LEFT | fires 2.3 s (pose) | **fires 2.4 s (geometry)** | **fires 6.0 s (geometry)** |
| 2. Next instruction shown while the user is STILL TURNED LEFT; user returns to centre | fires 3.6 s | **fires 3.6 s** | — |
| 3. No landmark model (hosted page / mobile), LEFT turn | fires 2.4 s | **fires 2.4 s** | **fires 6.0 s** |

That is the field report, reproduced: the instructed action fires, then every other action is satisfied by the same movement or by the return to centre.

---

## 2. Root causes (five independent defects, all confirmed)

**D1 — The hosted page ran the liveness step with no face detector at all.** `frontend/verify-page` (the URL end users, including mobile testers, are sent to) never passed `faceModelUrl`, and the widget's liveness branch for the no-model case fell through to *motion-settle auto-capture*: hold still for 550 ms and the current action "completes", whatever it was. The code comment claimed the step fails closed; the code did not. On mobile this alone explains "all three triggered".

**D2 — Box geometry was direction-agnostic and OR-ed with the pose channel.** `actionGeometry` used `|Δcx|`, so a left turn satisfied `turn_right`, and `ok = geometryOk || poseOk` let geometry win even when the landmark model said the direction was wrong.

**D3 — The movement baseline was captured at instruction time.** The next action's reference pose/box was whatever the face was doing when the instruction appeared — usually still turned from the previous action. Returning to centre then read as a movement in the opposite direction (scenario 2).

**D4 — The "face disappeared mid-movement" clause inherited lateral movement for tilts.** When a frontal detector lost the face during a turn, the clause counted the misses as `look_up`-consistent if the last box had *any* vertical drift ≥ 4 %. That is the 6.0 s `look_up` in scenarios 1 and 3.

**D5 — The 9 s fallback burst captured with no movement evidence at all**, even when the landmark channel was live and could see that nothing had happened.

Server-side there is a sixth, pre-existing gap that makes the above invisible in results: `poseSatisfiesAction` checks magnitude only (`strictDirection` off), so a left turn uploaded under `turn_right` passes verification too.

---

## 3. Fixes

| Defect | Fix | Where |
|---|---|---|
| D1 | Liveness step now **fails closed** without a working detector: no auto-capture, copy "Automatic detection isn't available here — do the movement, then tap Capture manually" (server verifies pose on what it receives). The hosted page ships `fr_detect.onnx` + `fr_landmark.onnx` from `/models/` and passes `faceModelUrl`. | `VerificationWidget.jsx`, `verify-page/src/App.jsx`, `verify-page/public/models/` |
| D2 | `boxMetrics` returns **signed** shifts; turns require the centre to move the *instructed* way (camera-native convention verified on the recordings: left turn → smaller x / negative yaw). The narrowing signature also needs a sign-consistent drift. When landmarks are live, **pose is the only judge**; geometry cannot trigger. | `actionSignals.js` |
| D3 | **Session frontal reference**: the median of tight-frontal pose samples (|yaw| ≤ 0.15) accumulated while aligning, captured once per liveness step and reused for every action. **Arming**: a detector counts nothing until the face has been frontal (within 0.12 of the reference) for two consecutive samples after the instruction. A reference captured off-centre self-heals when the face has looked reference-frontal for 8 samples without arming. | `actionSignals.js`, `landmarks.js`, widget |
| D4 | Miss clause only applies in geometry-only mode, only when the last box was already moving the instructed way, and tilts require vertical dominance. | `actionSignals.js` |
| D5 | Fallback burst fires only when there is **no pose channel**. With landmarks live the widget keeps coaching (`recenter` → "Face the camera straight first — then do the movement", `wrong_way`, `further`, `face_lost`, `none`) and leaves manual capture available. | widget |
| server | Signed peak yaw/pitch per action recorded in `rawResult.livenessChallenge.perAction` (`peakYaw`, `peakPitch`) and shown in the sample app's developer block, so `strictDirection` can be enabled once the deployed pose model's sign is confirmed. | `livenessChallenge.js`, `sample-app` |

Also: `pitchDown` threshold 0.20 → 0.25 (return overshoot from a look-up measured +0.26); the geometry baseline is no longer re-snapped to the arming frame (that frame's jitter turned into a false right turn in replay).

Tests: SDK core 98 (+3 direction-lock tests, existing geometry tests migrated to the signed convention), shared 73, backend 212 (+ the known `sharp`-binary environment failure). Bundles rebuilt for `sample-app` and `verify-page`.

---

## 4. Validation on the same recordings (after the fix)

### 4.1 The reproduction scenarios

| Scenario | turn_left | turn_right | look_up | look_down |
|---|---|---|---|---|
| 1. LEFT turn from frontal | 2.3 s | — | — | — |
| 2. Instruction while still turned LEFT, then return to centre | arms at 6.2 s (only once frontal), fires 7.5 s on the *next* real left turn | — | — | — |
| 3. Geometry only, LEFT turn | 2.4 s | — | — | — |

### 4.2 Cross-action matrix — every detector run over every recorded movement (`*` = instructed)

```
A performed turn_left  | *turn_left  2.3s |  turn_right   - |  look_up      - |  look_down    -
A performed turn_right |  turn_left    -  | *turn_right 1.2s |  look_up      - |  look_down    -
A performed look_up    |  turn_left    -  |  turn_right   - | *look_up   1.9s |  look_down 3.1s †
B performed turn_right |  turn_left    -  | *turn_right 1.2s |  look_up      - |  look_down    -
B performed turn_left  | *turn_left  2.1s |  turn_right   - |  look_up      - |  look_down    -
B performed turn_right |  turn_left    -  | *turn_right 1.6s |  look_up      - |  look_down    -
B performed turn_left  | *turn_left  1.8s |  turn_right   - |  look_up      - |  look_down    -
B performed look_up    |  turn_left    -  |  turn_right   - | *look_up      - ‡|  look_down    -
```
Instructed action fired 7 / 8; other actions fired on the same movement 1 / 24.
† the return overshoot *after* the look-up — in a real session the next action is not yet armed at that moment (see 4.3), so it cannot fire. ‡ the 12:45 second look-up: the pitch trace is flat for six seconds; the tester did not physically tilt enough toward a camera mounted above eye level (v2 §4.1). The old app "detected" it at 6 s on a garbage box; the new one correctly does not.

### 4.3 Continuous sessions, actions chained as the widget chains them

* 12:41 (turn_left → turn_right → look_up): turn_left armed 0.2 s, fired 2.3 s · turn_right armed only at 6.2 s when the face came back to centre, fired 11.0 s (and correctly coached `wrong_way` when the tester turned left again at 7.4–8.0 s) · look_up armed 13.2 s, fired 14.9 s. Recorded app: 8.0 / 11.0 / 16.0 s.
* 12:45 attempt 2 (turn_right → turn_left → look_up): fired 22.4 s and 26.6 s (recorded 23.0 / 27.0), look_up never — correctly.

---

## 5. Residual issues / what to watch

1. **A user who cannot perform an action now waits instead of being waved through.** With pose live, nothing auto-captures until the instructed movement is seen; the coaching names the problem and "Capture manually" remains. This is the intended trade — the alternative was the old behaviour. Consider a "Skip this action → different action" affordance after ~15 s rather than a silent fallback.
2. **Server verification is still direction-blind** until `strictDirection` is enabled. Collect a day of `peakYaw`/`peakPitch` per instructed action, confirm the sign convention of `fr_pose.onnx`, then set `settings.challenge.strictDirection = true`. Until then the client is the only direction check.
3. **Frontal reference drift within a session.** The 12:41 session's frontal pitch moved from 0.43 to ~0.55 as the tester changed posture; the self-heal covers arming, but a slow drift could delay arming by a second or two. Re-sampling the reference at every align (already done, median over up to 15 samples) should keep this bounded; the `?vpdebug` panel shows Δyaw/Δpitch live if it doesn't.
4. **Mirrored front cameras.** Direction assumes camera-native frames (verified on this webcam; standard on iOS/Android browsers). A device delivering pre-mirrored frames would invert `wrong_way` coaching and block the turn actions (they would never move the "instructed" way). A one-time self-check — if the first turn of a session shows a clear, sustained `wrongWay` on the *instructed* side twice, flip the sign for the session — is the next hardening step.

## 6. To run it

Restart API and worker (shared code changed); hard-refresh the sample app and the hosted verify page (both bundles and the models under `/models/` changed). Open with `?vpdebug` to see `armed`, Δyaw/Δpitch and `wrongWay` live.
