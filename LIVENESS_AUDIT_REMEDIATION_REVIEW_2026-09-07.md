# Liveness audit remediation review — 7 September 2026

Review of the uncommitted working tree against `LIVENESS_AUDIT_2026-09-06.md` (35 findings, L01–L35). The goal was to establish, per finding, whether the audit's required change landed, whether it is actually exercised by the code path that mattered, and what new gaps or defects the remediation introduced.

## Method

- Re-ran every executable proof block from the audit's `audit/liveness/reproduce.cjs` and `audit/liveness/concurrency.cjs` **individually** (the originals stop at the first assertion). A block that still asserts the audit's undesirable behaviour is marked *still reproduces*; one whose assertion now fails is marked *behaviour changed*, and the new behaviour was inspected.
- Added realistic multi-frame pipeline scenarios (3 distinct frames per action, opposite-signed yaw, EAR blink curve, v2 HMAC binding, `attemptId`) because the audit fixtures (one frame per action, same-sign yaw) are now rejected for fixture reasons and cannot distinguish the L06/L11/L12/L16 fixes from a generic rejection.
- Added staging-aware upload race harnesses for L19 (the audit fakes bypass the new `evidenceStaging` callback).
- Read the changed backend, shared, worker, SDK core, React widget, vanilla SDK, and ops files.
- Ran the full suite.

| Suite | Result |
| --- | --- |
| backend `tests/` | 257 pass, 0 fail |
| backend `shared/tests/` | 95 pass, 0 fail |
| SDK core | 107 pass, 0 fail |
| dashboard | 2 pass, 0 fail |

Scripts used for this review are saved under `audit/liveness/recheck/` (`findings.cjs`, `concurrency.cjs`, `upload-races.cjs`, `pipeline-scenarios.cjs`). Run from the repo root with `node audit/liveness/recheck/<file>`. No browser, real database, real model, or device run was performed; frontend findings are source-level.

## Status summary

| Status | Findings |
| --- | --- |
| Fixed, verified by execution | L02, L03, L04, L05, L06, L08, L10, L11, L12, L13, L14, L15, L16, L17 (partly), L18, L19 |
| Fixed by source inspection (no browser run) | L20, L21, L22, L23, L24, L25, L26, L27 (by narrowing), L28, L29, L30, L32, L34, L35 |
| Fixed at the decision layer, library still permissive | L01, L07, L09 |
| Partially fixed, new defect introduced | L17 (see G1) |
| Tooling added, validation still outstanding by nature | L31, L33 |

Net: 32 of 35 findings have a landed fix. The remediation also introduced one P1 behavioural regression (G1), two P1 operational/contract gaps (G2, G3), and a handful of P2/P3 issues listed under "New gaps and bugs".

## Per-finding detail

### Reproduced findings (L01–L13)

**L01 — Missing expression evidence.** *Fixed at decision layer; library unchanged.* `verifyLivenessChallenge` still returns `ok:true` for a blink action with one frame and no landmarks (recheck block L01 still reproduces). What closes the gap is the new `evidenceInsufficient` flag: blink/open_mouth without a confirmed EAR/MAR transition, or any action with fewer than 3 distinct faced frames, routes to `manual_review` with `LIVENESS_EVIDENCE_INSUFFICIENT` (scenario "legacy blink, 3 frames, no landmarks" → manual_review). A blink with a real closure-and-reopen EAR curve approves. Blink now requires ordered close→reopen, not just extrema. The generator only issues expressions when `supportsExpressions:true`, and no caller passes it, so blink/open_mouth are never issued for new sessions (see G5). Faceplugin still has no `faceLandmarks`; ONNX does.

**L02 — Same-direction / unordered actions.** *Fixed.* `enforceConsistency` and `enforceSequence` are now hard-coded `true` in the pipeline; same-sign turns reject with `LIVENESS_DIRECTION_INCONSISTENT`. `strictDirection` remains tenant opt-in, which the audit accepted given the device-independent consistency check. The `.env.example` comments still describe these as opt-in flags (see G2).

**L03 — One or two still frames.** *Fixed.* Fewer than 3 faced, checksum-distinct frames per action, or any non-finite score, sets `evidenceInsufficient` → review. Scenario "one frame per action" → manual_review.

