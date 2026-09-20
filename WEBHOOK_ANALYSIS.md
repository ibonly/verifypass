# Codebase analysis and webhook repair

## Confirmed local incident: dashboard and demo API keys use different tenants

A subsequent read-only inspection of the local database confirmed the reported
failure. The `webhook.test` delivery `evt_5f3765f9180be30e88320639` succeeded on
its first attempt with HTTP 200. However, the latest actual verification events
belonged to `tnt_1K2AMODQDYZ8QV5RV7ESP`, which had no webhook configuration.
The configured endpoint and the `admin@demo.local` account belonged to
`tnt_1K1DGQ9UPXV7WD9JWBMZ7`..

The root cause was `scripts/setup-inhouse.js`: it could create/reuse credentials
for a new tenant while accepting existing demo users solely by email, without
checking their tenant. Thus the printed demo login and demo API keys could refer
to different workspaces. Queue jobs were marked done because the dispatcher
correctly skipped tenants without webhook configuration.

The setup script now treats the existing demo admin's workspace as canonical,
validates both cached API keys against that workspace, and replaces mismatched
cached credentials when setup runs. It checks user tenant, role and active status;
it never silently moves users or copies webhook configuration between tenants.
The Webhooks page now displays its workspace name and tenant ID explicitly.
Regression tests cover fresh setup, missing credentials, mismatched tenants,
mislabelled cached keys and conflicting reviewer accounts. The full repository
suite passes 553 tests after this follow-up; the dashboard production build
also passes.

Existing sessions stay in their original tenant. Correcting demo API credentials
only affects future sessions after the running app reloads those credentials.
Do not replay old verification payloads to a different tenant's endpoint.

## Initial investigation outcome and scope

The admin webhook save path correctly writes `Tenant.webhookUrl` and
`Tenant.webhookSecret`. It is not disconnected from the dispatcher. The code
contains several delivery and visibility defects that can explain a webhook
appearing not to fire. This change fixes those defects and adds a repeatable
admin-to-receiver diagnostic.

This is a source review and local regression/integration validation. Production
MongoDB records, Lambda logs, DNS, TLS, and the affected receiver were not
inspected. Consequently, the specific production incident cannot be attributed
to one of these defects without examining its delivery/job records.

## 1. How the application works

| Component | Responsibility and main entry points |
| --- | --- |
| API | Express in `backend/src/app.js`; mounts capture, session, auth, dashboard, onboarding, review, settings, reporting and webhook routes. |
| Tenant isolation | Secret/public API keys resolve the tenant for integrations. Dashboard JWTs resolve the user and role. `tenantScope.js` supplies scoped database methods. Super admins explicitly select a tenant with `X-Tenant-Id`; tenant admins cannot override their tenant with that header. |
| Persistence | Prisma with MongoDB. Tenants, sessions, attempts/evidence, results, audit logs, outbox records, jobs and webhook deliveries are separate records. Transactions require a replica set. |
| Capture clients | Hosted verification page, JavaScript/React SDKs and Flutter wrapper drive consent, challenge initiation, capture upload, submission and status polling. SDK tokens and attempt IDs bind mutations to the current session attempt. |
| Evidence | Upload services validate and sanitize captures, encrypt stored evidence, and record checksums/bindings. Storage abstracts local and remote evidence. Retention and reconciliation workers clean up expired/orphaned data. |
| Verification | `worker/pipeline.js` loads evidence, invokes providers, evaluates liveness/challenge/identity/document/risk signals and applies decision policy. It fences superseded attempts and atomically persists the result, session decision, audit entry and webhook outbox record. |
| Background execution | `jobService.js` dispatches to database jobs or SQS. `worker.js` polls locally/on a server. `worker.lambda.js` handles database drains, SQS batches and scheduled maintenance. The checked-in SAM configuration uses database jobs and a drain every minute. |
| Review and reporting | Dashboard users inspect sessions/evidence, make review decisions and view reports. Human approval also enqueues a webhook; rejection does not. |
| Email | Node email service invokes the separate PHP mailer for onboarding, security, review and delivery-exhaustion notifications. Email is separate from webhook transport. |

### Normal verification-to-webhook flow

1. Server creates a tenant-scoped session with a secret API key.
2. Client obtains consent, begins the challenge, uploads evidence and submits
   the current attempt.
