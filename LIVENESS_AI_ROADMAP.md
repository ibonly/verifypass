# Improving VerifyPass Liveness with AI — from cheapest to most expensive

**Context:** the stack today is five small ONNX models (`fr_detect` RFB-320, `fr_landmark` 68-point, `fr_pose`, `fr_liveness` single-frame PAD, `fr_feature` embedding) run in the browser (WASM) and in a Node worker on CPU, plus the challenge–response logic built over the last week. Every suggestion below is placed by *marginal cost* (engineering days + run-cost per verification) and says what it defends against, how to build it on this codebase, and how to prove it works. Rough Nigerian-market economics assume 50k verifications/month.

| Tier | Cost | What you get |
|---|---|---|
| 0 | ~0 run-cost, 1–4 eng-days each | New signals from models and data you already have |
| 1 | < $50/month, 3–8 days each | Better open models (still CPU/WASM) and active illumination |
| 2 | $0.005–0.03 per *borderline* session, 5–15 days | Second-opinion AI on hard cases; AI-assisted review |
| 3 | $0.10–0.50 per session, or a data programme | Certified PAD vendor, custom-trained models, native attestation |

---

## Tier 0 — free: squeeze the models you already ship

### 0.1 Real blink and mouth-open challenges from the 68 landmarks (1–2 days)
The 68-point model gives eye contours (points 36–47) and mouth (48–67). Eye-aspect-ratio `EAR = (‖p2−p6‖ + ‖p3−p5‖) / (2‖p1−p4‖)` drops from ~0.3 to < 0.15 on a blink; mouth-aspect-ratio does the same for "open your mouth". Blink was removed earlier because the *band-motion* heuristic was flaky — landmarks make it reliable, and a blink is very hard to fake with a printed photo.
*Build:* `landmarks.js` — `earFromLandmarks(lm)`, `marFromLandmarks(lm)`; `createActionDetector` gets `blink` (EAR < 0.15 for ≥2 ticks then > 0.25) and `open_mouth`; add both to `CHALLENGE_POOL`; worker verifies the same ratios on the burst frames with `fr_landmark` (already loaded in `providers/onnx.js`) and records `peakEar`/`peakMar` in `perAction`.
*Defends:* printed photos, static screens; adds sequence entropy (5–6 actions → 120+ sequences).

### 0.2 "3D-ness" from landmark trajectories during a turn (2–3 days) — highest value per naira
A photo or screen turned in the hand moves *rigidly*: all five anchor points obey one 2-D affine transform. A real head turning is a 3-D rotation: the nose tip moves relative to the eye line far more than the cheek points do (parallax). Fit a 2-D affine map from frame 1's five points to frame N's and measure the residual on the nose; low residual = flat object.
*Build:* worker, `assessTrajectory` already has per-frame pose; add `assessRigidity(frames)` using `affineFrom3` in `onnxMath.js` (it exists) — fit on eyes+mouth corners, residual on nose, normalised by inter-ocular distance; `< 0.05` across the burst → `LIVENESS_FLAT_OBJECT` (reject at high confidence, review otherwise). Calibrate on the replay harness (real turn residual vs a printed photo you rotate in front of the webcam — a 30-minute data collection).
*Defends:* print attacks, screen replays of a static face, most "photo on a phone waved in front of the camera" attacks — the class the single-frame PAD model is weakest on.

### 0.3 Screen-replay texture heuristics (1–2 days)
Screens produce moiré (periodic high-frequency energy), a colour-temperature shift, and a rectangular bright region around the face. Compute on the face crop: FFT band energy ratio, saturation/colour-cast statistics, and Laplacian variance vs. the selfie's expected sharpness.
*Build:* worker, pure JS on the decrypted buffer via `sharp` → raw; three scalars into `rawResult.liveness.texture`; feed the decision only as a *review* signal until calibrated. No model, no run-cost.

### 0.4 Cross-frame identity continuity for **all** frames (½ day)
A4 compares selfie ↔ one challenge frame. Extend to every faced frame: one embedding each (fr_feature, ~20 ms) and require pairwise similarity above the review threshold. Catches "swap the person mid-challenge" and low-effort deepfake face-swaps that drift between frames.

