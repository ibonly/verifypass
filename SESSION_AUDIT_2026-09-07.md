# Admin Session Audit: 7 September 2026

## Findings

**Recommendation:** prioritize passive-model calibration, reliable challenge capture, attempt-aware reporting, and build-specific release validation. Do not lower spoof thresholds or enable production approval merely to improve this test cohort's approval rate.

The configured development database contains **79 sandbox sessions, 70 results and 864 images** across two tenants. Every image was recovered, decrypted and SHA-256 verified. The latest three completed sessions were replayed with the current worker in memory: two approvals and one rejection reproduced exactly. No live database records, stored decisions, workers or production settings were changed.

The most recent failure is still present in current code. Its immediate blocker is **passive score eligibility**, not just an inability to recognize a turn. The other major current findings are **27 overdue nonterminal sessions**, mixed-attempt evidence in the admin gallery, and **eight source digests sharing one policy version**.

## References

- [Complete per-session ledger](audit/liveness/private/sessions-KB59im/SESSION_LEDGER.md): individual interpretation for all 79 sessions, all 70 result rows, decision/retry history, and every image reference.
- [Browsable image gallery](audit/liveness/private/sessions-KB59im/index.html): original-resolution images organized by session, including older attempts.
- [Database export](audit/liveness/private/sessions-KB59im/database.json), [evidence integrity manifest](audit/liveness/private/sessions-KB59im/evidence-manifest.json), [snapshot manifest](audit/liveness/private/sessions-KB59im/manifest.json), [current replay](audit/liveness/private/sessions-KB59im/replay-current.json).

These references are local, private audit artifacts and deliberately ignored by Git. They will not accompany this report in a clone. Directory permissions are restricted and files are owner-only; the exported images are **decrypted**, not encrypted at rest by the exporter. Apply an agreed audit retention period, avoid public hosting, and delete the private bundle when it is no longer needed. The source evidence remains encrypted and unchanged.

## Scope And Method

Snapshot: **2026-09-07 17:33:46-17:33:51 UTC**. Session creation range: **2026-09-01 03:40:08 to 2026-09-07 17:17:21 UTC**.

The data was read directly from the database configured for the local admin backend, using its existing Prisma client and evidence decryption service. This avoids dashboard listing limits and latest-result filtering. It is not a production or remote-admin export.

| Data | Exported Rows |
| --- | ---: |
| Tenants | 2 |
| Verification sessions | 79 |
| Verification results, including historical attempts | 70 |
| Evidence files | 864 |
| Audit logs | 1,234 |
| Job queue | 140 |
| Outbox | 63 |
| Manual review notes | 0 |
| Webhook deliveries | 0 |
| Evidence staging | 0 |

Counts matched before and after extraction. Reads were sequential, not an atomic database snapshot; unchanged counts do not prove no in-place updates occurred. All exported results and images resolve to an exported session. All 864 originals are decodable images and match stored checksums, with no read errors or integrity mismatches. Fourteen contact sheets cover all images and were visually reviewed at thumbnail resolution; full-resolution originals remain available for closer inspection.

This is **all verification-related data**, not a credential-bearing database backup. User/password/MFA records, API-key records, authentication secrets, rate-limit counters and internal analysis receipts were excluded. Secret-bearing named fields in included objects were redacted. The bundle still contains sensitive session metadata, document fields and images; it is not an anonymized dataset.

No independent bona fide/attack labels were supplied. Visible faces or movement in still images cannot establish physical liveness, identity continuity, or document authenticity. No APCER/BPCER, identity false-match rate, population accuracy or production readiness is claimed.

## Outcomes

| Current Database State | All Sessions | FACE_ONLY |
| --- | ---: | ---: |
| Approved | 16 | 12 |
| Rejected | 21 | 21 |
| Manual review | 14 | 14 |
| Created | 21 | 17 |
| Started | 7 | 6 |
| Total | 79 | 70 |

The remaining product counts are five ID_ONLY and four ID_AND_FACE. Four approvals are document-only and must not be counted as liveness successes. All 79 sessions have `isLive: false`; this flag identifies sandbox traffic, not whether a captured person is physically live.

