# Liveness Workflow — Gap, Bug & Improvement Analysis (v5)

**Date:** 2026-09-04 · **State reviewed:** the workflow after v4 (arrow-relative, pose-only triggering, frontal arming, fail-closed without landmarks), which you confirmed works.
**Scope:** `VerificationWidget.jsx` capture loop, `actionSignals.js`/`landmarks.js`, `client.js`, `captures.js`, `uploadService.js`, `pipeline.js`, `livenessChallenge.js`, `decisionEngine.js`. Every item names the file, the exact behaviour, why it matters (security / correctness / UX / compliance), and the fix. Items are ranked by risk to a fintech deployment, not by effort.

---

## A. Security / anti-spoofing gaps (fix before onboarding a paying tenant)

### A1. The server still cannot check direction — but it *can* check consistency (High)

`poseSatisfiesAction` verifies magnitude only (`strictDirection` off) because the server cannot know whether a device delivered mirrored frames (v4 finding). Consequence: a replay of three turned-head photos in any direction passes the server if magnitudes are right; the client is the only direction check, and the client is attacker-controlled.

**Fix — mirror-agnostic consistency instead of absolute direction.** Whatever the mirroring, `turn_left` and `turn_right` in the same session must produce **opposite-signed** peak yaw, and `look_up`/`look_down` opposite-signed peak pitch. Make the generator always issue both turns (both turns + one tilt, or all four), then in `verifyLivenessChallenge`:

```js
// after perAction is filled
const L = perAction.turn_left, R = perAction.turn_right;
if (L && R && typeof L.peakYaw === "number" && typeof R.peakYaw === "number") {
  const consistent = Math.sign(L.peakYaw) !== Math.sign(R.peakYaw) && L.peakYaw !== 0 && R.peakYaw !== 0;
  if (!consistent) reasonCodes.push("LIVENESS_DIRECTION_INCONSISTENT"); // hard fail
}
// same for look_up / look_down on peakPitch when both are present
```
`peakYaw`/`peakPitch` are already recorded per action (v3). Add the reason code to `reasonCodes.js` (reject-class) and `USER_SAFE_REASON_CODES` should *not* include it. This closes the "same photo relabelled left and right" and "turn one way for both" cases without knowing the mirror state.

### A2. No ordering or timing check on challenge frames (High)

`assessTrajectory` checks motion *within* an action, but nothing checks that actions happened **in the issued order** or within a plausible **time window**. An attacker with a library of pre-captured frames of the victim can upload them under the right labels at leisure.

**Fix** (in `verifyLivenessChallenge`, using `createdAt` already carried on frames):
* First-frame time of action *k+1* must be ≥ last-frame time of action *k* (issued order is monotonic).
* All frames of one action within ≤ 6 s of each other; whole challenge completed within ≤ 90 s of `issuedAt` (the widget completes in ~10 s; the 10-min TTL is far too generous for the *movement* part — keep it for the session, tighten it for the challenge).
* Reason code `LIVENESS_CHALLENGE_SEQUENCE_INVALID` (reject). Store `sequence: {ok, spanMs, gapsMs[]}` in `perAction`/`rawResult` for calibration first, enforce after a week.

### A3. "Capture manually" during liveness bypasses the action check (High)

`capture()` called from the button uploads one frame with `livenessAdvance = true`. Three taps complete the challenge with three frontal frames. The server catches this **only** when `enforcePose` is on; tenants may disable it during calibration, and `LIVENESS_POSE_UNAVAILABLE` turns off enforcement when the provider returns no pose.

**Fix:**
* Widget: hide the manual button while `poseGate` is true (the detector is live); show it only in the fail-closed state.
* Upload path: add `captureMode: "auto" | "manual" | "fallback"` to the liveness-frame body; `uploadService` stores it on the evidence row (`captureMode String?`), the worker records `manualFrames` per action, and the decision engine routes any challenge containing manual frames to `manual_review` (`LIVENESS_MANUAL_CAPTURE`), never auto-approve. This is also the honest signal for fraud analytics.

### A4. No identity continuity between challenge frames and the selfie (Medium-High)

Face match compares **selfie ↔ ID**. Liveness frames are scored for spoof and pose but never for *who*. A live accomplice can perform the challenge while the selfie/ID belong to someone else; passive liveness on the selfie does not detect a *different live person*.

**Fix (worker):** the ONNX provider already has `fr_feature` + alignment. Compute one embedding from the best-scoring frontal challenge frame (the "early shot" of the first action) and compare to the selfie embedding; `similarity < faceMatch.reject` → `LIVENESS_IDENTITY_MISMATCH` (reject); borderline → review. One extra embedding per session, ~50 ms.

### A5. SDK token travels in query strings (Medium)

`client.getChallenge()` and `getStatus()` send `?sdkToken=…`. Query strings land in access logs, proxies, CDN logs and browser history — an 8-hour-ish session credential in plaintext logs.