**L04 — Frontal frame vouching for a turned spoof frame.** *Fixed.* Pose verdicts, trajectory and expression are computed only over `eligible` frames that individually clear the spoof floor. The audit fixture now fails with `LIVENESS_CHALLENGE_FAILED`.

**L05 — Non-finite scores.** *Fixed.* `decide()` rejects any liveness score that is not finite and in [0,1]; identity/face-match out-of-range values route to review; the pipeline throws `INVALID_LIVENESS_PROVIDER_OUTPUT` for malformed challenge-frame provider output. NaN → rejected.

**L06 — Identity failure permits approval.** *Fixed.* Identity is always present in the signals for face flows; unavailable/erroring identity → `LIVENESS_IDENTITY_UNAVAILABLE` review. Embedding path throws on missing/invalid per-frame scores instead of silently skipping. Verified in the production-mode pipeline recheck and in the new `pipeline.test.js` hardening test.

**L07 — Exclusions remove every head movement.** *Fixed at API; library permissive.* `reissueChallenge` now accepts exactly one exclusion that must be in the current challenge, caps reissues via a durable `reissueCount`, and marks the new challenge `assisted:true`, which forces `policyUnverified` → review. The library function still returns `actions: []` when everything is excluded instead of throwing (see G7); the pipeline fails closed on an empty challenge (`LIVENESS_CHALLENGE_INCOMPLETE`).

**L08 — Future issue timestamps.** *Fixed.* `isChallengeFresh` requires `-5s ≤ age ≤ ttl`.

**L09 — Synthetic flash.** *Fixed at pipeline; scorer unchanged.* `scoreFlashResponse` still scores synthetic tile means as valid (recheck block still reproduces). The pipeline now: uses a server-issued `flashSequence` stored on the challenge; the upload rejects any sequence that does not match it; the worker verifies the mosaic's HMAC (v2 binding includes `meta`), checks mosaic dimensions, and requires each tile to contain exactly one face matching the selfie above the face-match pass threshold. Flash is labelled `experimental` in the policy block and can only ever route to review. The browser sequence is no longer `Math.random()`; it comes from the server. Attack-resistance validation remains L31 territory.

**L10 — Vanilla manual capture labelled auto.** *Fixed.* Client default is now `"unknown"`; the server stores unknown/absent modes as `unknown`, and anything other than `auto` is `manualCapture` → review. The vanilla SDK no longer captures at all (see L27).

**L11 — Aggregation overrides a failing selfie.** *Fixed.* Decision score is `min(selfieScore, median)`, so challenge frames can only lower it. Selfie 0.01 with three 0.95 frames → rejected `LIVENESS_FAILED`; selfie 0.5 → rejected. Persisted `livenessScore` is the decision score; the raw selfie score is in `rawResult.liveness.passiveAggregate.selfieScore` and exposed as `liveness.selfieScore` on the result API.

**L12 — Enforced flash bypass by omission.** *Fixed.* `requireFlash` is derived from tenant/env independently of scoring; a missing or erroring mosaic keeps `enforced:true` and `ok:null`, and `decide()` reviews whenever `enforced && ok !== true`. Scenario with `enforceFlash:true` and no mosaic → manual_review `LIVENESS_FLASH_UNVERIFIED`. Unsigned mosaic covered by a suite test.

**L13 — Approved session without a result.** *Fixed.* `finalize()` runs the status CAS, result, audit and webhook outbox row in one `$transaction` (with P2034 retry); dispatch happens after commit via `flushOutbox`. Injected result failure rolls back the status (suite test asserts `submitted` remains and a retry approves). Requires MongoDB replica set; `check-liveness-release.js` asserts that.

### Additional source-level findings (L14–L30)

**L14 — Submission and enqueue.** *Fixed.* `submitSession` is transactional, idempotent (`submitted` → 202 again), writes a `run_verification` outbox row with `attemptId`, and flushes best-effort. Queue outage now returns 202 with the row pending; the worker tick and every Lambda job flush the outbox. Verified via HTTP harness (`L14-*` blocks).