- 63 sessions recorded consent; 58 retained images; 57 have at least one result.
- 51 currently have a decided status; six additional sessions have historical results but were reopened. Do not equate 70 results with 70 sessions.
- FACE_ONLY current decided-state approval is **12/47 (25.5%)**, not a measured true-accept rate.
- The 29 afternoon sessions, S51-S79, currently show 9 approvals, 9 rejections, 7 reviews and 4 unfinished sessions. There are 27 scored results because two unfinished sessions also have prior results.
- Among those 27 afternoon results, five selfie scores are below 0.50 and three are between 0.50 and 0.65. These are score-band counts, not confirmed false-reject counts.
- All 140 queued jobs are `done`; all 63 outbox entries are `sent`. No stuck queue entries were observed. There are no configured tenant webhook URLs, so zero deliveries do not demonstrate delivery reliability.
- Recorded pipeline execution time exists on 30 results: median **424 ms**, maximum **704 ms**. These are worker-internal timings, not browser-to-result latency or a load benchmark.

## Latest Sessions

All four share source digest prefix `fa78d3762595`, policy `2026-09-06.1-liveness-policy-v2`, and `policy.validated: false`.

| Ref | Stored State | Detailed Finding | Current Replay |
| --- | --- | --- | --- |
| [S76](audit/liveness/private/sessions-KB59im/sessions/vps_1K1UDRRP3S25P9T9S3P46/index.html) | Started, attempt 2 | Attempt 1: all actions passed, identity 0.843; selfie 0.596 caused review despite frontal scores 0.974, 0.958, 0.990. Attempt 2 contains one frame and no result. | Not replayed: current attempt is incomplete. |
| [S77](audit/liveness/private/sessions-KB59im/sessions/vps_1K1UDTPTES857JGWETADM/index.html) | Approved | Selfie 0.977, identity 0.675, all actions passed. Frontal-frame passive median is only 0.226 and is record-only. | Approved. |
| [S78](audit/liveness/private/sessions-KB59im/sessions/vps_1K1UDUU8EGJ80KDG2NREG/index.html) | Approved | Selfie 0.926, identity 0.526. Frontal median 0.217; turn-left max 0.294 passes the strong-selfie softened floor. | Approved. |
| [S79](audit/liveness/private/sessions-KB59im/sessions/vps_1K1UDVNL8AG5ZZ2QY7KHD/index.html) | Rejected | Selfie 0.393; turn-right max 0.273 and turn-left max 0.243 are below the 0.3 action floor. Look-up passes at pitch 39.3. Final reasons: `LIVENESS_CHALLENGE_FAILED`, `LIVENESS_FAILED`. | Same rejection and reasons. |

S79's images show a visible face and turns, but its weak selfie does not qualify for the 0.2 soft floor used for strong selfies. Both turn bursts therefore fail before useful pose eligibility. A pose-only fix would not resolve this recorded failure. Conversely, S77/S78 show why a high selfie must not automatically be treated as proof that independently uploaded action frames are safe.

## Required Improvements

### P0: Before Production Approval

**I01. Validate an immutable release, not a reused policy label.** Forty legacy results have no source digest. The other 30 contain eight distinct source digests under one policy string. Current validation and queued-job compatibility compare policy strings, while significant decision behavior has changed within that string. The admin result view displays the commit and pipeline, but not the digest.

Required: bind validation to source digest, model hashes, effective thresholds/policy and capture protocol version; store the calibration dataset/version and results; display this identity in the admin UI. Keep source identity distinct from protocol compatibility so harmless code changes do not needlessly strand jobs. The release gate must fail for an unvalidated decision-affecting build rather than merely printing `policyValidated: false`.

Acceptance: changing a model, threshold or decision rule invalidates prior approval; an older incompatible worker cannot adjudicate a new protocol job. Build-specific dashboards must separate historical and current cohorts.

