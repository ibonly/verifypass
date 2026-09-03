# VerifyPass — Facial Verification Workflow Analysis

**Date:** 2026-09-01
**Scope (strict):** only the face/liveness path — the active-liveness challenge (`shared/src/livenessChallenge.js`), the browser capture SDK (`frontend/sdk/*`), the face capture upload path (`face` / `liveness-frame` endpoints), the provider face/liveness code (`worker/providers/faceplugin.js`, `worker/providers/onnx.js`, `onnxMath.js`), and the face-related branches of `worker/pipeline.js` and `shared/src/decisionEngine.js`. Document/OCR, webhooks, auth, and everything else are out of scope here.

---

## How the facial workflow works

At session creation the server generates a randomized active-liveness challenge — 3 distinct actions drawn from `["turn_left","turn_right","look_up","smile"]`, in random order, with a `nonce` and `issuedAt`. For `ID_AND_FACE` and `FACE_ONLY`, the client steps through `liveness` (one or more frames per action, uploaded to `/liveness-frame` tagged with the action) then `face` (a single selfie, uploaded to `/face`). The browser SDK runs an in-page ONNX detector purely for framing guidance — its scores are never trusted server-side.

At `/verify` the session goes to `submitted` and the worker runs, on the raw decrypted pixels:
- **Passive liveness on the selfie** → `score`, `verdict` (`Real`/`Spoof`), `faceCount`, `pose`.
- **Face match** selfie↔ID (skipped for `FACE_ONLY`).
- **Active-liveness challenge verification** (`verifyLivenessChallenge`): for each requested action, find the uploaded frames labeled with that action, require a face present, apply a spoof-score floor, and optionally check pose.

The decision engine folds selfie face-presence, liveness bands, face-match bands, and the challenge verdict into `approved/rejected/manual_review/failed`. This is a genuinely thoughtful design — server-authoritative scoring, fail-closed on missing scores, a pure tested decision function. The findings below are where the face path's guarantees are weaker than they look.

---

## Security vulnerabilities

### FV-1 — Active liveness is bypassable: frames are bound to actions only by a client-supplied label (High → Critical for a KYC product)
**Files:** `worker/pipeline.js:154-176`, `shared/src/livenessChallenge.js` (`verifyLivenessChallenge`), `services/uploadService.js` (`liveness` kind)

Each liveness frame's action is taken from `req.body.action` — the *client* declares which action each frame satisfies. The verifier then groups frames by that label and, per action, only requires (a) a face is present and (b) the spoof-score floor is cleared. Two structural weaknesses combine:

1. **No binding between the media and the challenge.** The server-issued `nonce` is generated, stored, and returned to the client — but it is never carried on the uploaded frames and never checked in `verifyLivenessChallenge`. The only linkage is the action string (client-controlled) and an `issuedAt` time-fence. So the "unpredictable, server-issued sequence" contributes no anti-replay: nothing stops a caller from uploading **the same single frame three times**, labeled `turn_left`, `turn_right`, `smile`.
2. **Pose enforcement is off by default.** `enforcePose` and `strictDirection` both default to `false` (`pipeline.js:169-172`, comments in `livenessChallenge.js`). With pose off, there is *no server check that the head actually moved* — a face-present frame satisfies any action label.

**Net effect out of the box:** the active-liveness layer collapses to "passive liveness on one selfie." An attacker who can pass passive liveness once (a high-res photo held to the camera, a screen replay of a real person, or a deepfake still) satisfies the entire challenge by relabeling that frame per action. The challenge-response is the product's headline anti-spoofing control, and by default it adds essentially nothing beyond the passive check.

**Fix direction:** bind frames to the challenge — have the SDK echo the session `nonce` into each frame and verify it; issue per-action one-time frame tokens so a frame can only satisfy the action currently being prompted; reject duplicate frames across actions (compare plaintext checksums — the store already computes them); and require distinct frames per action. Then calibrate and enable pose + direction enforcement (see FV-4).

