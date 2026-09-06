# Dashboard analysis and onboarding implementation

Date: 2026-09-05

## Result

The dashboard now supports self-service sandbox business signup followed by a seven-screen onboarding journey. Existing tenant administrators enter the same journey when their workspace has unfinished setup. Tenant configuration persists in MongoDB; reloading restores the signed-in identity and resumes the first incomplete task. No schema migration or new dependency was introduced.

This is workspace/integration onboarding. It does not implement business KYB approval, email ownership verification, billing, or automatic production activation.

## Dashboard inventory

| Area | Existing behavior and dependencies | Assessment / implementation |
| --- | --- | --- |
| Sign-in | Password and optional TOTP, authenticated dashboard requests through `src/api.js` | Replaced the basic login form with labeled sign-in/signup screens, submission state, validation, password confirmation, and errors. |
| Session lifecycle | Token persisted in sessionStorage, user state initialized to null | Added `GET /v1/auth/me` and restoration. Previously a refresh showed login despite the stored token. Logout and subsequent login now clear obsolete tenant context and selected-session state. |
| Overview | Tenant session counts, status breakdown, average completion time | Preserved. Incomplete administrators are taken to onboarding; Get started remains available after completion. |
| Sessions | Filters, session details, scores, evidence images, attempts, challenge telemetry | Preserved and linked from onboarding's first-test outcome. |
| Manual review | Decisions and optional two-person confirmation | Setup now lets administrators review the two-person policy. Navigation is restricted to supported roles. |
| Reports | Volume, reasons, usage and exports | Preserved; developer role no longer sees a section its API rejects. |
| Settings | Thresholds, retention and API-key lifecycle | Reused key issuance. Added a server-side restriction preventing sandbox tenants from issuing live keys through Settings. |
| Webhooks | Delivery list supported dashboard JWT; configuration/retry used secret-key routes | Added tenant-admin JWT configuration/retry endpoints and connected the dashboard to them. Viewer roles retain delivery visibility without mutation controls. |
| Webhook integration guidance | UI documented `X-VP-Signature` over the raw body | Corrected to the implemented `X-Verifypass-Signature`, `X-Verifypass-Timestamp`, and HMAC-SHA256 over `timestamp.rawBody`, with stale timestamp rejection. |
| Onboarding | No registration, tenant setup UI, progress tracking, or readiness checks | Implemented signup and the complete setup journey described below. |

## Findings addressed

1. **No entry path for a new business.** Public signup creates the tenant and its initial administrator in one Prisma nested write. The tenant starts in `sandbox`, the role is always `tenant_admin`, and client-supplied role/status/tenant IDs are ignored. Passwords use the existing scrypt hashing function. Signup is limited to five attempts per IP per hour, with the existing database-backed rate-limit mechanism in production/staging.
2. **Refresh and tenant context were inconsistent.** Identity is restored from an authenticated API request, not from client-trusted identity data. Clearing auth also clears the tenant override. Network failures during initial identity restoration offer retry rather than silently discarding the session.
3. **Dashboard webhook writes could not authenticate correctly.** Admin-only JWT endpoints now support endpoint configuration, one-time signing-secret issuance and scoped retries. Existing server-to-server API-key routes remain available to integrations.
4. **Roles saw inaccessible sections.** Review, reporting and administrative navigation now match the relevant backend role policies. Backend checks remain the authority.
5. **No reliable definition of “setup complete.”** The server derives readiness from saved configuration, usable test keys and an actual tenant-owned test outcome. A browser cannot complete setup by submitting its own ready flag or another tenant's session ID.
6. **MFA confirmation could overwrite existing enrollment.** Confirmation now rejects already-enrolled accounts and validates setup-key shape before attempting TOTP verification.
7. **No distinction between setup completion and production activation.** Completion never changes tenant status or issues live credentials. Production remains an administrator-controlled transition.

## Full workflow

### Account creation

Open the dashboard → Create a workspace → enter business name, work email, password and confirmation → create sandbox workspace → enter onboarding.

The API trims business/email values, normalizes email case, validates lengths, hashes the password and relies on the existing unique email index. Duplicate creation failures provide a sign-in/administrator recovery direction. A Prisma nested tenant/user write prevents an orphan tenant if user creation fails. The browser receives the normal session token and safe identity fields only.

