# Liveness session analysis — 7 September 2026

Analysis of every session in the local database behind the dashboard (`DATABASE_URL` in `backend/.env`, MongoDB replica set on this machine), including decrypted evidence images, stored results, audit trails and job queue rows.

## Data pulled

| Collection | Rows |
| --- | --- |
| tenants | 2 (both with empty `settings`, no webhook configured) |
| verification sessions | 50 (1 Sep → 7 Sep) |
| verification results | 43 (retries produce several per session) |
| evidence files | 485, all 485 decrypted successfully |
| audit log | 697 |
| job queue | 86, none failed, no stuck rows |
| outbox | 9, all `sent` |
| webhook deliveries | 0 (no tenant has a webhook URL) |

The decrypted images were written only to this session's scratchpad (`…/scratchpad/dbdump/evidence/<sessionUid>/`) together with JSON exports and the analysis scripts (`dump.js`, `analyze.js`, `rescore.js`, `yawsign.js`). They contain the tester's face and were deliberately not copied into the repository. Frames of the eight most recent liveness sessions were re-scored with the ONNX provider to obtain per-frame pose, passive score, landmark EAR and selfie similarity.

## Headline findings

1. **Two worker processes are running different code, and the stale one judged tonight's last two sessions.** `worker-16466` started on 6 September at 00:13, before the policy v2 files were written (`pipeline.js` modified 23:22, `release.js` 23:24). A newer worker was started at 00:18 on 7 September. Both poll the same queue. Sessions submitted 04:57–05:02 UTC were claimed by the new worker (pipeline `2026-09-06.1-liveness-policy-v2`); sessions at 05:17–05:18 were claimed by the stale worker (pipeline `2026-07-10.5`). The API stamped v2 frame bindings (HMAC with tenant/session/attempt context); the stale worker verifies v1 bindings, so all 12 frames failed with `LIVENESS_FRAME_BINDING_FAILED` and the sessions were rejected as `LIVENESS_CHALLENGE_INCOMPLETE`. The frames themselves are clearly a genuine person performing the actions. This is the audit's L34 deployment-skew risk happening locally.

2. **Every policy v2 session with a genuine user was rejected (3 of 3).** The causes are new rules behaving as false-reject engines on real captures, not spoof detection:
   - identity continuity uses the minimum similarity across frames up to 25° yaw, and genuine turned or tilted frames score 0.15–0.35 against the selfie (reject threshold 0.28);
   - the per-action time window (6 s) is measured from the early frontal frame, which the widget now takes as soon as the action starts waiting, so any user who needs more than 6 s to begin a movement fails `LIVENESS_CHALLENGE_SEQUENCE_INVALID`;
   - the pose model's yaw sign is unreliable at large angles, so the enforced opposite-sign check rejected a user who visibly turned both ways;
   - the passive median over "frontal-most" challenge frames pulls a 0.94 selfie down to 0.63 because look-up frames score 0.02–0.14 on the passive model.

3. **Across all completed FACE_ONLY sessions the approval rate is 3 of 22** (7 review, 12 rejected) for what is, from the images, one honest tester on a phone and a laptop webcam. The pre-v2 sessions fail mostly on `look_up` pitch a fraction of a degree under threshold, trajectory heuristics, and a face detector that reports two faces on a solo selfie.

## Per-session results

Times are UTC. "v2" = judged by policy v2; "old" = judged by the July pipeline (which already carried the v7 identity/flash/rigidity signals but never bumped its version string).

### 7 September

