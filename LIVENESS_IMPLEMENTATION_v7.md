# Liveness — Free (zero run-cost) AI Improvements Implemented (v7)

**Date:** 2026-09-05 · **Implements:** every no-cost item of `LIVENESS_AI_ROADMAP.md` — Tier 0.1–0.5 and Tier 1.1 (screen flash, which costs nothing to run).
**Tests:** shared 87 (+6), backend 222 (+6; the only failure is still `uploadFlow.test.js`, whose macOS `sharp` binary cannot load in the Linux workspace), SDK core 103 (+5). Bundles rebuilt: `sample-app`, `verify-page`, `dashboard`.
**Everything new is record-first:** each signal is computed and stored for every session and shown to reviewers, but changes a decision only when its enforcement switch is on (see Deploy).

## 0.2 Rigidity / "3D-ness" of head turns — `LIVENESS_FLAT_OBJECT`

* `assessRigidity(framePoints)` (`shared/livenessChallenge.js`): least-squares 2-D affine fit from the first frame's eyes + mouth corners to each later frame; the **nose residual** (in inter-ocular units) measures parallax. A print or a phone screen turned in the hand is a plane → residual ≈ 0; a real head → residual 0.2+.
* Worker: `providers/onnx.js` gained `faceLandmarks(buf)` (detector → 68-point model → five anchors + EAR/MAR); `pipeline.js` attaches `points`/`expr` to every challenge frame; the verifier runs rigidity on every turn/tilt burst and records `perAction[a].rigidity = {ok, maxResidual, motion, frames}`.
* Verdict → `flatObject` → **manual review** by default; `CHALLENGE_ENFORCE_RIGIDITY=true` (or `tenant.settings.challenge.enforceRigidity`) makes it a reject.
* **Calibrated on the replayed recordings (4-frame bursts, like the worker sees):** real turns → residual 0.23–0.33 at motion 0.5–1.1; a weak look-up → 0.078 at motion 0.18; a near-static frontal stretch → 0.053 at motion 0.12. Thresholds: flat below **0.06**, judged only when motion ≥ **0.2** (so a barely-moving genuine face is *not judged* rather than flagged). Synthetic planar motion → residual < 0.01.

## 0.1 Blink and open-mouth challenges from the 68 landmarks

* Shared: `eyeAspectRatio`, `mouthAspectRatio`, `assessExpression(action, frames)` — blink needs a frame with EAR ≤ 0.6 × the burst's open EAR; open_mouth needs inner-lip MAR ≥ 0.35 or ≥ 1.8 × rest. Failure → `LIVENESS_CHALLENGE_FAILED` when `enforcePose` (default on). `perAction[a].expression` recorded.
* Challenge composition: **both turns + one of {look_up, look_down, blink, open_mouth}**, shuffled → 48 sequences instead of 4 (harder to pre-record).
* SDK core (`landmarks.js`): `exprFromLandmarks(raw, box)` → `{ear, mar}`; `faceDetector.js` returns `expr` per detection; `createActionDetector` implements **blink** (open-eye baseline from the first 4 samples → closed ≤ 60 % for 2 ticks → re-open ≥ 85 %; a squint or a one-tick dip never fires; the closed-eye frame is captured at the first closed tick so the server sees it) and **open_mouth** (held for 2 ticks). Head movement cannot fire either; without ratios `open_mouth` reports `blind` → the widget fails closed to manual capture.
* Widget copy: "Close your eyes for a second, then open them" (a real ~150 ms blink is too fast for the capture pipeline, so the copy asks for a slow one), "Open your mouth wide and hold it for a moment"; coaching lines for both; burst shots for blink follow the schedule so the burst holds closed **and** re-opened frames. Vanilla SDK copy updated.

## 0.4 Identity continuity across **all** challenge frames

`livenessIdentity` now compares the selfie embedding with **every** single-face frame within ±25° yaw (min similarity decides; mean and per-frame values recorded). A person swapped mid-challenge, or a face-swap that drifts between frames, is caught by the frame that differs. Same thresholds as face match; falls back to the single best frame when the provider has no embedding API.

## 0.3 Screen/print texture heuristics (record only)

`rawResult.liveness.texture = {hfRatio, moire, colorCast, glowFrac}` from the selfie face crop (Laplacian energy ratio, lag-2/3/4 autocorrelation of the Laplacian = moiré, R−B cast, saturated fraction around the face = screen glow). Not a decision input until calibrated with the threshold script.