3. Submission transaction changes the session to `submitted` and writes a
   `run_verification` outbox entry. The outbox publishes to the active queue.
4. Verification worker commits the outcome. Only an `approved` decision also
   creates a `send_webhook` outbox entry with a stable event ID and snapshot.
5. Dispatcher requires both tenant URL and secret, creates a delivery record,
   validates the target, signs the raw JSON and sends an HTTP POST.
6. Any 2xx response marks the delivery `delivered`; retryable failure records
   an error and schedules the next delivery attempt. Dashboard queries expose
   delivery status, attempt count, HTTP status and last error.

Saving configuration is not itself a verification event. Events already consumed
while the tenant had no webhook are skipped; adding a URL does not replay history.

## 2. Findings and implemented fixes

### A. No way to distinguish “saved” from “working”

**Before:** Admin save returned a new signing secret, but sent no request. Delivery
rows appeared only when a worker processed a verification event. An empty log
could mean no event, no worker, queue backlog, or missing configuration.

**Fix:** Added **Send test webhook** in the Webhooks screen and the authenticated
`POST /v1/onboarding/webhooks/test` endpoint. It emits a distinct `webhook.test`
event with no verification/evidence data. A delivery row and outbox dispatch
intent are persisted in one transaction, so the test is visible immediately and
survives a queue publish failure. The normal worker, signing and retry code sends
it. The response says `queued`, never claims successful delivery prematurely.
The UI retains the just-returned signing secret while a test is requested.

### B. Save-time and send-time URL rules disagreed

**Before:** Onboarding accepted HTTPS URLs on ports such as 8443, but the worker
allowed only port 443. The secret-key API additionally accepted HTTP outside
production, although the dispatcher always required HTTPS. Credentials and
fragments were also handled inconsistently.

**Fix:** Both configuration routes and the worker share `lib/webhookTarget.js`.
They require HTTPS, port 443, no credentials/fragment, and reject known private
literal addresses/localhost. DNS validation remains at delivery time and rejects
private resolved IPv4 addresses. Unsupported configurations now fail at save time.
IPv6-only endpoints remain unsupported, consistent with the previous dispatcher.

### C. Temporary DNS failures permanently stopped delivery

**Before:** DNS exceptions entered the same catch block as forbidden targets,
were recorded as `SSRF blocked`, and scheduled no retry. A temporary resolver
outage could therefore produce no HTTP request and no recovery.

**Fix:** Explicit target-policy violations carry `WEBHOOK_TARGET_BLOCKED` and
remain non-retryable. DNS failures enter the normal backoff path. DNS validation
has a five-second wait bound. Blocked deliveries clear stale next-attempt times.
Redirect following is disabled so the receiver must be the configured final URL.

### D. The database Lambda drain stopped before its webhook

**Before:** Default `maxJobs=1` allowed a verification to enqueue a webhook and
then immediately end the drain. The pipeline's database enqueue does not kick a
new invocation. A later scheduled invocation had to pick up the webhook, and
backlogs amplified the delay. This was a latency/backlog defect, not proof that
the queue could never eventually deliver.

**Fix:** Keep the default limit of one general job, then process up to ten
additional webhook jobs with a separate 60-second budget. Never start a second
verification in that phase. Check Lambda remaining time before each claim; allow
webhook-only work when there is too little time for another verification, and
stop with less than 25 seconds remaining. The separate budget permits delivery
after a long verification has used the original general-job start budget.
SQS routing and delayed-message handling are preserved.

### E. The last advertised retry was unreachable

**Before:** Five delay values existed, but exhaustion occurred at attempt five.
The 12-hour delay was never used.

**Fix:** Six total attempts: the initial send plus retries after 1 minute,
5 minutes, 30 minutes, 2 hours and 12 hours. These are delays after each failure,
not absolute times from the first request.

### Additional changes

- Delivery session lookup now includes the tenant ID.
- Secret-key configuration responses use `Cache-Control: no-store`.
- New deliveries use the five-field selfie payload documented below; existing deliveries retain their original retry contract.

## Detailed >60% delivery verification

Read-only inspection of the local database confirmed:

- Session `vps_1K2K8E5119HQ5MMKT8ED0`: liveness/selfie 99.6936%,
  backend approved, webhook delivered once, HTTP 200.
- Session `vps_1K2K8BUA5QXG559PWQ01V`: 99.1710%, manual review due to
  `LIVENESS_IDENTITY_UNAVAILABLE`, no webhook. A high score does not bypass
  identity checks.