### 0.5 Telemetry-driven anomaly scoring (2 days, needs ~2 weeks of data)
`deviceMeta.telemetry` now records time-to-trigger, hints, modes, detect ms. Fit simple robust statistics (median/MAD per action) and flag sessions in the extreme tails (instant triggers, zero coaching on every action, identical timings across sessions from one device fingerprint). Isolation-forest quality signal for fraud rings without a single new model — implement as a nightly job that writes a `telemetryAnomaly` risk signal.

---

## Tier 1 — low cost: better open models and active illumination

### 1.1 Screen-flash (active illumination) liveness (3–5 days, zero run-cost)
Flash the preview background with a random colour sequence (e.g., 4 colours over 1.2 s) during the selfie; measure the face crop's mean colour response per flash. Skin reflects the flash (measurable chroma shift, delayed by ≈ one frame); a screen replay or print cannot reproduce a *random* sequence in sync. Used by several commercial vendors; here it costs a `<div>` and some arithmetic.
*Build:* widget — after the selfie frontal gate, run the flash while capturing 8–10 low-res frames + the colour sequence; upload as `flash_frame`s bound to the challenge nonce (same HMAC binding); worker — per frame, mean RGB in the face box minus the pre-flash baseline, correlate with the emitted sequence, threshold the correlation. Record only for two weeks, then enforce.
*Defends:* screen replays and video injection that isn't rendered in real time — the two attacks the current stack is weakest against.

### 1.2 Stronger passive PAD: MiniFASNet ensemble (3–4 days, CPU)
Silent-Face-Anti-Spoofing's MiniFASNetV2 / V1SE (MIT licence, ~1.8 MB each) are widely used, fast on CPU (~10 ms), and complement `fr_liveness`. Run both on the selfie and the frontal challenge frames, aggregate by median (C3 already does this), and require agreement.
*Build:* `providers/onnx.js` gets `checkLivenessEnsemble(buf, box)` with the two extra sessions; `resolveThresholds` gets per-model thresholds; `modelVersion` bump; re-run `calibrate-thresholds.js`.

### 1.3 Better detection + 468-point mesh in the browser (4–6 days)
Replace `fr_landmark` (64×64, 68 points, noisy at large yaw — see the direction analysis) with MediaPipe Face Mesh / TFLite face landmark (Apache-2, ~3 MB, 468 points + 3-D coordinates). Yaw/pitch come out as real angles, blink/gaze/mouth are precise, and the 3-D mesh gives Tier 0.2's rigidity test for free with far better accuracy.
*Build:* new `faceMesh.js` backend behind the same `detect()` interface; `landmarks.js` maps mesh → the five anchor points so the detector logic is untouched; keep `fr_landmark` as fallback.

### 1.4 Stronger face match: InsightFace buffalo_l / ArcFace R100 (2–3 days)
Higher-accuracy embeddings (MS1MV3-trained, MIT) reduce FRR on dark-skin genuine pairs — the demographic gap partner banks will ask about. ~60 ms on CPU. Recalibrate `faceMatch` thresholds; store `modelVersion`; the calibration script already groups by it.

### 1.5 Document-side AI (3–5 days)
PaddleOCR-lite or Tesseract 5 with Nigerian-ID templates, plus an ID face crop detector, improves OCR confidence and face-match on the document side. Out of the liveness path proper but it feeds the same decision.

---

## Tier 2 — medium: pay only for the hard cases

### 2.1 Cloud liveness as a second opinion on borderline sessions (5–8 days)
AWS Rekognition Face Liveness (~$0.015 per check, no human review) or Azure Face Liveness (iBeta Level 2) called **only** when the local decision lands in the review band. At 50k sessions/month with ~8 % borderline → ~$60/month, and it clears most of the manual review queue.
*Build:* a `livenessSecondOpinion` job after the local decision, gated by tenant setting and status `manual_review`; result stored as a signal (`secondOpinion.status/score`), decision engine promotes review→approve only when both local *and* second opinion pass. Data residency: check NDPA transfer conditions before sending biometrics abroad; prefer the local models plus 1.1 for tenants that forbid it.