### FV-2 — A strong selfie disarms the challenge spoof-score floor entirely (High)
**File:** `shared/src/livenessChallenge.js` (`verifyLivenessChallenge`), `pipeline.js:174`

The mid-action floor is disabled whenever `selfieScore >= liveness.pass`:
```
const selfieStrong = typeof opts.selfieScore === "number" && opts.selfieScore >= passAt;
if (maxScore !== null && maxScore < CHALLENGE_SCORE_FLOOR && !selfieStrong) { …fail… }
```
The rationale (a replay can't produce a high selfie score, so low action-frame scores must be pose/lighting) is reasonable *only if the selfie and the frames come from the same live capture*. But the selfie is a **separate** upload from the liveness frames, so an attacker can pair one genuine, passive-liveness-passing selfie with arbitrary junk frames: `selfieStrong` is true, the floor is switched off, and every action passes on frames that aren't even faces of the claimed person. This compounds FV-1: the split between "selfie" capture and "liveness frames" capture is exactly the seam the disarm assumes doesn't exist.

**Fix direction:** don't let the selfie vouch for independently-uploaded frames. Either make one of the challenge frames serve as the selfie (temporal binding), or keep the spoof floor active per-frame regardless of selfie strength, or require the disarm only when the frame and selfie are provably from one capture (shared nonce/token).

### FV-3 — No per-session cap on liveness frames or selfies → worker-compute DoS and Cloudinary cost (Medium)
**Files:** `services/uploadService.js`, `pipeline.js:160-165`, `services/cloudinaryService.js`

Nothing bounds how many `liveness_frame`/`selfie` rows a single session can accumulate. The verification loop decrypts and runs full liveness inference (ONNX or a Faceplugin round-trip) on **every** current frame, sequentially. The captures limiter is per-tenant-per-minute (`tnt:<id>`), not per-session, so a holder of one valid session token can upload thousands of frames — each triggering an encrypted-store write and a best-effort Cloudinary upload — then trigger a `/verify` that fans them all into inference. That is unbounded compute on the worker plus unbounded third-party upload cost, from a single session.

**Fix direction:** cap frames per action and per session at the upload endpoint (e.g. ≤3 per action, ≤20 per session); cap the number the verifier will score and take the best-N.

### FV-4 — Direction is not actually distinguished, even with enforcement on (Medium)
**File:** `shared/src/livenessChallenge.js` (`poseSatisfiesAction`)

With `strictDirection: false` (the default), `turn_left` and `turn_right` both reduce to `Math.abs(yaw) >= 15`, and `look_up`/`look_down` both to `Math.abs(pitch) >= 12`. A single head turn therefore satisfies *both* left and right; a single tilt satisfies up and down. So even a tenant who enables `enforcePose` (but not the uncalibrated `strictDirection`) gets a challenge where the *direction* of each action is meaningless — an attacker who moves their head once can cover multiple distinct actions with a couple of frames. The safe direction check exists but is gated behind `strictDirection`, which the comments explicitly say is uncalibrated and off.

**Fix direction:** calibrate the deployed model's yaw/pitch sign convention (the pipeline already records `maxAbsYaw`/`maxAbsPitch` in `rawResult` for exactly this) and ship `strictDirection` on by default per provider, so left≠right actually holds.

---

## Bugs / correctness

### FV-5 — ONNX face-match scores are on a different scale than the default thresholds → mass false rejects (High, correctness)
**Files:** `worker/providers/onnxMath.js` (`matchFeature`), `shared/src/reasonCodes.js` (`DEFAULT_THRESHOLDS`)

`matchFeature` returns **cosine similarity** on ArcFace-style embeddings; the code's own comment notes genuine matches "typically > ~0.4–0.6". But `DEFAULT_THRESHOLDS.faceMatch` is `reject: 0.65, pass: 0.82`. So with the dependency-free ONNX provider and default thresholds, a genuine same-person pair scoring ~0.5 lands **below the reject line** → `FACE_MATCH_FAILED` → wrongful rejection at scale. The defaults are implicitly tuned to the Faceplugin container's similarity scale, and the ONNX path (the one that needs no Docker/license — the easiest to deploy) silently over-rejects. This is the highest-impact *correctness* issue in the face path: it fails real users.

**Fix direction:** ship provider-specific default thresholds (or normalize `matchFeature` onto the same scale the thresholds assume), and add a golden test pinning a genuine-pair fixture above `reject` for whichever provider is active.

### FV-6 — ONNX provider skips the significant-face area filter → spurious multiple-face reviews (Low/Medium)
**Files:** `worker/providers/onnx.js` (`checkLiveness` → `faceCount: det.count`), vs `worker/providers/faceplugin.js` (`significantFaceCount`)

Faceplugin's adapter counts only faces ≥25% of the largest face's area, specifically to stop spurious small detector boxes (patterns on clothing, background faces) from tripping `MULTIPLE_FACES_DETECTED`. The ONNX adapter returns the raw post-NMS `count` with no such filter, so the same busy-background frame that's fine on Faceplugin gets sent to manual review on ONNX. Behavior diverges between the two providers for identical inputs.

**Fix direction:** apply the same area-ratio filter in `onnx.checkLiveness` (the boxes are already available from `detect`).

### FV-7 — `poseMatchesAction` treats "no signal" as a pass (Low)
**File:** `shared/src/livenessChallenge.js` (`poseMatchesAction`, deprecated shim)

`poseMatchesAction` returns `true` when `poseSatisfiesAction` yields `null` (no pose data). It's marked deprecated and the live path uses `poseSatisfiesAction` directly, but if anything still calls the shim it fails *open* on missing pose. Confirm there are no remaining callers and delete it, so a future refactor can't reintroduce a fail-open pose check.

### FV-8 — Dead `blink` verification path (Low, hygiene)
**File:** `shared/src/livenessChallenge.js`

`blink` was removed from `CHALLENGE_ACTIONS` but its verification branch remains "for sessions issued before the change." With a 10-minute challenge TTL and a 30-minute session TTL, no such session can still be live; the branch is dead. Prune it to avoid the impression that blink is a supported, verified action.

---

## Improvements (beyond the fixes above)

- **Make the challenge cryptographically binding.** The single highest-leverage change: a frame should only be able to satisfy the action the server is currently prompting, proven by a server-issued per-action token or the session nonce echoed and verified. This closes FV-1 and most of FV-2 at once.
- **Unify selfie and liveness capture.** Designating one challenge frame as the selfie removes the "strong selfie vouches for junk frames" seam (FV-2) and halves captures.
- **Passive-liveness gate on at least one challenge frame independent of the selfie**, so the anti-spoof floor can't be fully disarmed.
- **Per-provider calibrated defaults** for both liveness and face-match thresholds (FV-5), shipped with fixtures, so the zero-dependency ONNX path is correct out of the box.
- **Frame budgets** (FV-3) at the upload edge, surfaced to the SDK so it stops capturing rather than erroring.
- **Optional: passive-liveness on the selfie AND a challenge aggregate both required** — today a null/failed challenge hard-rejects (good), but consider recording a combined liveness confidence for reviewer context.

---

## Priority

1. **FV-1 + FV-2** — the active-liveness bypass. For a Nigerian KYC/anti-fraud product this is the finding that matters most; the marketed anti-spoofing control is, by default, only passive liveness on one image.
2. **FV-5** — ONNX threshold-scale mismatch rejecting genuine users on the easiest-to-deploy provider.
3. **FV-3, FV-4** — DoS surface and meaningless direction check.
4. **FV-6, FV-7, FV-8** — provider consistency and hygiene.

I've kept this to analysis only — no code changed. I can implement any of these next; FV-1/FV-2 (nonce binding + per-action frame tokens + dropping the cross-capture disarm) and FV-5 (provider-calibrated thresholds with a genuine-pair golden test) are the two I'd start with.