- Session `vps_1K2K7SL5GPJ4YKR8YE9HY`: 35.7880%, backend approved and
  delivered HTTP 200. Existing policy allows a passing active challenge as an
  alternative to the score waiver; the threshold integration tests reproduce it.

The complete path was tested with encrypted synthetic evidence, the actual
verification pipeline and outbox, the actual webhook dispatcher, a local HTTP
receiver, signature validation, base64 decoding, and duplicate-event suppression.
No real images or additional requests were sent to the configured external endpoint.

| Scenario | Expected and observed |
| --- | --- |
| 59.99% and exactly 60%, score-only policy | Not approved; no webhook |
| 60.0001%, 61%, 75%, 99.69%, 100%, other checks pass | Approved; receiver gets signed webhook and correct selfie bytes |
| 60.0001%, default active-challenge option enabled | Approved; webhook delivered |
| Exactly 60%, passing challenge override enabled | Approved; webhook delivered through challenge rule |
| 35.79%, passing challenge override enabled | Approved; webhook delivered through challenge rule |
| Low selfie with high frame scores, challenge override disabled | Not approved; no webhook |
| 99%, identity unavailable or mismatched | Not approved; no webhook |
| 75%, tenant score threshold raised to >80%, override disabled | Not approved; no webhook |
| 99% approved, tenant endpoint missing | Dispatcher skips; no HTTP request |

The numeric rule is strict `score > thresholds.liveness.autoApprove` (default
0.6). `challengePassApproves` defaults to true and supplies the alternative
approval route. Identity, document, risk and release-validation checks still
apply. After the decision, webhooks follow `verification.approved`; the dispatcher
does not independently turn a numeric score into an approval. Current pipeline
results expose the same underlying selfie score as both liveness score and
selfie score; action-frame scores are separate evidence.

**Validation:** 15 new end-to-end scenarios; the combined pipeline, webhook and
Lambda worker run passed **88 tests**, zero failures. Production decision rules
and tenant thresholds were not changed during this check. These synthetic tests
validate control flow and delivery, not biometric model accuracy.

A strict product rule forbidding approval at or below 60% would require a separate
policy change to the challenge override (and review/ID-only semantics), followed
by release validation. The current policy must not be described as “>60% is the
only way to approve.”

## Approval-only delivery and Flutter retry fix

Verification webhooks are emitted only for `verification.approved`, for both
automatic and manual decisions. Failed, rejected, expired and manual-review
outcomes do not generate a webhook. The dispatcher also suppresses previously
queued non-approved events and marks old delivery retries `skipped`, clearing
their next-attempt time. The explicit `webhook.test` diagnostic remains available.
Approval webhook payloads keep the five-field selfie contract below.

The Flutter result screen previously called `retrySession` without `attemptId`,
which the backend correctly rejected with HTTP 400. The screen now fetches the
current SDK status and supplies its attempt ID. The SDK also resolves the current
attempt when callers omit it; explicitly supplied stale attempts remain errors,
so server-side attempt fencing is preserved. The retry response's new attempt ID
is retained in the returned session. Restart the API/worker and rebuild/relaunch
the Flutter app to use the changes.

Validation: repository suite 558 passing tests; final affected backend suite 48
passing tests (including manual approvals/rejections); Flutter SDK 9 passing tests;
Flutter app 7 passing tests, including clicks on Retry from both full-result and
SDK-status screens. The dashboard production build also passes.

## 3. Receiver contract and troubleshooting

The receiver should accept POST at a public HTTPS endpoint on port 443 and return
2xx promptly. Install the signing secret returned by save; each save rotates it.
Verify `X-Verifypass-Signature` as HMAC-SHA256 over the exact
`X-Verifypass-Timestamp + "." + rawBody` bytes, and reject stale timestamps.
Parsing and then reserializing the JSON before verification can invalidate the
signature. The shared signature verifier uses a five-minute tolerance.

New verification deliveries use exactly this JSON body:

```json
{
  "event": "verification.approved",
  "sessionId": "vps_example",
  "status": "approved",
  "createdAt": "2026-09-16T04:05:08.771Z",
  "selfieBase64": "<base64 image bytes>"
}
```

