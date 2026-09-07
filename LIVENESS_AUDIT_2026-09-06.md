Run a # Liveness feature audit — 6 September 2026

## Executive assessment

The implementation has useful layered checks, but it is **not ready to claim that an approved session reliably proves the intended active-liveness policy was satisfied**. Several missing-signal paths permit approval, some stronger checks are record-only by default, and result persistence is not atomic with the session decision.

This review identifies **35 findings**: 18 findings covered by diagnostic reproductions, 12 additional source-level findings, and 5 engineering/validation improvements or conditional risks. Severity reflects potential impact, not a measured real-world exploit success rate. The first remediation batch should address L01–L07 and L09–L16.

**No audit can guarantee discovering 100% of faults.** This report covers the inspected code paths and executable cases below. It does not certify biometric accuracy, resistance to every presentation attack, production configuration, or behavior across every browser/device. Those require the release validation matrix at the end.

Application behavior was not changed during this audit. Reproductions use synthetic buffers/provider outputs and an isolated in-memory database; they do not access real customers or run an attack against the running application.

## Evidence and scope

Artifacts:

- [Diagnostic reproductions](audit/liveness/reproduce.cjs)
- [Recorded reproduction results](audit/liveness/reproduction-results.json)
- [Concurrency and HTTP fault reproductions](audit/liveness/concurrency.cjs)
- [Recorded concurrency results](audit/liveness/concurrency-results.json)

Run from the repository root:

```sh
node audit/liveness/reproduce.cjs
node audit/liveness/concurrency.cjs
npm test
```

The diagnostic script contains assertions that intentionally demonstrate **current undesirable behavior**. It is not a suite of desired-behavior regression tests; after fixes, those assertions should fail and be replaced with assertions of the corrected behavior. Nineteen successful proof blocks cover L01–L17 and L19, with some blocks covering multiple findings. The concurrency script uses temporary local HTTP sockets, fake storage/queue/database dependencies, and generated non-biometric JPEGs.

| Layer | Inspected paths | Evidence level |
| --- | --- | --- |
| React capture | VerificationWidget, faceDetector, actionSignals, landmarks, flash helpers and model cache | Source inspection; selected pure functions exercised; no browser execution |
| Vanilla SDK | global.js and core client calls | Source inspection and capture-mode reproduction |
| API | captures, uploadService, sessionService, SDK auth, evidence storage, CORS | Source inspection and existing regression suite |
| Challenge | Generation, freshness, pose, expression, trajectory, sequence, consistency, rigidity, binding | Source inspection and diagnostic reproductions |
| Worker | Frame selection, provider capabilities, identity, aggregation, flash, finalization, watchdog | Source inspection and injected-provider pipeline reproductions |
| Decisions | Missing/non-finite scores and liveness/identity/flash gates | Direct and pipeline reproductions |
| Operations | Model fetch/cache, generated Prisma client drift, version identifiers, telemetry job | Source inspection; historical local failures distinguished from unresolved findings |

Confidence labels used below:

- **Reproduced:** executable case ran successfully in the supplied diagnostic script.
- **Source-confirmed:** code behavior or missing guard is directly visible; the full operational/browser scenario has not been executed.
- **Conditional risk / improvement:** requires deployment measurements, environmental testing, or a product policy decision.

## System flow and trust boundaries

1. Server creates a session with actions, nonce and issue time.
2. Browser loads actions/models, records consent and guides capture.
3. API verifies the session credential, sanitizes/encrypts images, records action/mode and generates a frame-binding HMAC.
4. Client submits; API changes status and enqueues verification.
5. Worker decrypts evidence, runs the provider and derives challenge, identity, passive, flash and risk signals.
6. Decision engine chooses an outcome; finalizer updates the session, writes the result/audit and dispatches a webhook.
7. SDK polls; users can retry or request another movement.

The browser is not a trusted source of capture origin, timestamps, `captureMode`, camera labels or emitted flash colors. A server-generated HMAC protects stored metadata against certain substitutions; it does **not** prove the uploaded pixels came from a live camera or were captured after issuance. Provider outputs also require validation: exceptions and missing/non-finite values are not affirmative biometric evidence.

## Priority overview

