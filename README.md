# VerifyPass

Multitenant liveness, face recognition, and ID verification service for Nigerian fintechs.

## Layout (folder-local monorepo — each folder installs independently)

```
backend/       ONE service: Express API + verification worker (AWS Lambda)
  api.lambda.js / worker.lambda.js   Lambda entries (SAM: backend/template.yaml)
  server.js / worker.js              server entries (dev / VPS)
  shared/                            decision engine, crypto, storage (file: dep)
  scripts/                           seedTenant, createUser, enqueueJob, fetch-models
frontend/      cPanel static builds
  dashboard/   tenant + admin dashboard      verify-page/  hosted verification flow
  sdk/         core / react / js — the client SDKs (file: deps)
flutter-sdk/   Official Flutter SDK for mobile apps (WebView + status polling)
flutter-app/   Sample mobile application integrating VerifyPass Flutter SDK
email-api/     PHP HMAC-authenticated mailer (21 transactional templates)
deploy/        AWS SAM + cPanel atomic deployment automation and contract tests
sample-app/    Web integration demo (cPanel)
scripts/       dev-stack (local MongoDB + API + worker)
```

## Setup

```bash
(cd backend && npm install)              # also links backend/shared
(cd frontend/sdk/core && npm install)
(cd frontend/dashboard && npm install)
(cd frontend/verify-page && npm install) # links frontend/sdk/react → core
(cd sample-app && npm install)
cp backend/.env.example backend/.env     # fill in DATABASE_URL + secrets
# MongoDB: Prisma needs a replica set — Atlas is one already; locally run
#   mongod --replSet rs0   (then once: mongosh --eval 'rs.initiate()')
(cd backend && npx prisma db push --schema prisma/schema.prisma)
(cd backend && node scripts/fetch-models.js)
npm start                                # OR node scripts/start-all.js (API + worker + dashboard + verify-page + sample-app)
# OR for backend-only: node scripts/dev-stack.js
```

## Tests

```bash
npm test                  # backend + SDK core + dashboard + deploy contract tests
npm run test:deploy       # deploy contract and packaging integrity tests
npm run test:email        # PHP email-api security and template tests + Node triggers
npm run test:playwright   # Playwright desktop and mobile hosted verification tests
npm run test:flutter      # Flutter SDK and mobile app test suites
```
## Liveness release checklist

The active-liveness policy (`backend/src/lib/release.js` → `policyVersion`) is
enforced by default: pose magnitude, issued order and timing, ≥3 distinct
frames per action, identity continuity on the best frontal frame. Opposite-sign
turn consistency is recorded only (`CHALLENGE_CONSISTENCY_MODE=review|reject`
to act on it) because the bundled pose model's yaw sign is unreliable.
Run exactly one `worker.js` per machine in development (it refuses to start
next to another one; `WORKER_ALLOW_MULTIPLE=true` for real multi-instance
setups) — every worker also refuses jobs stamped with a different policy
version. Before a deploy:

1. `cd backend && npm run prisma:generate` — the API and worker refuse to start
   on a stale generated client (`assertGeneratedSchema`).
2. `cd backend && npm run release:check` — verifies the generated schema, that
   MongoDB is a replica set (transactions), the outbox table, model digests
   against `scripts/model-manifest.json`, and prints the release identity
   (commit, source digest, policy version, model set) that `/health`,
  `/status` and `/result` also report. It exits nonzero when any effective
  tenant policy lacks a matching release-validation receipt.
3. `node backend/scripts/smoke-liveness-local.js` against a LOCAL replica-set
   database — CORS preflight, consent, a synthetic upload through sanitize +
   encrypt, and transaction rollback. Never smoke-test with a real face.
4. Production liveness approval requires `LIVENESS_VALIDATION_RECEIPTS`, a JSON
  array of `{ "fingerprint": "<reported fingerprint>", "dataset": "<dataset version>",
  "evaluation": "<evaluation report reference>" }` entries. The release check
  reports the required fingerprint for each tenant. Record a receipt only
  after evaluating that exact build and effective policy on an independently
  labelled held-out dataset (`node backend/scripts/evaluate-liveness-dataset.js labelled.json`).
  Missing/mismatched receipts add `LIVENESS_POLICY_UNVERIFIED` and prevent
  automatic approval; rejection signals still take precedence over review.
  `LIVENESS_VALIDATED_POLICY` alone no longer enables approval. Receipts are
  operator attestations, not independently verified certificates.
5. Set `BUILD_COMMIT` where `.git` is absent (Lambda) so results carry the
   deployed commit.