### Setup steps

| Screen | User action | Persisted or checked evidence | Recovery |
| --- | --- | --- | --- |
| 1. Your business | Business name, contact email, verification product, hosted/React/JavaScript integration, browser domains | Validated profile in `Tenant.settings.onboarding.profile`; company name and allowed domains update the runtime tenant fields | Edit and save again. Embedded integrations require a hostname; schemes, ports and paths are rejected. |
| 2. Account security | Enable authenticator-based MFA with a six-digit confirmation, or explicitly defer | Actual user MFA enrollment, or saved tenant setup deferral | Return to enable later. A setup key alone does not mark MFA enabled. |
| 3. Connect your app | Create/copy secret test key; embedded SDK users also create a public test key | Active, unexpired test keys belonging to the current tenant | Existing keys count. Lost plaintext keys must be rotated in Settings. Key values are held only in component memory. |
| 4. Receive results | Choose server-side polling or configure an HTTPS webhook | Saved delivery choice; webhook choice additionally requires URL and signing secret | Secrets display once. Existing webhook configurations cannot silently be converted to polling. Review deliveries in Webhooks. |
| 5. Review policies | Save evidence and failed-session retention; choose two-person review | Validated policies and review timestamp | Limits come from the backend's existing bounds. Threshold settings are preserved. |
| 6. First verification | Create a sandbox session, open its hosted link, complete capture, check for result | Tenant-owned test session reaching approved, rejected or manual_review | Created, started, expired and failed sessions do not count. Create another link or wait for the worker and refresh. Previously processed test sessions also count. |
| 7. Ready to build | Review all six tasks, resolve missing items, finish setup | Server recomputes readiness and writes an idempotent completion timestamp | Revoking/expiring required keys makes readiness incomplete again. Return to individual steps. |

“Continue later” leaves onboarding. Saved steps remain; unsaved form edits do not. No API keys, signing secrets, MFA setup secrets or hosted session tokens are persisted into onboarding progress.

The test launch uses the actual existing session service and configured `HOSTED_BASE_URL` / `API_PUBLIC_URL`. Sandbox still processes real submitted images. The interface explicitly asks for a consenting tester and does not fabricate a passing verification.

For React/JavaScript choices, the connection screen provides server-side session creation and the corresponding widget example with placeholder credentials. React integration guidance points to the repository's model assets. The hosted option needs only a server secret key.

## API and persistence contract

| Method | Path | Access / purpose |
| --- | --- | --- |
| POST | `/v1/auth/register` | Public, rate-limited atomic sandbox signup |
| GET | `/v1/auth/me` | Authenticated, safe current identity and tenant summary |
| GET | `/v1/onboarding` | Tenant administrator or scoped super administrator; current readiness |
| PUT | `/v1/onboarding/profile` | Validate and save business/integration settings |
| PUT | `/v1/onboarding/security` | Explicitly defer MFA; enrollment uses existing MFA endpoints |
| PUT | `/v1/onboarding/delivery` | Choose polling or an already-configured webhook |
| PUT | `/v1/onboarding/webhook` | Configure HTTPS endpoint and return rotated signing secret once |
| POST | `/v1/onboarding/webhooks/:eventId/retry` | Retry a tenant-owned undelivered event |
| PUT | `/v1/onboarding/policies` | Apply existing retention and review validation |
| POST | `/v1/onboarding/verification` | Create a sandbox test using the saved product selection |
| POST | `/v1/onboarding/complete` | Recompute checklist and persist completion |

Onboarding lives in the existing `Tenant.settings` JSON object. Runtime fields retain their existing locations: company name/domains/webhook on Tenant; keys in ApiKey; MFA on User; sessions in VerificationSession. No new collection or Prisma schema change is needed.

All onboarding endpoints require an available tenant and admin role. A tenant admin's `X-Tenant-Id` header cannot override their actual tenant. Super admins must select a tenant. Suspended and disabled tenants cannot use onboarding. Status responses contain only safe fields; auth/onboarding responses use `Cache-Control: no-store`. Mutations append audit events without credential values.