| IDs | Priority | Issue |
| --- | --- | --- |
| L01, L07 | P0 | Expression actions may pass without evidence; client exclusions can remove all head movements |
| L02–L04 | P0 | Default direction/sequence gaps, insufficient frame count, and disjoint pose/liveness evidence |
| L05–L06 | P0 | Invalid/missing scores can permit approval; identity outages are ignored |
| L09, L12 | P0 when flash is relied upon | Synthetic/self-described flash; enforced flash can be absent |
| L10 | P1 | Vanilla manual capture reported as automatic |
| L11 | P0 | Challenge median can replace a strongly failing selfie score |
| L13 | P0 | Session can be approved without a persisted result |
| L14–L16 | P1 | Non-atomic submission, attempt races, and missing attempt fencing |
| L08, L17–L19 | P1/P2 | Time validation, weak binding scope, upload/storage races |
| L20–L27 | P1/P2 | Consent, challenge-load, reissue, burst, async and SDK compatibility problems |
| L28–L30 | P1/P2 | Model-cache drift, misleading version/status reporting, quadratic telemetry |
| L31–L35 | Improvement / conditional | Model validation, performance, accessibility, deployment and calibration coverage |

P0 means resolve before depending on the affected path for automatic liveness approval. It does not mean this audit demonstrated a successful physical spoof against the actual ONNX model.

## Reproduced findings

### L01 — Missing expression evidence passes an enforced challenge