**Fix:** accept the token in an `X-VP-SDK-Token` header (keep query for one release for compatibility, log a deprecation warning), switch the SDK, and scrub `sdkToken` from request logging (`auditLogger` — check the `req` serializer).

### A6. Occlusion and multi-face signals from challenge frames are discarded (Medium)

`checkLiveness` returns `occluded`; only the selfie's value is stored in `rawResult` and **nothing** decides on it. Challenge frames accept `faceCount >= 1` (a second face in frame is fine mid-turn), but a challenge where *every* frame has two faces (coached victim + operator) is not flagged.

**Fix:** decision engine — selfie `occluded === true` → review (`FACE_OCCLUDED`); challenge — if ≥ 2 of 3 actions have `faceCount > 1` on their best frame → review (`MULTIPLE_FACES_DURING_CHALLENGE`).

---

## B. Correctness bugs in the capture loop

### B1. Frame budget can complete an action without a detected movement (Medium)

`LIVENESS_FRAME_BUDGET = 6` on both sides; one attempt uploads up to 4 frames (early shot + 3 burst). After one stalled burst the second cycle exhausts the budget mid-way, and the `await` phase then **auto-advances** ("Budget spent… advance immediately"). From the user's side the action "completed" without a trigger; the server then rejects on pose and the whole session is retried.

**Fix:** raise `MAX_LIVENESS_FRAMES_PER_ACTION` to 8 (two full cycles) in both places; on exhaustion do **not** advance silently — show "That movement was recorded; if it isn't accepted you'll be asked to try again" and advance only after the user taps. Also skip the early shot on redo cycles (`earlyShotTaken` reset only on a new action, not on stall recovery).

### B2. Burst continues after the face leaves (Low-Medium)

`presenceOk = facePresent || (fallbackBurst && shots > 0)` is fine, but `canShoot` for shots 2–3 does not require `holding`, so if the user snaps back to frontal at 200 ms the last two burst frames are frontal. The server needs one turned frame (it has the trigger frame), so verification still passes, but `assessTrajectory` then sees [near-threshold, frontal, frontal] and may return `motionUnverified` → spurious manual review.

**Fix:** for shots 2–3 accept only if `actionState.magnitude ≥ 0.6 × threshold` (still visibly turned) **or** delay them until the pose is held; if neither within 1.2 s, finish the burst with what was captured (the early + trigger frames are enough).

### B3. Session frontal reference is reset only when the step changes (Low)

A retry keeps the step on `liveness` in some paths (`flow.reset()` then `liveness` again): `livenessFrontalRef`/`livenessRefSamplesRef` persist across attempts. Usually harmless (same person, same seat), but a user who moved the laptop between attempts inherits a stale reference and waits on the self-heal.

**Fix:** clear both refs in `retryVerification()` alongside `livenessFrameCountsRef`.

### B4. Detection cadence vs. mobile inference time (Low)

`DETECT_MS = 110` schedules a detect+landmark pass every 110 ms; on a low-end Android the pass takes 200–350 ms in WASM. The loop already guards with `detecting`, so nothing breaks, but `need = 2` consecutive samples then means ~0.7 s minimum latency and the 3.5 s coaching timer fires after only ~10 samples.

**Fix:** measure the pass time (already trivial to add) and derive `AWAIT_HINT_MS` and `ALIGN_LOCK_MS` from it (e.g. hint after 12 samples, not 3.5 s), and switch `numThreads` to `navigator.hardwareConcurrency > 2 ? 2 : 1` for the WASM backend on capable phones.

### B5. Camera loss / tab backgrounding is not handled (Low)

Switching apps on mobile ends the `MediaStreamTrack`; the loop keeps ticking on a frozen frame with no user feedback until the fallback timers expire.

**Fix:** listen for `track.onended` and `document.visibilitychange`; on loss show "Camera paused — tap to resume", restart the stream, and return the liveness step to `align`.

---

## C. Verification-quality gaps (worker)

### C1. Thresholds were calibrated on wrong crops (High — carry-over, now urgent)

Every liveness/face-match score before the decoder fix came from crops of a wrong box. `liveness.pass = 0.85 / reject = 0.7`, `faceMatch.pass = 0.82 / reject = 0.65` are unvalidated on the corrected pipeline. There is no calibration tooling.

**Fix:** add `scripts/calibrate-thresholds.js` that pulls `rawResult` for the last N sessions (genuine = later approved by a reviewer; impostor = rejected/fraud-flagged), prints score histograms, FAR/FRR at candidate thresholds, and a recommended pass/reject/review band per tenant. Re-run after every model upgrade; store `modelVersion` alongside (already recorded).

### C2. `LIVENESS_POSE_UNAVAILABLE` is a hard reject (Medium)

With enforcement on, a provider that returns no pose for a head action rejects the customer (v3). Correct as a fail-closed default, but a *provider outage* now rejects real customers instead of queueing them.

**Fix:** distinguish "pose model errored/absent for the whole session" (route to `manual_review`, alert ops — this is an outage) from "pose present on other actions but absent on this one" (reject).