`createdAt` is the session creation time. `selfieBase64` contains raw base64
without a data-URL prefix. Only selfie evidence from the event's session and
attempt is eligible; documents and liveness frames are excluded. Without a
selfie (including ID-only sessions), the value is null. The test button sends
the same five fields, with event `webhook.test`, status `test`, null session/image
values, and the test creation time.

The selected evidence ID is pinned internally for retries. Image bytes are read
from encrypted evidence storage at send time; plaintext base64 is not persisted
in delivery records or queue messages. Read/decryption/checksum errors fail the
attempt and use the normal retry schedule. Evidence deleted by retention cannot
be recovered by a webhook retry. Already-created legacy deliveries retain their
previous payload on retries; new deliveries use the five-field contract.
Restart the worker after updating this code. The webhook signature covers the
complete JSON, including the base64 image.

| Observation | Investigation / action |
| --- | --- |
| No saved URL | Confirm the selected tenant, save the endpoint and install the returned secret. |
| Test remains pending with zero attempts | Inspect pending outbox/job records and worker execution. Confirm API and worker use the same database/queue and the deployed scheduled drain is active. |
| No historical verification delivery row | The dispatcher may have skipped the event before configuration existed. Send a test, then create a fresh verification. Saving does not replay old events. |
| `could not resolve webhook host` | Check public A records and resolver access. New attempts now retry automatically. |
| `SSRF blocked` | Use a supported public destination. Correct the URL before a manual retry; it will not automatically retry a policy violation. |
| HTTP 401/403 | Check signing-secret rotation and receiver authorization/signature handling. |
| HTTP 404/405 | Check the exact route and POST support. |
| Redirect / `fetch failed` | Configure the final URL directly; check TLS, reachability and receiver redirects. |
| HTTP 5xx / timeout | Check receiver logs and availability; inspect the scheduled retry time. |
| Delivered but consumer did nothing | Inspect `X-Verifypass-Event` and the actual payload; a 2xx acknowledgment only proves HTTP acceptance. |

Deliveries are at-least-once, not exactly-once. Receivers must tolerate duplicates.
The existing manual-review path still updates the session and enqueues separately;
a crash between those operations is a remaining reliability gap. Converting that
whole review decision transaction to an outbox is a separate follow-up. This patch
also does not add DNS-address pinning to the HTTP connection or a per-delivery
concurrency lease; it is not a complete webhook security/reliability redesign.

## 4. Validation

- Full `npm test`: **547 passed, zero failures**, covering backend, shared
  decision/security utilities, SDK core, dashboard client and deployment contracts.
- Final worker-only regression run after the remaining-runtime refinement:
  **14 passed, zero failures**.
- `npm run build --prefix frontend/dashboard`: passed.
- `git diff --check`: passed.

New tests cover matching admin/API URL validation, admin authorization and tenant
isolation, atomic test/outbox creation, queue-outage recovery, real HTTP POST and
signature verification, visible delivered status, a real pipeline finalization
followed by delivery in the same drain, temporary DNS recovery, private-target
blocking, all five retry delays, webhook batch limits, long-job follow-up delivery
and remaining-runtime safeguards.

The local receiver test uses an in-memory Prisma stand-in and substitutes the
transport destination/DNS check to reach loopback. HTTP and signature verification
are real. Its pipeline fixture intentionally has missing captures and emits
`verification.failed`; existing pipeline and dispatcher suites cover approved
outcomes and their payloads. It does not validate production TLS, DNS, MongoDB
transactions, AWS connectivity, browser interaction or the affected external receiver.

## 5. Rollout and acceptance

1. Deploy the API, worker and rebuilt dashboard together. No schema migration is
   required for this patch. Restart a polling worker if using the server topology.
2. Follow the repository release checks. Backend source contributes to liveness
   validation fingerprints, so existing validation receipts may need reevaluation
   through the established release process even though decision rules are unchanged.
3. Select the affected tenant. Keep its existing URL/secret if correct; if resaving,
   install the newly rotated secret on the receiver before testing.
4. Click **Send test webhook**. Refresh the delivery log and require `delivered`,
   the receiver's 2xx status, and a receiver-side verified signature.
5. Complete a new verification and confirm its event is processed by the receiver.
   Retry an existing failed delivery only when its historical event is still wanted.
6. If a test remains pending, use the table above to investigate the queue/worker
   before changing receiver code.

No production deployment or external webhook request was performed during this task.