**P0 · Reproduced.** [livenessChallenge.js:291](backend/shared/src/livenessChallenge.js#L291), [livenessChallenge.js:520](backend/shared/src/livenessChallenge.js#L520), [faceplugin.js:105](backend/src/worker/providers/faceplugin.js#L105).

`assessExpression()` returns null without landmarks, or `{ok:null}` for a single usable expression frame. The caller rejects only `expression.ok === false`. Expression actions are also exempt from the missing head-pose rule. The reproduction supplies one blink-labeled face without expression data; `enforcePose:true` still returns `ok:true`.

The Faceplugin adapter has no `faceLandmarks()` method, whereas the generator can issue blink/open_mouth. This makes the gap a provider-capability mismatch as well as malformed/missing evidence handling.

**Required:** choose challenges from verified provider capabilities. For a required expression, insufficient observations must cause recapture/review, not success. Require a measured temporal expression transition. Test no landmarks, one sample, malformed landmarks, provider exceptions and both provider types.

### L02 — Same-direction and unordered actions are not blocked by default

**P0 · Reproduced for direction; source-confirmed for default sequence policy.** [pipeline.js:276](backend/src/worker/pipeline.js#L276), [livenessChallenge.js:134](backend/shared/src/livenessChallenge.js#L134).

Magnitude checks accept either sign unless strict direction is enabled. Consistency and sequence enforcement default to false unless environment/tenant flags enable them. Two frames with the same positive yaw labeled left/right return a successful challenge even though the recorded consistency result is false.

**Required:** publish an explicit production policy distinguishing enforced and diagnostic checks. Calibrate mirror/sign conventions, then require the appropriate independent consistency and sequence checks. Missing observations should not silently disable required checks. Test the actual deployed flag combinations, not just explicit test options.

### L03 — One or two still frames avoid trajectory and rigidity checks

**P0 · Reproduced.** [livenessChallenge.js:193](backend/shared/src/livenessChallenge.js#L193), [livenessChallenge.js:550](backend/shared/src/livenessChallenge.js#L550), [livenessChallenge.js:406](backend/shared/src/livenessChallenge.js#L406).

Face presence requires only one candidate. Trajectory and rigidity return null with insufficient samples; null does not set an adverse decision signal. The two-action reproduction supplies one static observation per action and produces `motionUnverified:false`.

**Required:** enforce minimum useful, distinct observations for each requested action and require enough temporal coverage to judge it. Distinguish “insufficient evidence” from “no anomaly.” Define an accessible recapture/review path rather than forcing unsuitable movements. Test sparse frames and duplicate frames within an action.

### L04 — A live frontal frame can vouch for a spoof-like turned frame

**P0 · Reproduced.** [livenessChallenge.js:224](backend/shared/src/livenessChallenge.js#L224), [livenessChallenge.js:234](backend/shared/src/livenessChallenge.js#L234).

The maximum passive score is taken from all faced candidates, while pose success is independently taken from any faced candidate. The reproduction uses a frontal frame scoring .95 and a turned frame scoring 0; the action passes although neither observation satisfies both constraints.

**Required:** require qualifying action evidence to pass its own applicable spoof floor and identity checks. Derive pose/trajectory from eligible observations rather than allowing unrelated evidence to satisfy separate halves of the rule. Test adversarial mixtures as well as genuine low-score profile frames.

### L05 — Non-finite scores are treated as numeric evidence

**P0 at decision boundary · Reproduced.** [decisionEngine.js:116](backend/shared/src/decisionEngine.js#L116), [livenessChallenge.js:224](backend/shared/src/livenessChallenge.js#L224).

`typeof NaN === "number"`, while both threshold comparisons are false. `decide({selfie:{faceCount:1}, liveness:{score:NaN}})` approves. Infinity and out-of-range values also lack systematic validation. This is not a claim that JSON can transmit literal NaN; an in-process model/math pipeline can produce it.

**Required:** validate finite/ranged scores, face counts, poses, embeddings and landmarks at provider boundaries and again before final decisions. Invalid inference should produce an explicit unavailable/error state with operational diagnostics. Test NaN, ±Infinity, undefined, strings, empty outputs and out-of-range numbers.

### L06 — Identity-comparison failure can permit approval

**P0 · Reproduced in the production-mode pipeline.** [pipeline.js:210](backend/src/worker/pipeline.js#L210), [pipeline.js:237](backend/src/worker/pipeline.js#L237), [decisionEngine.js:62](backend/shared/src/decisionEngine.js#L62).

Exceptions become `{score:null,error:...}`. The decision engine checks identity only when its score is numeric. In the embedding path, a truthy error object also prevents the fallback comparison branch. Injecting a comparison failure still produces an approved session.

**Required:** for a face challenge, identity continuity must explicitly report verified, mismatched or unavailable. Unavailable cannot count as verified. Require adequate coverage per action; document the difference between the ONNX multi-frame path and the Faceplugin single-frame fallback. Test thrown errors, null embeddings and all frames outside the usable pose range.

### L07 — Challenge exclusions can remove every head movement

**P0 in combination with L01 · Reproduced.** [sessionService.js:218](backend/src/services/sessionService.js#L218), [livenessChallenge.js:50](backend/shared/src/livenessChallenge.js#L50).

The API accepts up to four arbitrary string exclusions. Excluding left/right/up/down yields only blink and open_mouth. These can pass without expression evidence under L01. The server does not restrict exclusions to the displayed movement or enforce an equivalent assurance policy.

**Required:** use a bounded, server-controlled accessibility alternative with explicit assurance requirements. Validate exclusions against the actual challenge and capabilities. If equivalent evidence is unavailable, route to assisted/manual verification. Do not silently weaken the policy merely because the caller requested it.

### L08 — Future issue timestamps are accepted

**P2 · Reproduced.** [livenessChallenge.js:75](backend/shared/src/livenessChallenge.js#L75).

Freshness checks only `now - issuedAt <= ttl`; a challenge issued a day in the future passes. Issuance is server-controlled, so this is primarily clock-skew/corrupt-state robustness, not a normal client-supplied timestamp exploit.

**Required:** validate an allowed bounded future skew and a maximum age. Test invalid timestamps, backward clock shifts, future timestamps and expiry boundaries.

### L09 — Flash scoring accepts synthetic color responses without face evidence

**P0 if treated as independent anti-replay proof · Scorer behavior reproduced; integration limitations source-confirmed.** [livenessFlash.js:78](backend/shared/src/livenessFlash.js#L78), [VerificationWidget.jsx:224](frontend/sdk/react/src/VerificationWidget.jsx#L224), [pipeline.js:322](backend/src/worker/pipeline.js#L322).

The client chooses and reports the sequence; the server scores tile color means. Synthetic uniform-color means matching a palette score as a valid response. The worker does not establish that the tiles contain the same face, nor that the emitted sequence was server-issued or observed live. Browser randomness is also `Math.random()`.

**Required:** issue the illumination challenge server-side, bind its sequence and timing to the session, validate face/identity and tile geometry, and treat a submitted mosaic as untrusted image evidence. A server-issued sequence alone still does not defeat an adaptive image generator. Validate actual attack resistance before claiming flash proves liveness.

### L10 — Vanilla SDK manual captures are labeled automatic

**P1 · Reproduced default; call site source-confirmed.** [global.js:145](frontend/sdk/js/src/global.js#L145), [client.js:128](frontend/sdk/core/src/client.js#L128).

The vanilla button calls the two-argument `uploadLivenessFrame(action, image)` method. Its default mode is `auto`, so a manual single-frame capture does not trigger the intended `LIVENESS_MANUAL_CAPTURE` signal. The reproduction verifies the outgoing body.

**Required:** explicitly pass `manual` for that UI, bring the vanilla implementation into parity, and avoid treating any client-asserted mode as a security guarantee. Test all SDK callers and unknown/omitted modes.

### L11 — Multi-frame aggregation can override a failing selfie

**P0 · Reproduced in the production-mode pipeline.** [pipeline.js:261](backend/src/worker/pipeline.js#L261), [pipeline.js:270](backend/src/worker/pipeline.js#L270), [pipeline.js:347](backend/src/worker/pipeline.js#L347).

The decision replaces the selfie score with the sorted upper-middle value of the selfie plus up to three challenge scores. A .01 selfie and three .95 challenge observations produce approval in the reproduction. Thus the comments describing a strict selfie gate are not reflected in the decision path. For an even sample count, the computation is an upper median rather than the average of the middle pair.

**Required:** explicitly choose and calibrate the aggregation policy. Preserve any mandatory selfie rejection gate, and prevent selectively high action frames from washing out disqualifying evidence. Record the actual decision score separately from the raw selfie score. Test strong/weak mixtures, not just uniformly good or bad providers.

### L12 — “Enforced” flash can be bypassed by omission or processing error

**P0 for deployments relying on flash enforcement · Reproduced omission.** [pipeline.js:322](backend/src/worker/pipeline.js#L322), [pipeline.js:339](backend/src/worker/pipeline.js#L339), [decisionEngine.js:98](backend/shared/src/decisionEngine.js#L98).

No mosaic means no flash signal. A decoding/scoring exception creates `enforced:false`. The decision only reviews a present flash result whose enforcement flag is true and whose result is false. A production-mode test with tenant `enforceFlash:true` and no mosaic approves.

**Required:** derive whether flash is required independently of successful scoring. Define outcomes for absent, malformed, stale, unreadable and inconclusive data. Preserve the configured requirement on errors. The UI's best-effort omission must agree with the server's required-versus-optional policy.

### L13 — Finalization can leave an approved session without a result

**P0 · Reproduced with an injected database failure.** [pipeline.js:441](backend/src/worker/pipeline.js#L441).

The compare-and-set writes the terminal session status first, then creates result, audit and webhook work. If result creation fails, the session is already approved. Retrying the pipeline skips it because it is no longer submitted. The diagnostic reproduces exactly this state. Later audit/dispatch failures can similarly leave incomplete side effects.

**Required:** transactionally persist decision/result plus a durable outbox, or use a recoverable finalization state with idempotent writes. Test crashes after every individual write, duplicate delivery, and recovery that produces exactly one durable outcome and eventually sends the event.

## Additional source-level findings

### L14 — Submission and enqueue are separate, non-idempotent writes

**P1 · Queue-failure case reproduced; concurrent/idempotency cases source-confirmed.** [captures.js:66](backend/src/routes/captures.js#L66).

`/verify` reads started, updates submitted, then enqueues. An enqueue error leaves submitted without its job; concurrent requests can both pass the initial status check. A lost success response makes a retry return a validation error instead of the accepted operation. The watchdog only provides delayed partial recovery. An injected queue outage returned HTTP 500 with the session left submitted and no job.

**Required:** atomic claim plus transactional outbox/idempotency key, and an idempotent submitted response. Verify duplicate POSTs and crash points between status change and enqueue.

### L15 — Retry/reissue limits depend on best-effort audit rows

**P1 · Reproduced.** [sessionService.js:205](backend/src/services/sessionService.js#L205), [sessionService.js:245](backend/src/services/sessionService.js#L245), [auditLogger.js:10](backend/src/services/auditLogger.js#L10).

Counts are read, session changes happen, then the audit is written. Audit errors are deliberately swallowed. Failed auditing can fail to consume a limit; concurrent requests can reuse the same count or overwrite challenges. Multiple replies can contain different challenges from the one finally stored. Seven retries succeeded with failed audit writes, each reporting attempt 2. Three synchronized reissues also succeeded despite the configured limit of two, each reporting reissue 1.

**Required:** durable atomic attempt/reissue counters and compare-and-set transitions, with audit as an output rather than the enforcement store. Test parallel retries/reissues and audit database outages.

### L16 — Worker claims are not fenced to a specific attempt

**P1 · Reproduced with a simulated overlapping-attempt transition and Prisma-like snapshot reads.** [pipeline.js:36](backend/src/worker/pipeline.js#L36), [pipeline.js:447](backend/src/worker/pipeline.js#L447), [sessionService.js:275](backend/src/services/sessionService.js#L275).

Jobs identify the session, and finalization compares only its status. An old worker may read attempt A, another worker finalizes it, the user retries/submits attempt B, and the old worker then sees the status submitted again and claims B using A's computed evidence. This is a status “ABA” race. The reproduction approved newly submitted attempt B using the earlier worker’s evidence, with no B evidence in the fixture.

**Required:** immutable attempt ID/version in job payload, evidence, results and status CAS. Test a delayed worker completing across a retry and a stale-lock reclaim.

### L17 — Freshness uses worker execution time, not accepted capture/submission time

**P1 · Expired submission reproduced; queue-delay expiry source-confirmed.** [livenessChallenge.js:169](backend/shared/src/livenessChallenge.js#L169), [pipeline.js:300](backend/src/worker/pipeline.js#L300), [captures.js:66](backend/src/routes/captures.js#L66).

A user can capture within ten minutes but wait in the queue until the worker rejects the challenge as expired. Conversely, `/verify` does not check session expiry before submission; upload checks alone do not prevent delayed submission after the last capture. The 30-minute session and 10-minute challenge clocks are not surfaced together to the user. An HTTP test confirmed that a started session expired one minute earlier was accepted with 202.

**Required:** validate deadlines at upload and submit, store submission time, and judge accepted capture freshness independently of queue latency. Include backlog and boundary cases in tests.

### L18 — Frame binding is narrower than the stated integrity guarantee

**P1/P2, depending on threat model · Source-confirmed.** [uploadService.js:249](backend/src/services/uploadService.js#L249), [pipeline.js:60](backend/src/worker/pipeline.js#L60), [pipeline.js:324](backend/src/worker/pipeline.js#L324).

The HMAC covers stored nonce/action/checksum. The worker decrypts bytes but does not recompute their checksum against that metadata. AES-GCM detects modifications to ciphertext, but a valid whole ciphertext substituted at a different path is a distinct case. Flash evidence follows a separate path that accepts absent nonce and does not verify the frame HMAC; its color metadata is not covered by the binding.

**Required:** recompute plaintext digest, bind canonical session/attempt/type/action and relevant metadata, and apply a consistent evidence validator to flash. Test whole valid-file swaps separately from corrupt ciphertext. This is principally a storage/metadata integrity concern, not a claim that ordinary SDK clients can edit evidence database rows.

### L19 — Upload quotas/state checks race and failed persistence leaves orphan evidence

**P1 · Concurrent quota and orphan-write cases reproduced; late-submit/reissue ordering source-confirmed.** [uploadService.js:180](backend/src/services/uploadService.js#L180), [uploadService.js:220](backend/src/services/uploadService.js#L220).

The API counts evidence, saves a file/mirror, then creates the database row. Parallel requests can all see budget remaining. A concurrent submit/reissue can occur after the upload reads the session; the worker may run before late evidence is recorded. A database rejection after file persistence leaves storage without the intended record—the stale Prisma-client failure is an example of why this matters. Three simultaneous uploads were accepted with a per-action maximum of two. A separate injected evidence-row failure happened after the fake storage write completed, without compensation.

**Required:** reserve upload slots atomically per attempt, serialize the capture/submission boundary and compensate or garbage-collect failed evidence writes. Add concurrent budget tests and injected failures after each storage operation.

### L20 — Consent confirmation is fire-and-forget

**P1 · Source-confirmed; no browser reproduction.** [VerificationWidget.jsx:1274](frontend/sdk/react/src/VerificationWidget.jsx#L1274).

The UI sets `consented` true immediately and ignores a failed consent request. Camera use begins while the API may have no consent record; production uploads then reject. Clicking before the client exists can skip the request entirely.

**Required:** await successful consent persistence before moving on, show retryable errors and avoid duplicate submissions. Test slow/offline consent and early clicks. This is a workflow finding, not a legal compliance assessment.

### L21 — Challenge fetch failure starts an incorrect fallback flow

**P1 · Source-confirmed.** [VerificationWidget.jsx:333](frontend/sdk/react/src/VerificationWidget.jsx#L333), [global.js:168](frontend/sdk/js/src/global.js#L168).

Errors call `onError` but initialization continues with ID_AND_FACE and empty actions. The SDK can ask a FACE_ONLY user for an ID, skip liveness instructions and eventually submit incomplete evidence. Correct server challenge validation may still reject it; this is a broken client journey, not proof of server acceptance.

**Required:** block initialization until the authenticated challenge is loaded, with retry/expired-session handling. Test CORS failures, timeouts, auth rejection and malformed successful responses.

### L22 — Reissue on the first action can retain the previous detector loop

**P1 · Source-confirmed dependency defect; browser test required.** [VerificationWidget.jsx:437](frontend/sdk/react/src/VerificationWidget.jsx#L437), [VerificationWidget.jsx:787](frontend/sdk/react/src/VerificationWidget.jsx#L787), [VerificationWidget.jsx:1231](frontend/sdk/react/src/VerificationWidget.jsx#L1231).

Reissue changes the actions array and sets actionIdx to zero. The auto-capture effect depends on actionIdx/step/model/camera state, not challenge identity/actions. If already at index zero, those dependencies need not change. Its captured `currentAction` can remain old while the UI and upload callback use new actions.

**Required:** key the effect/state machine by challenge nonce/version; reset detector, phase, sample/reference state and budgets together. Test first-action reissue, later-action reissue and reissue while an inference is finishing.

### L23 — Burst bookkeeping advances before capture/upload success

**P1 · Source-confirmed.** [VerificationWidget.jsx:510](frontend/sdk/react/src/VerificationWidget.jsx#L510), [VerificationWidget.jsx:1099](frontend/sdk/react/src/VerificationWidget.jsx#L1099).

`shots++` and `earlyShotTaken=true` happen before the asynchronous capture has succeeded. Quality failure returns without a successful frame; the controller can later advance based on attempted shots or finish a short burst. Server validation may reject incomplete evidence, but the user sees progress inconsistent with actual uploads.

**Required:** return explicit captured/uploaded/retryable outcomes and count only successful uploads. Advance only after the required evidence is acknowledged. Test brightness rejection, upload failure, lost response and pose loss on each burst shot.

### L24 — POST requests have no deadline or cancellation

**P1 · Source-confirmed.** [client.js:72](frontend/sdk/core/src/client.js#L72), [VerificationWidget.jsx:564](frontend/sdk/react/src/VerificationWidget.jsx#L564).

GET requests get a timeout, but `_post()` does not. A hanging upload, consent, submit or flash request can keep busy/capturing state latched. Component unmount/session changes do not cancel the outstanding submission/result work, and old callbacks can complete after the context has changed.

**Required:** bounded per-operation deadlines, AbortController lifecycle cancellation and attempt/session guards before state changes. Use idempotency before automatically retrying non-idempotent POSTs. Test dropped responses and route changes during capture.

### L25 — Pose reference sampling counts the same detection repeatedly

**P2 · Source-confirmed.** [VerificationWidget.jsx:979](frontend/sdk/react/src/VerificationWidget.jsx#L979).

The array stores newly constructed `{yaw,pitch}` objects but compares its last element by identity to `alignPose`. Those objects differ even when the detection is unchanged. Several animation frames can count one inference as multiple samples and overwrite the rolling reference with copies.

**Required:** collect samples once per inference/frame timestamp, not once per animation frame. Test low inference rate with high display refresh and require distinct observations before accepting reference confidence.

### L26 — Session prop changes retain consent/other session-scoped UI state

**P1/P2 · Source-confirmed; integration-dependent.** [VerificationWidget.jsx:296](frontend/sdk/react/src/VerificationWidget.jsx#L296), [VerificationWidget.jsx:333](frontend/sdk/react/src/VerificationWidget.jsx#L333).

The client/flow effect rebuilds on sessionId/sdkToken changes, but consent state is initialized only at mount and is not reset there. An integrator reusing the mounted widget can carry previous consent state into a new session; production captures fail because the new session lacks its consent record. Other async state must also be reviewed as one session-scoped unit.

**Required:** explicitly reset all session-scoped state or require/key a remount and document that contract. Test swapping sessions without unmount, including pending capture/result work.

### L27 — Vanilla SDK is not functionally equivalent to the React flow

**P1 · Source-confirmed.** [global.js:120](frontend/sdk/js/src/global.js#L120), [global.js:168](frontend/sdk/js/src/global.js#L168).

No consent persistence call appears in the vanilla entrypoint, making consent-enforced uploads fail. It captures single frames per action and lacks the React expression/burst/flash flow. Its document branch advances ID_ONLY into processing without submitting; two-sided document selection is not incorporated into `createFlow` initialization. These are important when onboarding offers both SDKs as alternatives.

**Required:** implement a capability matrix and either bring vanilla into supported parity or narrow its documented availability. Add real integration tests for FACE_ONLY, ID_ONLY, ID_AND_FACE, two-sided ID, enforced consent, expressions and retries.

### L28 — Model cache/fetch can retain invalid or stale binaries

**P2 · Source-confirmed.** [modelCache.js:16](frontend/sdk/core/src/modelCache.js#L16), [faceDetector.js:18](frontend/sdk/react/src/faceDetector.js#L18), [fetch-models.js:13](backend/scripts/fetch-models.js#L13).

Cache hits use a fixed cache name and URL without model digest/version validation. A successful HTTP response containing a dev HTML fallback can be cached before ONNX validation. The loader does not evict it when session creation fails. Server downloads use mutable main-branch URLs and treat any nonempty file as already valid; interrupted downloads can persist partial files.

**Required:** pin model revision/digests, download to temporary files and atomically rename after validation, use versioned browser cache keys and evict invalid assets. Reset rejected runtime-load promises where retry is intended. Test partial files, HTML 200 responses, corruption and model upgrades at unchanged URLs.

### L29 — Version/score/status reporting can misrepresent the actual decision

**P1/P2 · Source-confirmed; score inconsistency reproduced in L11.** [pipeline.js:13](backend/src/worker/pipeline.js#L13), [pipeline.js:385](backend/src/worker/pipeline.js#L385).

The pipeline version still names a July revision despite the later challenge changes. Persisted `livenessScore` is the selfie score, while the decision uses a different aggregate. `livenessStatus` only considers passive failure/borderline reason codes, so active-challenge rejection can coexist with “passed.” This can mislead operators investigating contradictory outcomes.

**Required:** store raw selfie, aggregate decision score, active-challenge status and overall outcome separately. Use build commit plus model digests and a policy version. Test consistency of SDK, dashboard, result API and webhook representations.

### L30 — Telemetry duplicate analysis remains quadratic in the worst case

**P2 · Source-confirmed complexity.** [telemetryAnomaly.js:139](backend/src/worker/telemetryAnomaly.js#L139), [telemetryAnomaly.js:188](backend/src/worker/telemetryAnomaly.js#L188).

Sorting does not prevent O(n²) comparisons when many timing vectors have the same first value—the exact uniform/bot-like case the job looks for. Peer arrays accumulate before being sliced. The runner reads all recent sessions without a page bound. Sessions with no result also have no persisted prior flags to make subsequent audit-only runs idempotent.

**Required:** bounded per-tenant batches, compact duplicate groups/streaming comparison limits, early peer caps and durable idempotency independent of a result row. Benchmark identical vectors and large time windows.

## Conditional risks and required improvements

### L31 — Insufficient evidence for model accuracy and threshold generalization

**High validation priority · Not established by unit tests.** Browser proxies, backend pose degrees, passive scores and identity bands come from different computations. Comments cite a limited set of tester recordings; that does not establish generalization. Rigidity's max residual can be dominated by a landmark outlier; blink uses extrema rather than an ordered open–closed–open sequence. These are calibration/design risks, not measured failure rates from this audit.

**Required:** held-out consented genuine/attack datasets, per-device/provider distributions, confidence intervals for observed errors, outlier-resistant temporal checks and explicit accessibility review. Never interpret “all tests pass” as biometric accuracy certification.

### L32 — Inference latency and worker lease assumptions need measurement

**P1 conditional performance risk.** [pipeline.js:193](backend/src/worker/pipeline.js#L193), [onnx.js:215](backend/src/worker/providers/onnx.js#L215), [watchdog.js:16](backend/src/worker/watchdog.js#L16).

The worker sequentially scores all challenge frames; ONNX landmarks and embeddings repeat face detection/preprocessing. A per-call timeout is not a per-job bound. The five-minute stale-lock assumption can fail when many calls are slow, causing duplicate work, and the SDK's five-minute wait can end before queue recovery.

**Required:** measure full-job latency at maximum evidence counts, cache per-frame inference outputs, apply a total deadline, renew leases and align UI waiting with queue state. Benchmark CPU/memory and duplicate-worker behavior; do not add unbounded parallel inference.

### L33 — Browser lifecycle, flashing and accessibility need device testing

**High UX validation priority.** [VerificationWidget.jsx:224](frontend/sdk/react/src/VerificationWidget.jsx#L224), [VerificationWidget.jsx:670](frontend/sdk/react/src/VerificationWidget.jsx#L670).

Fixed flash delays do not guarantee the next camera frame represents the displayed color, especially under background throttling or auto-exposure. The model-loading Promise.race can time out before a session eventually loads, leaving the late detector undisposed. Full-screen colors, blink/neck/mouth movements and small/slow-device capture all need accessible alternatives and real-device validation.

**Required:** frame-aware capture timing, cancellation/disposal of late loads, clear interruption recovery, user-visible flash explanation and accessible assisted paths. Test screen readers, keyboard use, permission denial, orientation changes, background/resume and users unable to perform particular actions. No medical safety claim is made here.

### L34 — Deployment consistency is not checked before accepting captures

**High operational priority · Previous incidents locally addressed, recurrence risk remains.** The reported CORS header omission was corrected and covered by a regression test. The stale Prisma client was regenerated locally. Those are not counted again as unresolved defects. Neither repair alone guarantees all deployed API/worker processes use the same schema, generated client, SDK and models.

**Required:** build-time Prisma generation/schema checks, release identity in health/status, a real multipart-layer integration smoke test using generated Prisma plus actual image sanitization, and deployment validation of SDK CORS headers. Run both API and worker on the same compatible release. Never use a real user's biometric upload as the deployment smoke test.

### L35 — Advisory signals and record-only checks need honest policy/UI treatment

**Policy/security improvement.** [captureIntegrity.js:18](frontend/sdk/core/src/captureIntegrity.js#L18), [pipeline.js:276](backend/src/worker/pipeline.js#L276).

Camera labels, capture mode and timing telemetry can be forged or omitted. Scanning installed virtual cameras can also flag a legitimate physical-camera session. Texture is diagnostic only; consistency/sequence/flash enforcement depends on flags. A visible check or recorded metric does not imply it affected the decision.

**Required:** document enforced, advisory, unavailable and disabled signals in tenant policy and reviewer UI. Use required server evidence for assurance and advisory signals for appropriately calibrated review. Log policy changes; do not enable every heuristic globally without measuring genuine-user impact.

## Recommended remediation sequence

1. **Close missing-evidence approval paths:** L01–L07, L11–L12. Add desired-behavior regression tests that explicitly reject/review missing, malformed and contradictory evidence. Restrict unsupported expressions until provider capability checks exist.
2. **Make attempts and decisions durable:** L13–L19. Introduce attempt IDs, atomic quota/state transitions, idempotent submission, transactional result/outbox writes and failure recovery.
3. **Align client workflow with server evidence:** L10, L20–L27. Await consent/challenge loading, fix challenge reissue lifecycle and successful-frame accounting, cancel old work, and bring supported SDKs into parity.
4. **Make releases diagnosable and repeatable:** L28–L30, L34. Pin models, validate binaries/generated clients, identify releases and expose accurate decision fields.
5. **Measure actual assurance and usability:** L31–L33, L35. Calibrate on held-out data and real devices before promoting optional heuristics to blocking policy.

For each fix, convert the corresponding diagnostic reproduction into a desired-behavior regression. Keep one issue per independently reviewable change where possible, while fixing coupled policy gaps together.

## Release validation matrix needed to extend this audit

| Dimension | Required cases | Acceptance evidence |
| --- | --- | --- |
| Provider capability | ONNX, Faceplugin, no pose, no landmarks, no embeddings, malformed tensor/response | Required missing signal cannot silently approve; unsupported challenges never issued |
| Evidence | Zero/one/two/full frames, duplicate within/across actions, mixed faces, mixed live/spoof scores, out-of-order, corrupt encrypted file | Validated observation counts, continuity and explicit error outcomes |
| Replay/injection | Consented print/screen/video tests, repeated frames with minor changes, synthetic flash tiles, altered client metadata | Measured outcomes; no claim based solely on metadata or HMAC |
| Attempts | Parallel upload/submit/retry/reissue, old worker vs new attempt, refresh midway | Exactly one current attempt; no cross-attempt result writes |
| Fault injection | Database/storage/queue failure after every write, lost responses, worker kill, lease expiry | Durable recovery, no approved-without-result state, bounded duplicate work |
| Time/network | Slow mobile network, offline, hung POST, worker backlog beyond challenge TTL, clock skew | Clear retry/deadline behavior; queue delay does not invalidate timely captures |
| Browser/device | Safari/iOS, Chrome/Android, desktop browsers; low-end CPU, mirrored feeds, exposure lag, orientation/background | Recorded end-to-end completion, latency and recovery evidence |
| UX/accessibility | Cannot turn/blink/open mouth, consent failure, denied camera, screen reader, keyboard, assisted alternative | Equivalent documented assurance or explicit manual path |
| Configuration | Every supported verification type and enforcement flag combination; missing models; stale Prisma | Capability-aware flow, valid API/worker compatibility and no silent policy downgrade |
| Performance | Max upload quota, large image sizes, parallel sessions, identical telemetry vectors | Bounded memory/runtime, monitored queue and no accidental stale-job duplication |
| Calibration | Diverse consented genuine samples and representative attacks; train/calibration/held-out separation | Error rates and uncertainty reported per relevant cohort/provider/device; no unsupported universal claims |

## Verification performed and limits

- Existing repository regression suite: **432 passed, 0 failed, 0 skipped** (backend 240; shared 87; SDK core 103; dashboard client 2).
- Diagnostic reproductions: **19 proof blocks passed**, covering L01–L17 and L19. Pipeline cases use production-mode binding checks, real encryption and synthetic provider responses; the session itself is a test session.
- No source fixes were applied by this audit. Existing user changes were preserved.
- No live database fault injection, physical presentation-attack trial, real ONNX accuracy evaluation, browser visual run or external webhook test was performed.
- A browser connection was unavailable in the preceding UI work; this audit did not claim new browser execution.
- Pure/code-level proofs establish logic faults. They do not establish that a particular photograph will obtain a specific score from the deployed model.

The passing existing suite demonstrates that these gaps are not currently captured by its expectations. It does not contradict the diagnostic failures of the intended policy. The unresolved findings and unexecuted matrix prevent a claim of complete fault coverage or production liveness assurance.