### 2.2 Video-injection / deepfake frame classifier (6–10 days, GPU or paid API)
Open detectors (e.g., EfficientNet DFDC checkpoints, ~50–100 ms on GPU) score each challenge frame for synthetic artefacts. Run on a small GPU box or a serverless GPU only for sessions the flash test (1.1) or telemetry (0.5) flags. Alternatively commercial injection detection (per-call pricing).
*Defends:* real-time deepfake injection via virtual camera — the attack that will grow fastest.

### 2.3 AI-assisted manual review (4–6 days, ~$0.01–0.03 per reviewed session)
Send a reviewer-grade summary request to a multimodal model (e.g., Claude) with the *redacted* evidence: ID face crop, selfie crop, per-action challenge table, reason codes, telemetry. Ask for a structured JSON: consistency observations (name/DOB vs. document, apparent age vs. DOB, glasses/hat/mask, document tamper hints), a confidence, and a draft note. **Never** a decision — it pre-fills the reviewer's screen and orders the queue.
*Build:* worker job `review_assist` after `manual_review`; prompt with strict schema; store under `manualReviewNote` as `assistant` author; dashboard shows it above the form. Consent copy already covers automated processing; add "automated assistance for human review" wording; keep full ID numbers out of the prompt.

### 2.4 Risk-model on the whole signal vector (5 days + data)
Replace the rule cascade in `decisionEngine` with a small gradient-boosted model (LightGBM, exported to ONNX) over: passive scores, challenge outcomes, rigidity, texture, telemetry anomalies, device/IP velocity, document quality. Train on reviewer decisions from the calibration script's genuine/impostor split. Keep the rules as hard floors (never auto-approve below reject thresholds); the model only orders and widens/narrows the review band.

---

## Tier 3 — expensive: certified assurance and custom models

### 3.1 Certified PAD vendor for high-assurance tenants ($0.10–0.50/session, 2–4 weeks integration)
FaceTec, iProov, ID R&D or Innovatrics bring iBeta Level 1/2 certificates and their own injection defences. Offer as a per-tenant "enhanced" verification level (the `verificationLevel: enhanced` in the API already exists as a concept) so cost is passed through; keep VerifyPass's flow as `standard`.

### 3.2 Train your own PAD / face model on Nigerian data (3–6 months, data programme + GPU)
Collect consented genuine sessions and staged attacks (prints, screens, masks) across skin tones, phones and lighting typical of your market; fine-tune MiniFASNet / a ViT-small PAD and an ArcFace head. This is the only way to close the demographic FRR gap with evidence you can show a partner bank, and it needs an ethics/consent process and a labelling budget.

### 3.3 Native SDKs with hardware attestation (2–3 months)
React Native / Kotlin / Swift SDKs using Play Integrity and App Attest, a secured camera pipeline (frames signed on-device), and TrueDepth on iOS where available. This is the real answer to injection attacks; the browser can only approximate it with 1.1 and 2.2.

---

## Suggested sequence

1. **Now (Tier 0, ~1 week):** 0.2 rigidity test and 0.1 blink/mouth actions — the biggest jump in print/screen resistance for no run-cost; 0.4 and 0.3 alongside.
2. **Next (Tier 1, ~2–3 weeks):** 1.1 screen-flash, 1.2 MiniFASNet ensemble, then 1.3 face mesh (which also retires the 68-point noise).
3. **Then (Tier 2):** 2.1 second opinion on borderline only, 2.3 review assistant, 2.4 once the calibration data exists.
4. **When a bank asks:** 3.1 as an enhanced tier; 3.3 when mobile volume justifies native SDKs; 3.2 as a strategic programme.

Everything in Tiers 0–1 is testable with the replay harness built this week (frames → models → verifier) plus one afternoon of staged attacks (a printed photo, a phone showing a video) recorded through the sample app.