| Session | Outcome | Judged by | What actually happened |
| --- | --- | --- | --- |
| `vps_1K1T4QB9…` 05:17 | rejected | stale worker | 12 genuine frames, 4 per action, all failed v1 binding verification against v2 HMACs → `INCOMPLETE` + `FRAME_BINDING_FAILED`. Selfie passive 0.968. Would need re-judging by the v2 worker. |
| `vps_1K1T4O2T…` 05:16 (2 attempts) | rejected | stale worker | Same skew on both attempts; 24 frames, `begun` audit shows the new begin-challenge call is working. |
| `vps_1K1T3T4T…` 05:01 | rejected | v2 | `IDENTITY_MISMATCH` (min 0.153 on the first turn_left frame, a near-frontal frame at −3.7° yaw; frontal look_down frame scores 0.71). `DIRECTION_INCONSISTENT`: turn_left peak +54.8, turn_right peak +56.9, yet the two last frames show the head turned to opposite sides. `SEQUENCE_INVALID`: turn_right span 8.9 s because the early frame was taken 0.6 s after look_down ended (pitch −29.5, still looking down) and the burst came 8 s later. `MOTION_UNVERIFIED`: turn_right first frame 11.5° > 9°. Flash tile identity check failed on 96 px tiles. |
| `vps_1K1T3P6F…` 04:59 | rejected | v2 | `CHALLENGE_FAILED` on look_up: server pitch never exceeded 10.8° while the client triggered; one "look_up" frame is a full profile turn (yaw −58.5). `SEQUENCE_INVALID`: turn_right span 21.8 s and turn_left 12.7 s (telemetry: 20.5 s and 10.8 s to trigger with `wrong_way` hints). `LIVENESS_BORDERLINE`: decision score 0.632 = median of selfie 0.937 and frames [0.06, 0.33, 1.0]; the 0.06 frame is the frontal early look_up frame. `IDENTITY_BORDERLINE` min 0.283. |
| `vps_1K1T3KI9…` 04:57 | rejected | v2 | Challenge itself passed (consistency −51/+55, sequence fine). `IDENTITY_MISMATCH`: min 0.26 on a 9° yaw turn_left frame; look_down frames score 0.74–0.88. `MOTION_UNVERIFIED`: the early turn_right frame scored 0.022 passive and was excluded by the spoof floor, so the trajectory saw only three turned frames (first 55.2°). |

### 6 September (old pipeline with v7 signals)

| Session | Outcome | Notes |
| --- | --- | --- |
| `vps_1K1QJHJC…` 05:37 | manual_review | `IDENTITY_BORDERLINE` 0.414, `MOTION_UNVERIFIED`, `LIVENESS_FLAT_OBJECT` (rigidity residual 0.029 on a real face, motion 0.34). Consistency recorded false: both turns +54/+50.7, images show opposite directions. Flash responded (score 0.877). Two look_up frames had no face (face left the frame). |
| `vps_1K1QIKTV…` 05:21 (2 attempts) | manual_review | Challenge passed both times; `MOTION_UNVERIFIED` (trajectories start at 15–45°). Flash `no_response` on the Brio webcam (magnitude 2.0 and 2.7 < 3). |
| `vps_1K1QI6R3…` 05:14 | rejected | `IDENTITY_MISMATCH` min 0.247: look_down frames at pitch −35° pass the 25° yaw filter but embed poorly. turn_right had only 2 frames. |
| 3 × created 05:07–05:10 | abandoned | Challenges contained `blink` / `open_mouth` (pool at the time); never captured. |

### 4 September (old pipeline)

| Session | Outcome | Notes |
| --- | --- | --- |
| `vps_1K1LKK03…` (2 attempts) | rejected | look_up frames present but no face detected in either attempt (phone camera loses the face when the chin lifts) → `INCOMPLETE`. |
| `vps_1K1LJLTC…` (2 attempts) | manual_review | Challenge ok both times; `MOTION_UNVERIFIED`. |
| 4 × ID_ONLY | approved | Tesseract OCR confidence 0.58–0.61; document liveness "Spoof" as expected; one card scored "Real" 0.82 but the face-ratio guard held. |
| `vps_1K1LHPVG…` (2 attempts) | rejected | Selfie passive 0.611 then 0.477 (`LIVENESS_FAILED`); look_up frame was a 55° yaw turn (pitch 6.9). |
| `vps_1K1LHMFG…` (2 attempts) | manual_review | Attempt 1: turns reached only 11–12.6° yaw (threshold 15). Attempt 2: ok but `MOTION_UNVERIFIED`. |
| `vps_1K1LF6Q9…` (2 attempts) | manual_review | `MULTIPLE_FACES_DETECTED` twice on a selfie that shows one person (Brio webcam, cluttered background). |
| `vps_1K1LF0T7…` | approved | Brio; every action 40–50° magnitude. |
| `vps_1K1LETQP…` | rejected | look_up pitch 11.78° against a 12° threshold, plus the same two-face false positive. |
| `vps_1K1LEGBG…` | stuck in `started` after 3 attempts | look_up pitch 7.4 and 7.2 on attempts 2–3; retry #4 never submitted. 34 old frames retained. |
| `vps_1K1LE475…` (3 attempts) | rejected | `NO_FACE_ON_SELFIE` on all three attempts: no face in any frame (camera test without a face). |
| `vps_1K1LD7A6…` (2 attempts) | manual_review | look_up 11.1° then selfie borderline 0.634. |
| 8 × created | abandoned | 5 before consent, 3 after consent with no capture. |