## Source organization

- `frontend/dashboard/src/Auth.jsx`: sign-in and business signup.
- `frontend/dashboard/src/Onboarding.jsx`: setup screens, state, actions, examples and readiness UI.
- `frontend/dashboard/src/onboarding.css`: responsive onboarding/auth styling and dashboard navigation adjustments.
- `frontend/dashboard/src/App.jsx`: session restoration, role-aware navigation and webhook integration.
- `frontend/dashboard/src/api.js`: tab session and tenant-context cleanup.
- `backend/src/routes/auth.js`: registration, identity lookup and MFA confirmation safeguards.
- `backend/src/routes/onboarding.js`: admin-only workflow orchestration and audit events.
- `backend/src/services/onboardingService.js`: profile/URL validation, readiness calculation and state persistence.
- `backend/tests/onboarding.test.js`: workflow, signup, MFA, roles, isolation, credentials and rate limits.
- `frontend/dashboard/tests/api.test.js`: session/tenant reset and actionable API error regression coverage.

The root test command now runs dashboard API-client tests as well as backend/shared/SDK tests. Dashboard CI also runs these tests before building.

## Remaining gaps and detailed follow-up priorities

### Before treating self-service signup as a production acquisition system

- **Email ownership verification and automated password recovery:** no mail provider or token/delivery workflow exists in this implementation. Email is syntax-checked, not ownership-verified. The UI points account-recovery requests to an administrator. No emails were sent.
- **Production approval/KYB and billing:** onboarding completion is integration readiness, not business approval or regulatory validation. No approval submission queue, payment collection, quota plan or automated activation is implemented.
- **Team invitations and MFA recovery:** enabling two-person review requires a second account provisioned through existing administration tooling. There is no new invitation UI, recovery-code flow or self-service MFA reset.
- **Sandbox resource controls:** IP-based signup limits are not a substitute for tenant quotas, email verification or broader abuse controls when offering public compute-intensive verification.

### Dashboard engineering follow-ups

- **Concurrent settings edits:** settings are still JSON read/merge/write operations, consistent with the existing settings service. Concurrent tabs/admins can overwrite one another's updates; use versioned optimistic writes or transactional updates for stronger guarantees.
- **Real pagination and aggregation:** dashboard stats aggregate a capped set of sessions in application code, and session listing is limited. At larger scale, add cursor pagination and database aggregation rather than treating capped results as full historical totals.
- **Component structure:** review/evidence/report/settings screens remain in the large App.jsx file. Auth and onboarding are separated, but the existing screens merit their own modules and interaction tests.
- **Routing and error handling:** dashboard view state is still local React state, rather than URL routes. The older shared data hook lacks request cancellation and consistent error reset. Global expired-session handling beyond initial restoration remains a follow-up.
- **Accessibility and layout:** new inputs have labels, progress/step semantics, keyboard buttons, status/error regions and responsive styles. Existing evidence tables and dialogs need a broader accessibility and narrow-screen review.
- **Delivery proof:** saving a webhook proves configuration only. A first test result does not prove that the receiver verified or acknowledged the event; validate delivery and receiver behavior separately before production.

## Validation

- `npm test`: **431 passed, 0 failed, 0 skipped** — backend 239, shared 87, SDK 103, dashboard client 2.
- `npm run build`: all four targets passed (SDK JS, dashboard, verify-page, sample app), without build warnings in the final run.
- `npm run prisma:validate --prefix backend`: passed against the unchanged schema.
- `git diff --check`: passed.
- API tests cover a complete persisted setup, forged completion rejection, sandbox-only session creation, tenant isolation, role denial, expired/revoked keys, webhook-secret omission, MFA confirmation, signup normalization/role enforcement, duplicate signup handling and per-IP signup limits.
- Signup tests inspect the Prisma nested-write contract using an in-memory stand-in; an actual MongoDB transaction was not exercised.
- Browser connection discovery returned no available browser. Visual layout, keyboard interaction, refresh behavior in a real browser and mobile rendering were not manually verified. Frontend compilation and API-client tests are not substitutes for that check.
- No live biometric capture, external webhook delivery, email, production database mutation or deployment was performed.