## 0.5 Telemetry anomaly job (nightly, no model)

`backend/src/worker/telemetryAnomaly.js` + job type `telemetry_anomaly` (`worker.js`, `worker.lambda.js`, `scripts/enqueueJob.js`). Over the last 14 days it fits **median/MAD per tenant and action** of the widget's time-to-trigger and flags: `instant` (< 300 ms), `too_fast` (≥ 2 actions below max(median − 3·MAD, ¼ median) and < 700 ms; needs 20 samples), `uniform` (all actions within 60 ms of each other and never coached), `duplicate` (another session in the window with every action timing within ±10 ms — a replay rig), `device_uniform` (≥ 3 sessions on one device fingerprint with < 8 % variation in mean timing — a farm). Writes `rawResult.riskSignals.telemetryAnomaly` and an audited `telemetry.anomaly` risk event; idempotent. Humans in the unit-test population (30 varied sessions) are never flagged.

## 1.1 Screen-flash active illumination (zero run-cost)

* Widget: right after the selfie upload, a full-screen overlay flashes a **dark baseline + 4 random distinct colours** (280 ms each, sampled 190 ms after each switch) while the face crop (same 320-px frame the detector analyses) is tiled into one 480×96 mosaic → `POST …/flash` with the emitted sequence. Copy: "Hold still — checking lighting". Best-effort: any failure never blocks the customer. Prop `screenFlash={false}` opts out.
* Server: upload kind `flash` (label `flash`, nonce-bound like every liveness frame, max 2 per attempt, sequence validated against the palette; new evidence field `meta`). Worker: mean RGB of the central 60 % of each tile; `scoreFlashResponse` (shared `livenessFlash.js`) correlates the per-tile colour response (zero-meaned per channel, so uniform brightening does not count) with the emitted sequence → `rawResult.liveness.flash = {ok, score, magnitude, reason, sequence}`; `ok:null` = inconclusive (baseline already saturated by daylight), `no_response` / `wrong_response` = conclusive negatives.
* `CHALLENGE_ENFORCE_FLASH=true` (or tenant `enforceFlash`) → `LIVENESS_FLASH_UNVERIFIED` → manual review. Record for two weeks first: check score/magnitude distributions per device class in the dashboard.
* Limitation (by design, browser-only): the sequence is chosen client-side and reported with the mosaic; it defends against replays, prints and pre-rendered injection, not against an injector that renders in real time while reading the screen — that is the native-attestation tier of the roadmap.

## Reviewer view

Dashboard session detail → challenge table gains **3D** (rigidity, hover for residual/motion) and **Expr** columns, plus a line with the flash result, texture scalars and telemetry anomaly flags (`livenessSignals` in the dashboard route).

## Deploy

1. `cd backend && npx prisma generate && npx prisma db push` (new optional `evidence_files.meta`).
2. Restart API **and** worker (shared + worker + routes changed).
3. New env (all optional, default off): `CHALLENGE_ENFORCE_RIGIDITY`, `CHALLENGE_ENFORCE_FLASH`; cron `0 3 * * * node scripts/enqueueJob.js telemetry_anomaly` (EventBridge `{type:"telemetry_anomaly"}` on Lambda).
4. Hard-refresh the sample app, hosted page and dashboard (bundles changed). The vanilla `sdk/js` bundle (esbuild) must be rebuilt on the Mac: `cd frontend/sdk/js && npm run build`.
5. After a week: read rigidity residuals, flash scores and telemetry flags in the dashboard, then enable enforcement per tenant. Blink/open_mouth are already live in the challenge pool — watch their `msToTrigger` and coaching counts in telemetry; if a device class struggles, the reissue button ("try a different movement") is the escape hatch.

## Not done / follow-ups

* Staged-attack data (printed photo, phone video) has not been recorded yet — the replay harness only holds genuine sessions, so the "flat" side of the rigidity and flash thresholds rests on synthetic planar motion and the physics, not on captured attacks. One afternoon with the sample app will settle both.
* Texture heuristics have no thresholds yet (record-only until `calibrate-thresholds.js` sees attack data).
* Git: the workspace could not write `.git/index.lock`, so nothing is committed — review `git status` and commit from the Mac.
