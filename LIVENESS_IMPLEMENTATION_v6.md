# Liveness Workflow — v5 Gap Fixes Implemented (v6)

**Date:** 2026-09-04 · **Implements:** every item in `LIVENESS_GAP_ANALYSIS_v5.md`, in the suggested order.
**Tests:** shared 81 (+5), backend 216 (+4), SDK core 98 (+1 rewritten, +1 new); the only failure is still `uploadFlow.test.js`, whose macOS `sharp` binary cannot load in this Linux workspace. Bundles rebuilt: `sample-app`, `verify-page`, `dashboard`.

## Batch 1 — server consistency + sequence (A1, A2)

* **Challenge composition**: every challenge now contains **both turns + one tilt**, shuffled (`generateLivenessChallenge`, with `excludeActions` support). Both turns are required for the consistency check.
* **Direction consistency** (`assessConsistency`): `turn_left`/`turn_right` must produce opposite-signed `peakYaw` (same for the tilts on `peakPitch`) — a device-independent direction check. Recorded in `rawResult.livenessChallenge.consistency` for every session; **enforced** only when `CHALLENGE_ENFORCE_CONSISTENCY=true` or `tenant.settings.challenge.enforceConsistency` → `LIVENESS_DIRECTION_INCONSISTENT` (reject).
* **Sequence / timing** (`assessSequence`): issued order must be monotonic, each action's frames within 6 s, whole challenge within 90 s, first frame within 3 min of issue. Recorded always (`…sequence`); enforced via `CHALLENGE_ENFORCE_SEQUENCE=true` / tenant setting → `LIVENESS_CHALLENGE_SEQUENCE_INVALID` (reject). **Ship logging-only, turn on after a week of data.**

## Batch 2 — manual capture (A3)

* Liveness frames carry `captureMode: auto | fallback | manual` (SDK → route → `uploadService` → evidence row `capture_mode`; Prisma schema updated).
* Widget hides "Capture manually" on the liveness step whenever the detector is live; it remains for the fail-closed case.
* Worker counts `manualFrames` per action; any manual frame → `LIVENESS_MANUAL_CAPTURE` → **manual review, never auto-approve**.

## Batch 3 — capture loop + accessibility (B1, B3, D1)

* Frame budget 6 → **8** on both sides (two full cycles); on exhaustion the widget no longer advances silently — it explains and shows **"Continue to the next movement"**; redo cycles skip the early shot.
* Retry clears the frontal reference, reference samples and stabilizer.
* Instructions are **screen-relative**: "toward the arrow on the LEFT side of the screen"; arrows carry the same `aria-label`; the pill and the hint line are `aria-live` regions. Look-up copy: "lift your chin toward the ceiling".

## Batch 4 — calibration tooling (C1)

`backend/scripts/calibrate-thresholds.js [--tenant tnt_x] [--days 30] [--json]` — genuine/impostor split from reviewer decisions + fraud codes, per-model-version score quantiles, FAR/FRR grid, recommended reject/review/pass band (FAR ≤ 0.5 %, FRR ≤ 2 %), EER. Prints only; never writes settings. Pure helpers unit-tested.

## Batch 5 — worker verification quality (A4, C3, A6)

* **Identity continuity**: the selfie is compared (same embedding model) with the most frontal single-face challenge frame; `< faceMatch.reject` → `LIVENESS_IDENTITY_MISMATCH` (reject), borderline → `LIVENESS_IDENTITY_BORDERLINE` (review). Recorded as `rawResult.livenessIdentity`.
* **Multi-frame passive liveness**: decision score = **median** of the selfie score and the 3 most frontal challenge-frame scores (`rawResult.liveness.passiveAggregate`, raw selfie score kept for calibration).
* **Occlusion / multi-face**: selfie `occluded` → `FACE_OCCLUDED` (review); a second face in every frame of ≥2 actions → `MULTIPLE_FACES_DURING_CHALLENGE` (review).

## Batch 6 — everything else

| Item | Done |
|---|---|
| E1 telemetry | Widget records per action `msToTrigger`, coaching hints, `wrongWay` count, frames, mode, reissued; plus detect pass time and model load time; sent with `submit()` as `telemetry`, whitelisted into `deviceMeta.telemetry`. Risk signal `captureAnomaly` (≥2 actions "triggered" < 300 ms) → `CAPTURE_INTEGRITY_RISK` review. |
| D3 reissue | `POST …/challenge/reissue { excludeActions }` (mid-capture, max 2 per session, audited `challenge.reissued`); widget offers **"I can't do this movement — try a different one"** after 15 s without a trigger. |
| D2 | Look-up coaching copy; tilt swap via reissue (camera-facing preference left as a follow-up: the challenge is generated before the device is known). |
| B2 burst hold | Burst shots 2–3 require the pose to still be ≥ 60 % of threshold; if released, the action finishes with the frames already captured (`advanceOnly`), no frontal padding frames. |
| B4 timing | Detect pass time measured (EMA); coaching fires after 12 samples (and ≥ 2.5 s) instead of a wall-clock timer; WASM uses 2 threads on capable devices. |
| B5 camera loss | `track.onended` + `visibilitychange` → "Camera paused — tap to resume" restarts the stream; the liveness loop re-aligns. |
| D4 bandwidth | Liveness frames captured at ≤ 640 px, JPEG 0.85 (selfie/document unchanged). |
| A5 token | SDK sends `X-VP-SDK-Token`; server accepts header first, query still accepted with `Deprecation` headers for one release. |
| C2 pose outage | No pose on *any* frame → `LIVENESS_POSE_PROVIDER_UNAVAILABLE` (review + ops signal) instead of rejecting the customer; missing on one action only stays `LIVENESS_POSE_UNAVAILABLE`. |
| E2 review view | Dashboard session detail shows a per-action table: face/live/pose, signed yaw/pitch peaks, motion, frames (manual count), mode, time-to-trigger, coaching; plus consistency, sequence, binding rejects, performer↔selfie similarity, detect ms. Route returns `livenessChallenge`, `livenessIdentity`, `captureTelemetry`. |
| E3 consent | Consent copy names ID images, selfie, head-movement frames, device/camera details, biometric processing and tenant-policy retention; version `2026-09-04.1`. **Legal review required before production.** |

## Deploy

1. `cd backend && npx prisma generate && npx prisma db push` (new optional field `evidence_files.capture_mode`).
2. Restart API and worker. New env (all optional): `CHALLENGE_ENFORCE_CONSISTENCY`, `CHALLENGE_ENFORCE_SEQUENCE` (default off = record only), `MAX_LIVENESS_FRAMES_PER_ACTION` (default 8).
3. Hard-refresh sample app, hosted page and dashboard (bundles changed).
4. After a week: run `node scripts/calibrate-thresholds.js`, review `consistency`/`sequence` distributions in the dashboard, then enable enforcement per tenant.

## Not done / follow-ups

* Facing-aware tilt selection (D2 second half) needs the challenge to be generated after the camera is known — a `GET /challenge?facing=` negotiation before the first frame; deferred.
* `strictDirection` server-side remains off by design (device mirroring); consistency is the device-independent substitute.
* Consent copy wording is engineering's draft — legal/compliance sign-off pending.