### 1–2 September (old pipeline, smile era)

Two approvals (`smile` steps passed with `poseChecked:false`, the weak slot the audit's L01 described), two rejections (look_up 10.8°; a turn_right frame scoring 0.02 passive), three sessions stuck in `started` after a retry, and one ID_AND_FACE where the document had no detectable face: result shows `faceMatchStatus: "matched"` with a null score.

## Funnel

| Stage | Sessions |
| --- | --- |
| created | 50 |
| consent recorded | 33 |
| at least one capture | 27 |
| submitted at least once | 27 |
| terminal outcome | 23 (3 approved face, 4 approved ID-only, 7 review, 12 rejected) |
| stuck in `started` after a retry | 4 |

Seventeen sessions never reached consent and six more consented without capturing anything.

## Required improvements

### P0 — fix before any further testing

1. **Kill the stale worker and prevent recurrence.** `kill 16466`, then guard against skew: stamp the API's `policyVersion` into the `run_verification` payload and have the worker refuse (requeue with a clear `lastError`) any job whose payload version differs from its own; write a pidfile or lock in `worker.js` so `start-all` cannot leave an old worker polling; surface the judging worker's release identity on the dashboard result view (the data is already in `rawResult.release`). The two skewed sessions can be replayed once only the v2 worker is running.

2. **Identity continuity aggregation.** Use only frames with |yaw| ≤ 15° and |pitch| ≤ 15° and a face box at least 60% of the selfie's; aggregate by the best qualifying frame (or median), not the minimum; report `MISMATCH` only when the best qualifying frame is below the reject threshold, `UNAVAILABLE` when no frame qualifies. Observed genuine similarities: frontal 0.66–0.89, turned or tilted 0.15–0.50, so the current minimum over 25° frames rejects almost every honest session.

3. **Per-action time window and the early frame.** Restore the early-shot gating on `actionState.ok` (movement started), which the L23 fix removed, and measure `maxActionSpanMs` from the first triggered frame rather than the early frame. Raise the limit from 6 s to about 15 s. Observed genuine spans: 8.9 s, 12.7 s, 21.8 s, all driven by coaching time before the movement.

4. **Direction consistency must not hard-reject with this pose model.** In 35 of 60 strong-yaw frames the model's sign is inconsistent with a landmark-geometry cross-check, and in two sessions both turns came out positive while the images show opposite directions. Downgrade `LIVENESS_DIRECTION_INCONSISTENT` to review, compute the sign from the majority of frames above 15° rather than the single peak, and log the per-frame sign-flip rate for calibration before re-enabling as a reject.

5. **Passive aggregate over challenge frames.** Restrict the median to frames with |yaw| and |pitch| ≤ 15° (the current "frontal-most three" picks tilted frames, which the passive model scores 0.02–0.14), or make the aggregate record-only and keep the selfie score as the decision score. The selfie gate from L11 is preserved either way because the selfie can only lower the result.

### P1 — calibration and client alignment

6. **look_up threshold and guidance.** Genuine look_up on laptop and phone reached 7–11.8° pitch server-side in six sessions against a 12° threshold, and the phone camera loses the face entirely above ~35°. Lower the pitch threshold to 8–10°, make the client trigger require the server-equivalent margin (the client uses a normalised proxy, the server degrees), and coach "keep your face in the circle" for tilts.

7. **Trajectory start condition.** `startedNearFrontal` requires the first frame ≤ 9° for turns; genuine users begin at 10–15° or the early frame is excluded by the spoof floor. Use the minimum over frames and allow up to the action threshold; this alone drove `MOTION_UNVERIFIED` in eight sessions.

8. **Multiple-face false positive on the webcam.** Four Brio sessions reported two faces on a single-person selfie. Ignore secondary boxes smaller than ~30% of the primary or below a confidence floor before flagging `MULTIPLE_FACES_DETECTED`.

9. **Flash tile verification.** The per-tile identity check fails on 96 px tiles (`Flash tile identity unverified`) and webcam magnitudes fall below the 3.0 response floor. Increase tile size to 160 px, compare tiles against the selfie at the reject threshold rather than the pass threshold, and keep flash record-only until genuine phone sessions cluster.

10. **Rigidity false positive.** A real face produced `maxResidual 0.029` at motion 0.34 and was flagged flat. Raise `minMotion` toward 0.5 or require two turns to agree before `LIVENESS_FLAT_OBJECT`.

11. **Client turn coaching on Android.** Telemetry shows `wrong_way` and `further` hints with 10–20 s to trigger on the phone; the mirrored-preview direction mapping deserves a device test, and the trigger threshold should be tied to the server's 15° so a client trigger implies a server pass.

### P2 — reporting and hygiene

12. `faceMatchStatus` reports `"matched"` with a null score when the document has no face (`idFaceFound:false`). Return `null` or `"review"` in that case.
13. Dashboard: show the judging release/policy per result and warn when results in one day carry different `pipelineVersion` values.
14. Abandonment: 34% of sessions never consent and six consented sessions never captured. Add client telemetry for consent-screen exits and camera/model-load failures.
15. Stuck `started` sessions after retries (4) never expire into a terminal state until the session TTL; the retry response could carry a countdown, and the dashboard should list them.
16. Build a replay tool (`scripts/replay-session.js`) that re-runs the pipeline over a stored session's evidence with the current worker code and prints the decision without writing, so threshold changes can be evaluated against these 27 captured sessions before deploy. The re-scoring script from this analysis is a starting point.

## Limits

No physical spoof samples exist in this database, so nothing here measures attack resistance; every rejected liveness session examined is the same genuine tester. The pose-sign cross-check uses a crude nose-offset heuristic whose own magnitudes are small, so treat it as corroboration of the visual evidence, not a calibrated measurement.

## Implemented (7 September 2026, after this analysis)

| Item | Change |
| --- | --- |
| P0-1 stale worker | Process 16466 stopped. `worker.js` now takes a pidfile lock (`WORKER_PIDFILE`, opt out with `WORKER_ALLOW_MULTIPLE=true`) and refuses to start beside another worker. The API stamps `policyVersion` into every `run_verification` job; a worker on a different policy throws `POLICY_VERSION_MISMATCH` and the loop hands the job back without consuming an attempt. Dashboard shows the judging build and policy per result. |
| P0-2 identity | Identity continuity uses frontal frames only (|yaw|, |pitch| ≤ 15°, face at least 60% of the selfie's relative face size) and reports the **best** qualifying frame; no qualifying frame → `LIVENESS_IDENTITY_UNAVAILABLE` (review). `rawResult.livenessIdentity` keeps `min`, `mean`, `perFrame`, `considered`. |
| P0-3 early frame / window | Widget takes the early frame only once the movement has started (`actionState.ok`). Server measures the per-action window from the second frame when an action has ≥3 frames and allows 15 s (was 6 s). |
| P0-4 direction consistency | Sign per action is a majority vote over frames past the threshold (two or more strong frames; ties are "unresolved", never a failure). Inconsistent turns route to **review** by default; `CHALLENGE_ENFORCE_CONSISTENCY=true` or `settings.challenge.enforceConsistency` makes it a reject. |
| P0-5 passive aggregate | Frontal-frame median is recorded only; the decision passive score is the selfie score. |
| P1-6 look_up | Pitch threshold 12° → 10°. |
| P1-7 trajectory | "Started near frontal" now uses the burst minimum up to the action threshold; trajectory and expression are judged on all faced frames, not only floor-eligible ones. |
| P1-8 multi-face | Already fixed in the current detector (distinct-face rule); the Brio selfie now counts one face. No change. |
| P1-9 flash | Tile 96 → 160 px (shared and SDK); per-tile identity compared at the reject band. |
| P1-10 rigidity | `minMotion` 0.5 (was 0.2) and `LIVENESS_FLAT_OBJECT` needs two actions without parallax. |
| Tilt floor | A frame beyond 20° that the passive model scores under the floor still satisfies the pose when that action's landmarks show real parallax (`rigidity.ok`). |
| P2-12 | `faceMatchStatus` is `review` when the document has no face or no score. |
| P2-16 replay tool | `node backend/scripts/replay-session.js <vps_…> | --since <date> [--json]` re-runs stored sessions through the current worker without writing. |
| Tests | `backend/tests/sessionAnalysisFixes.test.js` (10 tests); consistency test and audit regressions updated. Suites: backend 272, shared 96, SDK 108, all passing. |

### Replay of the captured sessions with the fixed pipeline

| Session | Stored outcome | Replayed outcome |
| --- | --- | --- |
| `vps_1K1T3KI9…` 04:57 | rejected (identity, motion) | **approved** |
| `vps_1K1T3T4T…` 05:01 | rejected (identity, direction, sequence, motion) | manual_review (direction only) |
| `vps_1K1T4O2T…` 05:16 | rejected (stale-worker binding failure) | manual_review (identity borderline 0.32, motion) |
| `vps_1K1T4QB9…` 05:17 | rejected (stale-worker binding failure) | rejected: look_up never satisfied |
| `vps_1K1T3P6F…` 04:59 | rejected (5 codes) | rejected: look_up never satisfied (user turned instead) |
| `vps_1K1QJHJC…` 6 Sep | manual_review | manual_review (evidence, motion, direction) |
| `vps_1K1QI6R3…` 6 Sep | rejected (identity) | manual_review |
| `vps_1K1LF0T7…` 4 Sep | approved | manual_review (legacy frames carry no capture mode → treated as manual) |

Not changed, still open:

- **look_up on phones.** Genuine chin-up frames score 0.015–0.14 on the passive model and the landmark model reports almost no nose parallax for them (residual 0.04), so neither the spoof floor nor the parallax rescue can pass them. Options: coach a smaller tilt (≤ 25°) so the passive model still scores the face, prefer turns over tilts on phone user agents, or calibrate the floor per pitch band on a labelled set.
- Android turn coaching (`wrong_way` hints, 10–20 s to trigger) needs a device session; abandonment telemetry and a stuck-`started` sweep are not implemented.
- Legacy sessions replayed above carry frames without `captureMode`, which the current policy treats as manual; that is an artefact of old data, not a defect.

## Live test round (7 September, 15:35–16:13 UTC) and follow-up fixes

Nine sessions were run from the sample app against the fixed worker. Findings and the changes they drove:

| Observation | Change |
| --- | --- |
| Early-frame gating removed the only frontal frame from look-up bursts; the passive model scores chin-up frames ≤ 0.01, so look_up failed at the spoof floor. | Widget takes the frontal early frame again (the server excludes it from the per-action window). Tilt frames beyond 20° count for pose whenever the action carries a live frontal frame; turns still need parallax. look_up then passed in every later session (40–48°). |
| A 75° left turn with landmark residual 0.16 was not judged for parallax because motion (0.45) sat under the 0.5 minimum. | Rigidity `minMotion` 0.3; the two-action rule contains flat false positives. |
| Genuine selfies scored 0.389 and 0.475 while their frontal frames scored 0.86–0.94. | A selfie under the reject band with ≥2 passing frontal frames routes to review (`LIVENESS_BORDERLINE`) instead of a hard reject. Frames never lift a selfie to approval. |
| The pose model reports ~5° for a face turned ~40° toward image-right (and sometimes a flipped sign), while faces turned toward image-left are measured reliably. Landmark geometry gives no usable yaw either (eye-distance ratio identical for frontal and turned faces). | ONNX pose stage now also infers on the mirrored crop and takes the larger-magnitude candidate (`combineMirroredPose`), recording both raw values. On 52 turn frames this rescued every under-reported turn and never pushed a frontal frame past 15°. Sign reliability is unchanged, so direction consistency stays review-only. |

Replay after these changes: both turn_left rejections now pass their challenge; the 16:12 session becomes review on trajectory, the 16:10 session stays rejected on its 0.475 selfie (frontal frames 0.89/0.15/0.06 do not contradict it) plus the assisted reissue. The two approved sessions still approve.

Open after this round:

- **Passive model variance on selfies.** Two of six genuine selfies scored below 0.5. The widget uploads one selfie; a median over two or three selfie captures would be more stable and is not the L11 "best-of" pattern.
- **Pose sign.** Even with mirroring, 9 of 25 strong pairs disagree in sign; `LIVENESS_DIRECTION_INCONSISTENT` must stay a review signal until a better pose model is evaluated.
- **Client tilt direction on Android.** Wrong-way hints on look_down led to an assisted reissue; needs a device session.

## Second live round (16:21–16:25 UTC): pose-sign measurement and policy change

Five sessions: 1 approved, 3 manual review (all `LIVENESS_DIRECTION_INCONSISTENT`), 1 rejected (selfie 0.436 with frontal frames 0.79/0.05; look-up early frame scored 0.05 so no live frame in that action).

Measured on 57 burst frames of instructed turns with both pose candidates (original and mirrored crop): the yaw **sign** matched the instructed direction on 51–56% of strong frames under every combination rule tried (largest magnitude, reliable-side, average, original-only, mirror-only). The sign of the bundled `fr_pose` model is therefore a coin flip for this face and camera, and any decision built on it flags about half of genuine sessions. Magnitude is usable: the mirrored candidate cuts under-reported turned frames from 20 to 5, and the smaller candidate stayed ≤ 15° on all 19 frontal early frames while the larger exceeded 15° on 5.

Changes:

- `CHALLENGE_CONSISTENCY_MODE = record | review | reject` (default **record**): the opposite-sign check is still computed and stored (`rawResult.livenessChallenge.consistency`, `directionInconsistent`, per-action sign votes) but does not affect the decision until a pose model with measured sign accuracy is deployed. `settings.challenge.consistencyMode` overrides per tenant.
- Pose carries `yawNear` (the smaller of the two candidates); trajectory's "started near frontal" test uses it, so inflated early frames no longer produce `MOTION_UNVERIFIED`.
- Raw candidates (`yawOriginal`, `yawMirrored`, `yawAgree`) are recorded per frame for calibration.

Replay of the five sessions after the change: 3 approved, 1 manual review (look-up burst with two frames where the face had left the frame → evidence insufficient), 1 rejected (the 0.436 selfie). Open: the passive model's low scores on some frontal frames in this room's lighting (selfie 0.436, early look-up frame 0.05), and the face leaving the frame on look-up on the phone (2 of 4 frames without a face → evidence insufficient).

## Third live round (16:41–16:46 UTC): detector misses on chin-up faces

Eight sessions: 4 approved, 3 manual review, 1 rejected. Measured across 216 challenge frames of the day: the face detector found no face in 19% of look_up frames (0–1% for every other action). The affected frames show a well-lit chin-up face fully inside the picture, so this is a detector limitation, not the face leaving the frame. Probing the detector's raw candidates on those frames: a box at confidence 0.39–0.64 sits exactly where the neighbouring frames' faces are; at 0.1 only whole-frame garbage appears.

Changes:

- **Tracking-anchored fallback detection.** Challenge frames are scored in time order and each hands the previous frame's face box to the detector as a prior. When the 0.65 threshold finds nothing, a candidate at ≥ 0.3 is accepted only if it overlaps that prior box (IoU ≥ 0.3); such frames are marked `detection: "tracked-low-confidence"` with their confidence. Replay: the two sessions that were `LIVENESS_EVIDENCE_INSUFFICIENT` on look_up now carry full bursts; one approves, the other stays in review for its assisted reissue.
- **Trajectory start margin** 1.5× the action threshold (a low-held phone offsets every pitch reading by 10–15°), with travel across the burst now required to reach a full threshold so a head parked at the target angle is never a movement.
- **Client wrong-way coaching** now needs four consecutive opposite-direction ticks before it shows; three sessions had a single noisy "wrong way" reading on a correct look-down push the tester into reissuing the challenge (which forces review by design).

Still open: the pose model reports a 54° yaw for a chin-up face in one session (look_up failed on pose, not detection); the passive model scored one selfie 0.436 and one 0.644 against a 0.65 pass line. Both are model quality limits; per-frame candidates are recorded for the calibration set.