**L15 — Retry/reissue limits on audit rows.** *Fixed.* Durable `attemptNumber` and `reissueCount` on the session, compare-and-set via `revision` increments inside a transaction, `validateAttempt` fencing on every mutating call. Audit failure now aborts the retry (rolls back) instead of being swallowed. Concurrent reissues: one wins, others get `VALIDATION_ERROR`.

**L16 — Worker not fenced to an attempt.** *Fixed.* `attemptId` travels in the job payload, evidence rows, result rows, webhook payload and the status CAS; superseded payloads skip. Legacy sessions without `attemptId` still use the plain status CAS.

**L17 — Freshness vs queue latency.** *Partly fixed, with a regression.* Submit and upload now check session expiry (410 `SESSION_EXPIRED` verified), `submittedAt` is stored and used as the worker's `now`, so queue latency no longer expires a challenge (scenario "9.5 min old, queued 20 min" → approved). Open: the challenge clock still starts at session creation, the 10-minute challenge TTL versus 30-minute session TTL mismatch is unchanged, and the newly enforced 3-minute issue-to-first-frame rule hard-rejects slow flows. See **G1**.

**L18 — Frame binding scope.** *Fixed.* Worker recomputes the plaintext SHA-256 and compares to the row (`EVIDENCE_CHECKSUM_MISMATCH`), and the v2 HMAC covers `[tenantId, sessionId, attemptId, fileType, captureMode, meta]`. Flash mosaics go through the same validator. Documents are re-bound on reissue. Legacy rows without `attemptId` keep the v1 binding.

**L19 — Upload quota races and orphan evidence.** *Fixed.* Storage write creates an `evidenceStaging` row; the commit transaction re-reads the session, re-counts per-attempt evidence, consumes the staging row, bumps `revision`, and inserts the row. Losers delete the file and Cloudinary mirror, and enqueue `cleanup_evidence` if that fails; `reconcileEvidence` sweeps stale staging rows every reclaim cycle. Verified: 3 concurrent uploads with cap 2 → 2 rows, 1 rejection, loser's file deleted; injected row failure → file deleted; upload racing a submit → rejected and cleaned. Minor: the loser's staging row stays `pending` until the 30-minute sweep (G8).

**L20 — Consent fire-and-forget.** *Fixed (source).* Consent is awaited; failure shows a retryable alert; button disabled while busy.

**L21 — Challenge fetch failure fallback.** *Fixed (source).* Init error blocks the UI with a retry button and re-runs init via `initEpoch`; no fallback to ID_AND_FACE.

**L22 — Reissue on first action keeps old detector.** *Fixed (source).* `challengeEpoch` is bumped on reissue/retry and is in the auto-capture effect's dependency list; reference-pose state is reset.

**L23 — Burst bookkeeping before success.** *Fixed (source).* `shots`, `earlyShotTaken`, `expressionShotTaken` increment only when `capture()` resolves `true`; a stalled burst still returns to `await` after `BURST_TOTAL + 1500ms`, so no dead end. One related defect in the budget-exceeded handler (G4).

**L24 — POST deadlines and cancellation.** *Fixed (source).* Single `_request` with 30s/15s timeouts, per-client `AbortController`, `dispose()` on unmount, aborted checks before state changes, cancellable polling. `attemptId` is attached to every POST automatically.

**L25 — Pose reference sampling.** *Fixed (source).* Samples keyed on the detection's `observedAt` timestamp.

**L26 — Session prop changes.** *Fixed (source).* Widget is remounted via `key={sessionId:sdkToken}`; consent and all session state reset.

**L27 — Vanilla SDK parity.** *Fixed by narrowing.* The CDN entry now embeds the hosted verification page (`/session/<id>#t=<token>`) in an iframe and polls for the result, so there is one capture implementation. It requires HTTPS (or localhost) for `hostedBaseUrl`, which defaults to `https://verify.verifypass.com`; that page must be deployed for the vanilla SDK to work at all. No integration test exists for the iframe path.

**L28 — Model cache drift.** *Fixed.* Browser: versioned cache name, per-file SHA-256 from `modelManifest.json`, HTML responses rejected before caching, eviction on ONNX session failure, ORT load promise reset on failure. Server: `fetch-models.js` downloads to a `.partial` file, verifies the manifest digest, renames atomically; the ONNX provider verifies digests at load. Download URL still points at the mutable `main` branch, but the digest pin makes that safe.