Code: [release identity](backend/src/lib/release.js#L4), [release check](backend/scripts/check-liveness-release.js#L21), [worker compatibility](backend/src/worker/pipeline.js#L78), [production validation](backend/src/worker/pipeline.js#L389), [admin release display](frontend/dashboard/src/App.jsx#L456).

**I02. Calibrate passive liveness and stabilize selfie acquisition without selecting the highest score.** S76/S79 and the afternoon score distribution show inconsistent passive output; S77/S78 also show low challenge-frame scores alongside approved selfies. This is a repeatable model/capture-quality limitation, but not independently labelled false rejection or acceptance.

Required: collect consented, independently labelled bona fide and print/replay/mask/injection samples across devices, exposure, background and pose. Evaluate quality checks for blur, exposure and face size, plus a fixed-size fresh neutral selfie burst with a predeclared median rule or bounded quality-triggered recapture. Do not select best-of-N liveness scores or let challenge frames silently lift a failed selfie to automatic approval. Compare candidate models on held-out data with attack and bona fide error rates and confidence intervals.

Acceptance: reproduce S76-S79, retain blank/no-face rejection S23, and measure both security and usability before changing thresholds. A good outcome on these few images is insufficient.

Code: [selfie bands](backend/shared/src/decisionEngine.js#L123), [record-only frontal aggregate](backend/src/worker/pipeline.js#L333), [independent active-frame floors](backend/shared/src/livenessChallenge.js#L90).

**I03. Improve pose/detection and capture guidance as one tested workflow.** Historical sessions S39, S53, S55, S61, S64, S66, S67, S71 and S75 expose chin-up detection, yaw magnitude/sign, baseline and trajectory weaknesses. S79 adds the need to report whether pose was actually evaluated or blocked by passive eligibility.

Required: neutral baseline before each action, modest motion targets, blur/framing checks, direction coaching that accounts for mirroring, and separate diagnostic states for no face, low-confidence tracked face, passive-floor failure, insufficient motion and wrong direction. Validate the tracked detector and mirrored pose inference on negative samples, not only successful captures. Evaluate a pose model with measured left/right sign accuracy before restoring directional enforcement; record-only consistency leaves directional challenge semantics weaker.

Acceptance: phone and webcam tests cover both turns, both tilts, low-held cameras, incorrect directions, stationary target poses, tracked false boxes, and partial interruption. Do not lower the 0.3/0.2 floors simply because S79 then passes.

**I04. Validate identity continuity across the whole action sequence.** Best-frontal aggregation reduces sensitivity to extreme poses but can only establish that at least one qualifying frame resembles the selfie. S77/S78's low passive frames make cross-upload assumptions particularly important.

Required: ensure usable identity observations cover each action and test temporal continuity with uncertainty-aware handling. Add adversarial cases that preserve one matching frontal frame while substituting other action frames. Keep frame HMAC/session/attempt binding, but do not mistake server-side upload binding for proof of camera provenance. Compare per-action or temporal aggregation on labelled data before changing the current rule.

Acceptance: a matching selfie plus a single matching frame cannot conceal a switched identity or replay in another action; legitimate pose changes do not cause systematic hard mismatches.

Code: [best-frontal identity selection](backend/src/worker/pipeline.js#L315).

### P1: Current Workflow And Operations

**I05. Make results and evidence attempt-aware throughout the admin UI.** The detail endpoint filters the latest result to the current attempt, but its evidence endpoint returns all images and omits `attemptId`. The gallery renders them together. S59 has 22 images spanning reissue; S68/S73 have 18; S76 has prior-attempt results and a new frame. Legacy S24 has three results and a fourth retry event while its stored attemptNumber is 1.

Required: explicit attempt selector, prior/current outcome distinction, exact consumed evidence IDs, per-action diagnostics, and clear legacy/unbound badges. Do not backfill certainty where legacy IDs are absent. Preserve historical decisions; replay must be a separate comparison, not an overwrite.

Acceptance: S76 shows attempt 1 review and attempt 2 incomplete; S24 exposes its audit-derived legacy history; a reviewer never attributes an earlier selfie to a new result.

Code: [current result filter](backend/src/routes/dashboard.js#L75), [unfiltered evidence listing](backend/src/routes/dashboard.js#L188), [gallery](frontend/dashboard/src/App.jsx#L536).

**I06. Terminalize overdue sessions and report abandonment correctly.** Twenty-seven `created`/`started` sessions are past `expiresAt` at the snapshot. S76 is the only nonterminal session still within TTL at that time. Old records can persist because expiry is applied on selected session/upload requests, while dashboard reads do not perform the same transition.

Required: periodic idempotent expiration with a race-safe state guard and audit event; distinguish unsubmitted abandonment, expired retry and completed prior attempt. The dashboard should calculate/display overdue state consistently even before a sweep.

Acceptance: overdue S1/S24/S60/S62 transition without a browser revisit; the sweep cannot expire a concurrently submitted or completed attempt; metrics no longer imply those sessions remain actively waiting.

Code: [lazy expiration](backend/src/services/sessionService.js#L113), [retry state](backend/src/services/sessionService.js#L325), [dashboard listing](backend/src/routes/dashboard.js#L49).

**I07. Keep worker mismatch protections and test them against the exact protocol.** S49/S50 retain historical `LIVENESS_FRAME_BINDING_FAILED` outcomes from the old pipeline processing newly bound frames. This is historical deployment incompatibility, not confirmed current queue failure. The current worker already has a policy mismatch check, and the previous analysis documents a singleton worker fix.

Required: retain those protections, add protocol/build compatibility rollout tests, record API and worker identities together, and alert on prolonged incompatibility. Do not weaken frame binding to make old records pass. Current queue health does not establish behavior under rolling deployment or concurrency.

**I08. Keep flash and texture experimental until measured.** Across all 70 result rows, flash diagnostics are absent in 36, explicitly missing in 25, `no_response` in four, identity error in three, `wrong_response` in one and `responded` in one. These mixed historical records do not support promoting flash into an approval or rejection gate. The newest four have no useful validated flash evidence.

Required: reliable tile capture and identity checks, synchronized capture timing, exposure/device stratification, and attack-response calibration. Record whether flash was issued, captured, readable, and usable. Do not label missing flash as an attack unless a validated protocol requires it.

**I09. Reduce capture abandonment and unnecessary assisted reissues.** Six consented sessions retained no capture; S62 stopped after two frames. S58/S59/S68/S73/S75 include assisted-policy flags. Stored data alone cannot determine whether exits came from users, camera permission, model loading, wrong-way guidance, network or crashes.

Required: structured client events for consent completion, camera permission, model readiness/failure, action wait/trigger, upload error, retry/reissue and exit, with device/build correlation. Separate genuine user-requested assistance from noisy coaching. Preserve the review safeguard for assisted challenges while improving guidance and recovery.

Acceptance: interrupted sessions have a useful terminal reason; a reissue cannot evade challenge checks; repeated benign hint errors are visible by device cohort.

### P2: Product Semantics And Audit Coverage

**I10. Validate document outcomes independently of OCR confidence.** S30/S34/S36/S37 were approved with OCR confidence 0.58-0.61. This demonstrates extraction ran, not that every field or document is authentic. S4 contains an invalid document capture and historical `faceMatchStatus: matched` with null score; current pipeline code already returns review for a missing face/score.

Required: retain the null-score regression, annotate historical inconsistent data in the UI, benchmark field-level OCR against expected values, test expiry/tampering/required sides and document authenticity, and keep document-only outcomes out of liveness metrics.

Code: [current face-match result mapping](backend/src/worker/pipeline.js#L499).

**I11. Enforce consent and protect audit exports operationally.** S23 is the only captured session without recorded consent; its images are blank negative controls and the environment is development. This is not evidence of a production consent bypass. No manual-review notes were recorded despite 14 sessions currently awaiting review.

Required: production no-consent upload tests, consent-copy/version retention, local audit access controls and deletion policy, plus a review workflow that records decisions and rationale. Review legitimate cases against the actual attempt evidence; do not infer the reviewer workflow is tested merely because sessions reach its queue.

**I12. Expand the regression matrix beyond this local cohort.** Add independently labelled attacks, device/browser diversity, real multi-face/occlusion examples, same-direction substitutions, identity switches, late/duplicate/out-of-order submissions, API-worker skew, consent failures, expiry races, assisted reissues and webhook delivery/retry tests. Keep fixture data encrypted/access-controlled and track test cohort provenance.

Acceptance: publish build-specific security/usability metrics and operational test results; distinguish unit-test success, local replay agreement and real-world validation. No production readiness claim should rely on the observed local approval rate.

## Historical Fixes

The earlier [session analysis](LIVENESS_SESSION_ANALYSIS_2026-09-07.md) records changes already present in current code: best-frontal identity, record-only passive aggregation and direction consistency, revised trajectory handling, mirrored pose inference, tracked detection, and a null-score face-match fix. The current snapshot includes records from before and after those changes.

Do not repeat those edits blindly. The latest completed replay confirms current outcomes for S77-S79 only; older-session interpretations use their stored results and imagery unless explicitly identified as prior historical replay. In particular, the prior report's suggestion that all chin-up detector misses were faces leaving the frame is not supported by the thumbnail review: several show a face still inside the image.

## Verification And Reproduction

The reusable read-only exporter is [audit/liveness/export-sessions.cjs](audit/liveness/export-sessions.cjs). Run `node audit/liveness/export-sessions.cjs` from the repository root. It creates a new private bundle, pages through all session-related rows, redacts named credential fields, verifies images and generates the gallery. It does not provide an atomic database snapshot.

The snapshot-specific ledger generator is [audit/liveness/analyze-export.cjs](audit/liveness/analyze-export.cjs). Its human observations are deliberately locked to this snapshot to avoid applying them to new test runs. Run `node audit/liveness/analyze-export.cjs audit/liveness/private/sessions-KB59im` to regenerate this ledger.

Validation performed: script syntax checks, successful export/decryption/checksums for 864 images, before/after count reconciliation, complete ledger coverage, and in-memory current-worker replay of S77-S79. No application fixes were made and the full application test suite was not run for this analysis.

## Implementation Follow-up

The audit above describes the original snapshot. The following code changes were subsequently implemented on request; the private export and historical decisions were not changed.

| Item | Implemented | Remaining |
| --- | --- | --- |
| I01 / I07 release validation | Fingerprint-bound receipts include backend source, model set, settings, effective thresholds and provider/runtime configuration. Production decisions and the release command reject missing validation. New policy version prevents older workers claiming its jobs. | Independently labelled evaluation and operator-issued receipts; immutable versioning of external model services. Receipt provenance is an operator attestation, not cryptographic certification. SDK/camera provenance is not established by the backend fingerprint. |
| I05 attempt reporting | Result selector, per-result decision snapshots, consumed evidence IDs, current/previous separation, explicit legacy/attempt attribution, source digest and validation provenance in the dashboard. Cross-session selection is rejected. | Legacy records cannot be given exact binding retroactively; old retry histories remain audit-derived. |
| I06 expiry | Bounded transactional sweep with an audit event and race guards, scheduled in the polling worker's one-minute maintenance. Dashboard reads show effective overdue status without database writes. | Deploy/restart the updated worker to sweep real records; external scheduler topology still needs its existing scheduled invocation. |
| I02 / I03 diagnostics | Selfie/frontal score comparison in the dashboard; active-frame floor failures identify the floor and state that pose was not evaluated. | Model calibration/replacement, selfie-burst evaluation, camera-quality gating and device-specific coaching. No passive or pose thresholds were weakened. |
| I10 result semantics | Historical `matched` results with null scores display as review; current worker regression retained. | Document field accuracy/authenticity evaluation. |
| I04 / I08 / I09 / I11 / I12 | Existing identity, flash, assistance, consent and security safeguards retained. Added regressions cover the implemented release, expiry and history changes. | Per-action identity-policy validation, flash calibration, client exit telemetry, review operations, export-retention policy and broader labelled security/device testing. These are not claimed complete. |

Validation for the follow-up: 290 backend and 96 shared tests passed; dashboard tests and production build passed. Synthetic browser checks exercised current/historical/legacy selection, original-image loading, clearing stale result content, and desktop/mobile layout. No biometric records were used for browser fixtures. Further focused tests covered the final passive-floor diagnostics and provider-version fingerprinting.

The release command is intentionally expected to fail until genuine evaluation receipts are configured. No receipt, production setting, historical decision or live session state was fabricated or changed. See the updated [deployment notes](README.md) before restarting API and worker together.