The validation fingerprint includes backend source, model-manifest identity,
tenant settings, effective thresholds, provider identity and decision-related
runtime configuration. Changing these requires re-evaluation. External model
services must use immutable versions and set `PROVIDER_MODEL_VERSION`; changing
an unversioned remote model in place cannot be detected from its URL alone.

The polling worker now runs bounded session-expiry maintenance every minute.
External schedulers can continue invoking `expire_sessions`; concurrent sweeps
are idempotent. Expiration only touches overdue `created`/`started` attempts,
records an audit event transactionally, and preserves previous results/evidence.
Dashboard lists and counts report overdue sessions as expired before cleanup.

The dashboard detail panel has a result/attempt selector. New results retain
their decision and consumed evidence IDs. Historical results without those IDs
show attempt-level evidence; legacy rows without attempt IDs remain explicitly
unbound. Historical null-score face matches display as review, not matched.

After deploying these changes, restart the API and worker together: the policy
version is now `2026-09-07.1-release-validation`. Drain old-policy jobs using
their matching worker before switching producers; do not rewrite queued policy
versions to bypass compatibility checks. Existing results are never rejudged
or overwritten automatically.

## SDK / API contract notes (policy v2)

- **`attemptId` is required** on every session mutation (`/document`, `/face`,
  `/liveness-frame`, `/flash`, `/verify`, `/retry`, `/challenge/reissue`,
  `/challenge/begin`) for sessions created after policy v2. It is returned by
  `POST /verification-sessions` and `GET /challenge`, and changes on every
  retry/reissue. The bundled SDK client attaches it automatically after
  `getChallenge()`; integrators calling the API directly must send it, and old
  widget bundles will receive `VALIDATION_ERROR` until upgraded.
- **Challenge clock.** The challenge is issued at session creation, but its
  10-minute TTL and the 3-minute issue→first-frame window start when the SDK
  calls `POST /challenge/begin` on reaching the liveness step (the widget does
  this). Direct integrators must call it before uploading liveness frames or
  slow document capture will fail with `LIVENESS_CHALLENGE_SEQUENCE_INVALID` /
  `LIVENESS_CHALLENGE_EXPIRED`. `GET /challenge` returns `challengeIssuedAt`,
  `challengeTtlMs`, `firstFrameWindowMs` and the session `expiresAt` so both
  clocks can be shown together.
- **Expressions.** `blink` / `open_mouth` are not issued unless
  `CHALLENGE_ALLOW_EXPRESSIONS=true` and the worker runs the ONNX provider (it
  is the only one that returns landmarks). Legacy expression steps without a
  verified transition route to review.
- **Screen flash** is opt-in per user at the consent screen. A tenant with
  `settings.challenge.enforceFlash` sends every user who declines to review.
- **Vanilla (CDN) SDK** embeds the hosted verification page
  (`HOSTED_BASE_URL/session/<id>#t=<token>`) in an iframe; it requires the
  hosted page to be deployed over HTTPS and has no standalone capture mode.

## Production Deployment

Production deployment is fully automated through `.github/workflows/release.yml` on push to `main` (or via manual workflow dispatch):

1. **Pre-flight & CI Verification**: Backend tests, SDK core/react/js tests, dashboard tests, Playwright browser checks, PHP mailer security tests, SAM template lint, and deployment contract tests.
2. **Backend (AWS Lambda + SAM)**: Digests and builds Node 22 container images for API and worker functions, checks runtime secrets against pinned AWS Secrets Manager versions, applies backward-compatible MongoDB migrations, and validates tenant policy receipts.
3. **Frontend & Mailer (cPanel)**: Packages immutable release artifacts via `deploy/package.cjs`, stages files over host-key-verified SSH/SCP, links shared PHP configuration, and performs atomic symlink switches with automatic rollback on smoke check failures.

For complete step-by-step setup guides, configuration variables, and recovery procedures, see [DEPLOYMENT.md](DEPLOYMENT.md) and [deploy/README.md](deploy/README.md).

## Dashboard Onboarding & Email Platform

Open the dashboard and choose **Create a workspace** to register a sandbox business and its administrator. Existing administrators can open **Get started**. The workflow covers business/integration details, MFA, test credentials, result delivery, retention/review policies, a first verification, and a final readiness checklist.

Saved progress is tenant-scoped and survives refresh/sign-in. Completing setup does not activate production. For test links to work, run the backend worker and hosted verification app, and configure `API_PUBLIC_URL` and `HOSTED_BASE_URL` for that deployment.

Transactional emails are powered by `email-api/`, a standalone PHP service providing 21 HMAC-authenticated email templates (workspace invitations, email verifications, password resets, review escalations, security notices, and weekly digests). Configuration and setup instructions can be found in `email-api/config.example.php`.

Dashboard client tests: `npm test --prefix frontend/dashboard` (also included in root `npm test`).