**L29 — Version/score/status misreporting.** *Fixed.* `PIPELINE_VERSION` is the policy version `2026-09-06.1-liveness-policy-v2`; `rawResult.release` carries commit, source digest, model set digest and policy version; `livenessStatus` derives from every `LIVENESS_*` code; result API exposes `score`, `selfieScore`, `activeStatus`, `policy`, `release`, `attemptId`; results are matched to the current attempt.

**L30 — Quadratic telemetry.** *Fixed.* Neighbour window bounded to 64, duplicate lists capped at 10, query bounded to 5000 sessions and 1000 per tenant, idempotency via `analysisReceipt` keyed on session/attempt/flags inside a transaction. Trade-off: clusters larger than 64 identical vectors are only partially linked (G9).

### Conditional risks and improvements (L31–L35)

**L31 — Model accuracy evidence.** *Tooling only.* `evaluate-liveness-dataset.js` requires independently labelled held-out data, reports Wilson intervals, refuses circular labels; `calibrate-thresholds.js` now uses reviewer labels only and marks output preliminary. No dataset exists in the repo; this is expected and remains open by nature.

**L32 — Inference latency and leases.** *Fixed.* Total job budget (`budgetMs`, default 180s, capped 240s) with a late-result guard; provider call memoisation by buffer hash; ONNX detection cache; 15s lease heartbeat in both workers; job completion writes are owner-fenced; `performance` block in `rawResult`. A synthetic detector benchmark exists (`detection-benchmark.json`), not a full-pipeline measurement.

**L33 — Browser lifecycle, flashing, accessibility.** *Partly (source).* `nextVideoFrame` waits for a real camera frame before each capture; camera pauses on `hidden`/orientation change; late model loads are disposed; reduced-motion CSS; flash is per-user opt-in with explanatory copy. Device and screen-reader testing still required.

**L34 — Deployment consistency.** *Fixed.* `assertGeneratedSchema()` runs before any Prisma client is created (API and worker); `/health`, `/status` and `/result` carry release identity; `npm run release:check` verifies generated schema, replica set, outbox table and model digests; `smoke-liveness-local.js` exercises CORS preflight, consent, real upload/sanitize/encrypt and transaction rollback against a local database. Not documented in the README (G2).

**L35 — Advisory vs enforced signals.** *Fixed.* `rawResult.policy` states what is enforced/experimental/advisory and whether the deployment declares validation; exposed on result API and dashboard with reviewer copy; new reason labels added.

## New gaps and bugs found during this review

**G1 (P1, regression) — Challenge clock starts at session creation and the new sequence rule hard-rejects slow flows.**
`assessSequence` is now enforced with `maxIssueToFirstMs = 180000`. `issuedAt` is set only at `createSession`, `retrySession` and `reissueChallenge`. For ID_AND_FACE the user does consent, camera permission and document capture (possibly two sides) before the first liveness frame; for any flow, the integrator may create the session well before the user opens the hosted link. Reproduced: a perfectly good two-turn session whose first frame lands 4 minutes after issue → `rejected` with `LIVENESS_CHALLENGE_SEQUENCE_INVALID`. The same session at 11 minutes → 410 at submit and `LIVENESS_CHALLENGE_EXPIRED` in the worker, while the session itself is valid for 30 minutes. Neither code is in `USER_SAFE_REASON_CODES`, so the user sees an unexplained failure, and `retrySession` is not available from `started`. Recommended fix: start the challenge clock when the liveness step begins (an explicit "begin challenge" call that refreshes `issuedAt`/nonce without marking `assisted`), measure issue-to-first from that point, and surface both deadlines in `GET /challenge`.