### C3. Passive liveness runs on one selfie frame (Medium)

Screen-replay and print attacks are judged on a single frontal frame. You already hold 10+ frames per session.

**Fix:** score passive liveness on the selfie **and** the 3–4 frontal-most challenge frames; aggregate with the *median* (robust to one bad frame) and require `median ≥ pass` for auto-approve. Cheap, and it turns single-frame luck into a multi-frame signal. Recorded per frame for calibration.

---

## D. UX / accessibility

### D1. "Toward the arrow" has no screen-reader or low-vision equivalent (Medium — NDPA/accessibility review will ask)

The instruction is now arrow-only; the arrow's `aria-label` still says "Turn left"/"Turn right" (anatomical — the very ambiguity v4 removed).

**Fix:** copy = "Turn your head toward the arrow on the **left side of the screen**" (screen-relative words are unambiguous under any mirroring); `aria-label` the same; announce instruction changes via an `aria-live="polite"` region; make the arrow larger and pulse; add an optional voice prompt (`speechSynthesis`) behind a tenant flag.

### D2. Look-up is physically small on laptops (Medium — carry-over)

Camera above eye level → "look up" is a small movement toward the camera. `look_down` was added to the pool but every challenge still can draw `look_up`.

**Fix:** with A1's generator change (both turns + one tilt), choose the tilt by camera facing: `facingMode === "user"` on a phone (camera below eye level) → prefer `look_up`; laptop/desktop (no `facingMode`, or width ≥ height at 16:9) → prefer `look_down`. Coaching for look-up: "lift your chin toward the ceiling".

### D3. Waiting with no way out (Medium)

With pose live, a user who cannot perform an action (neck injury, hijab restricting turns, very small child) waits with coaching forever; manual capture (after A3) is hidden.

**Fix:** after 15 s without a trigger offer "Try a different movement" — the client requests a **challenge reissue with an exclusion** (`POST /retry` with `excludeActions`), server audits it (`session.retry` metadata), limit two reissues per session, and route sessions that used a reissue to review only if other signals are borderline.

### D4. Bandwidth (Low)

Each frame is a full-resolution JPEG at quality 0.9 (1280×720 ≈ 150–250 KB); a session uploads 12–16 frames ≈ 2–3 MB on mobile data.

**Fix:** downscale liveness frames to 640 px on the long side at quality 0.85 (server models run at 320×240 and 112×112 — nothing is lost); keep the selfie and document at full resolution.

---

## E. Observability & compliance

### E1. No client-side capture telemetry (Medium)

The server sees frames, never *how* they were captured: time-to-trigger per action, coaching states shown, `wrongWay` count, fallback/manual use, detector pass time, model load time. "It doesn't see my turn" reports remain screen recordings.

**Fix:** collect a compact `captureTelemetry` object in the widget and send it with `submit()` next to `capture` (already whitelisted path): `{ actions: [{ action, msToTrigger, wrongWay, hints, frames, mode }], detectMs, landmarkMs, modelLoadMs }`. Store under `deviceMeta.telemetry`; expose in the sample app's developer block; feed `mode === "manual"` and `msToTrigger < 300` (suspiciously instant) into risk signals.

### E2. Reason-code observability for reviewers (Low)

`perAction` is in `rawResult`; the dashboard's review screen shows liveness score and face match but not per-action pose, trajectory or binding results.

**Fix:** render `perAction` (present/live/pose/peakYaw/peakPitch/trajectory) in the manual-review view so a reviewer can see *why* the challenge failed before deciding.

### E3. Consent copy version vs. biometric processing scope (Compliance)

Consent is captured (`CONSENT_COPY_VERSION`) before the camera starts — good. The copy does not mention that head-movement video frames and device/camera metadata are processed and retained per tenant retention policy; NDPA reviewers ask for processing scope in the notice.

**Fix:** update `DEFAULT_CONSENT_COPY` to name: selfie, ID images, short liveness video frames, device and camera metadata, retention period per tenant policy; bump the version. Legal review required before production.

---

## F. Suggested order of work

1. **A1 + A2** (server, ~1 day): consistency + sequence/timing checks, generator emits both turns. Ship logging-only first, enforce after a week of data.
2. **A3** (client + upload + worker, ~½ day): manual capture mode recorded and routed to review; button hidden when the detector is live.
3. **B1, B3, D1** (client, ~½ day): budget 8 + no silent advance; refs reset on retry; screen-relative copy + aria-live.
4. **C1** (~1 day): calibration script; then decide thresholds.
5. **A4, C3** (worker, ~1 day): identity continuity + multi-frame passive liveness.
6. **E1, D3, D2, B2, B4, B5, D4, A5, A6, C2, E2, E3** in that order.

Everything above is testable with the existing harness pattern (frames → detector → verifier) plus the unit suites; A1/A2/A4/C3 need pipeline tests with synthetic frames, which the current `pipeline.test.js` seeding already supports.