**G2 (P1, operations) — Production auto-approval is gated on an undocumented environment variable.**
In production every face session gets `policyUnverified` → `manual_review` with `LIVENESS_POLICY_UNVERIFIED` unless `LIVENESS_VALIDATED_POLICY` equals `2026-09-06.1-liveness-policy-v2`. Reproduced in scenario "good in production, policy NOT validated". The variable appears only in `pipeline.js` and `check-liveness-release.js`; it is absent from `.env.example` and the README. Separately, `.env.example` still documents `CHALLENGE_ENFORCE_CONSISTENCY` / `CHALLENGE_ENFORCE_SEQUENCE` as opt-in flags, but the pipeline hard-codes both to enforced and ignores those variables. Update the env template and deployment docs, and either honour or remove the dead flags.

**G3 (P1, API contract) — `attemptId` is now required on every SDK mutation for new sessions.**
`validateAttempt` throws `VALIDATION_ERROR "Attempt changed; reload the verification"` whenever the session has an `attemptId` (all new sessions do) and the request omits or mismatches it. The bundled SDK client attaches it automatically after `getChallenge`/`retry`/`reissue`, but any integrator posting directly to `/document`, `/face`, `/liveness-frame`, `/flash`, `/verify`, `/retry`, `/challenge/reissue`, or any client running an older widget bundle, breaks. The value is returned by `POST /verification-sessions` and `GET /challenge`, but this is an undocumented breaking change; document it and consider a grace mode for legacy clients.

**G4 (P2, widget) — Budget-exceeded handler contradicts its own comment.**
In the liveness upload branch, the "too many liveness frames" catch sets `counts[action] = LIVENESS_FRAME_BUDGET` and then rethrows. The comment says the error is swallowed so the flow can advance; the rethrow reaches the outer catch, which calls `flow.fail(err)` and errors the whole step. Reachable when another tab or a redo within the same challenge consumes the server budget. Either drop the `throw err` or update the comment and make the failure user-recoverable.

**G5 (P2, policy) — Expression actions are disabled globally rather than by provider capability.**
The audit asked for challenge selection driven by verified provider capabilities. The generator's `supportsExpressions` parameter is never passed, so blink/open_mouth are never issued even with the ONNX provider, which does implement `faceLandmarks`. Legacy expression steps are handled correctly (review when unverified). Either wire `supportsExpressions` from the active provider or document that expressions are retired.

**G6 (P2, UX/policy) — Flash is now per-user opt-in.**
The consent screen adds an "allow screen colours" checkbox defaulting to off. For a tenant with `enforceFlash:true`, every user who leaves it unchecked routes to review. This is a defensible accessibility choice, but it should be stated in the tenant policy documentation and the dashboard reviewer copy.

**G7 (P3, library) — `generateLivenessChallenge` returns an empty action list instead of failing.**
With all four movements excluded it returns `actions: []`. Not reachable through the API (reissue allows exactly one exclusion), and the pipeline fails closed, but the library should throw.

**G8 (P3, storage) — Compensation path leaves the staging row behind.**
When an upload loses its commit race, the file is deleted but its `evidenceStaging` row stays `pending`; `reconcileEvidence` retries the delete after 30 minutes. This is only safe if `storage.removeStored` is idempotent for missing objects; that was not verified for the S3 backend. Delete the staging row in the compensation path.

**G9 (P3, telemetry) — Bounded duplicate search can under-link large bot clusters.**
The 64-neighbour window and 10-id cap make the pass bounded but mean identical-timing clusters above 64 sessions are only partially cross-referenced. Acceptable; document the limit in the job output.

**G10 (P3, UX) — New reject codes are hidden from users.**
`LIVENESS_CHALLENGE_SEQUENCE_INVALID`, `LIVENESS_DIRECTION_INCONSISTENT` and `LIVENESS_EVIDENCE_INSUFFICIENT` are not in `USER_SAFE_REASON_CODES`. Withholding fraud signals is correct, but the sequence-timing case (G1) is usually a genuine user who was slow; give it a user-safe "timed out, try again" mapping once G1 is fixed.

**G11 (housekeeping) — Audit artefacts are stale.**
`audit/liveness/reproduce.cjs` and `concurrency.cjs` now fail at their first assertion and `reproduction-results.json` describes the pre-fix state. The suite does cover most desired behaviours (`livenessHardening.test.js`, `livenessTransactions.test.js`, `pipeline.test.js` hardening cases). Replace or retire the diagnostic scripts as the audit recommended.

**G12 (documentation) — Vanilla SDK depends on a deployed hosted page.**
The CDN bundle's only mode is the hosted iframe; `hostedBaseUrl` defaults to a production hostname and must be HTTPS. Note this in onboarding and add at least one integration test for the iframe entry.

## What this review did not establish

- No browser execution: L20–L27 and L33 were verified by reading the React and SDK source, not by running the widget.
- No real MongoDB replica set: transactional behaviour was verified against the in-memory mock, which serialises transactions and rolls back on throw. Real write-conflict behaviour depends on `P2034` retries in `atomic.js`; `check-liveness-release.js` and `smoke-liveness-local.js` exist but were not run here.
- No real model inference, presentation-attack trial, device matrix, or held-out dataset evaluation.

## Recommended order of work

1. Fix G1 (challenge clock and 3-minute rule) before enabling the new sequence enforcement in any customer-facing environment; add a scenario test for "first frame at 4 minutes".
2. Document and template G2 (`LIVENESS_VALIDATED_POLICY`, dead enforce flags) and G3 (`attemptId` contract) in `.env.example`, README and the integrator guide.
3. Fix G4 and G8 (small code changes) and decide G5/G6 as policy.
4. Convert the audit reproductions into desired-behaviour regressions (G11) and run `release:check` plus the local smoke against a replica-set MongoDB before deploy.

## Remediation applied (7 September 2026, after this review)

| Gap | Change |
| --- | --- |
| G1 | New `POST /v1/verification-sessions/:id/challenge/begin` (`sessionService.beginChallenge`): refreshes `issuedAt`/`begunAt` while no frame exists for the current challenge, keeps the nonce so document bindings survive, audits `challenge.begun`, and returns `challengeExpiresAt`, `firstFrameDeadline`, `sessionExpiresAt`. `GET /challenge` now returns `challengeIssuedAt`, `challengeTtlMs`, `firstFrameWindowMs`. The SDK client gained `beginChallenge()`; the widget calls it when the liveness step is reached (re-armed per retry/reissue). Regression tests: `backend/tests/challengeBegin.test.js`, SDK client test, and the G1 block in `audit/liveness/concurrency.cjs`. |
| G2 | `.env.example` rewritten for policy v2: dead `CHALLENGE_ENFORCE_CONSISTENCY/SEQUENCE` lines removed, `LIVENESS_VALIDATED_POLICY`, `CHALLENGE_ALLOW_EXPRESSIONS`, `ENFORCE_POSE`, `BUILD_COMMIT`, `VP_PROVIDER` documented. README gained a "Liveness release checklist". |
| G3 | README "SDK / API contract notes" documents the `attemptId` requirement and the challenge clock. `validateAttempt` now distinguishes a missing `attemptId` (with instructions) from a mismatch. Strict fencing kept deliberately. |
| G4 | Widget budget-exceeded handler no longer rethrows; the action advances as the comment describes. |
| G5 | `generateLivenessChallenge({ supportsExpressions })` is now driven from `config.challengeExpressions` (`CHALLENGE_ALLOW_EXPRESSIONS=true` and ONNX provider) at create, retry and reissue. Default remains off; documented. |
| G6 | Dashboard policy copy and README state that flash is opt-in per user. |
| G7 | Generator throws when exclusions leave fewer than two verifiable actions; reissue converts that to `VALIDATION_ERROR`. Shared test added. |
| G8 | Upload compensation deletes the `evidenceStaging` row once the object is cleaned up or a `cleanup_evidence` job is queued. Transaction test asserts no staging row remains. |
| G9 | Telemetry job output reports `duplicateNeighbourWindow` and `duplicateLinkCap`. |
| G10 | `LIVENESS_CHALLENGE_SEQUENCE_INVALID` added to the user-safe codes with widget and dashboard copy. |
| G11 | `audit/liveness/reproduce.cjs` and `concurrency.cjs` rewritten as desired-behaviour regressions (exit non-zero on regression); results JSON regenerated. |
| G12 | README documents the vanilla SDK's hosted-iframe dependency. |

Not changed: L31/L33 validation work (dataset, devices), and the `attemptId` grace mode (kept strict).
