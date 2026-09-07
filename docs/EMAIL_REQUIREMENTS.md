# VerifyPass Email Requirements and Gap Analysis

Date: 2026-09-07
Scope: full codebase — backend API/worker, shared package, dashboard, SDK, verify-page, sample app, onboarding and admin tooling.

> **Implementation status:** the SMTP mail API and the full 21-type catalogue
> are implemented in [email-api/](../email-api/README.md) (PHP, cPanel SMTP),
> the Node-side named helpers in
> [emailService.js](../backend/src/services/emailService.js), and the trigger
> points are now wired end to end:
>
> | Finding | Trigger wired |
> | --- | --- |
> | A1 email verification | `register` + `POST /v1/auth/verify-email/request|confirm` |
> | A2 password recovery | `POST /v1/auth/password/forgot|reset` (uniform response) |
> | A3 team invitations | `POST /v1/auth/users/invite` + `/invite/accept` |
> | A4 email change | `POST /v1/auth/email/change` + `/cancel` + `/confirm` |
> | B1 password change | `POST /v1/auth/password/change` + changed notice |
> | B2 MFA change | `mfa/confirm` → notification |
> | B3 new sign-in | `login` → first-seen-IP alert |
> | B4 API key events | issue/rotate/revoke → tenant admins |
> | B5 webhook changed | `onboarding/webhook` → tenant admins |
> | C1 review waiting | pipeline `finalize` → manual_review → reviewers |
> | C2 second confirmation | review `proposed` → other reviewers |
> | C3 webhook exhausted | dispatcher `exhausted` → tenant admins |
> | C5 workspace status | `tenantStatusService.setTenantStatus` |
> | C6 production request | `onboarding/request-production` → ops |
> | D1 deletion completed | `customers/biometric-data` DELETE → audit ref + confirm |
>
> New `User` fields: `emailVerifiedAt`, `pendingEmail`, five token-hash slots,
> `knownLoginIps` (see [schema.prisma](../backend/prisma/schema.prisma)). Tokens
> are 256-bit, sha256-stored, single-use, TTL-bound. All sends are
> fire-and-forget so mail outages never block user flows. Ops-alert (E21),
> weekly digest (E20), incident notice (E19) and evidence-purge notice (E17)
> helpers exist; their schedulers/admin UIs are the remaining follow-ups.

## 1. Executive summary

**VerifyPass sends no email today.** There is no mail provider integration, no
message queue for email, no template system, and no email-action token service
anywhere in the repository (verified: no SMTP/SES/SendGrid/Resend/Postmark
dependency or code path; `package.json` contains none).

Email addresses already exist as data in exactly three places:

| Location | Field | Current use |
| --- | --- | --- |
| `User.email` ([schema.prisma](../backend/prisma/schema.prisma)) | unique login identifier | Syntax-validated at [register](../backend/src/routes/auth.js#L22); **ownership never verified** |
| `Tenant.settings.onboarding.profile.contactEmail` | business contact captured in onboarding step 1 | Stored, validated for syntax in [onboardingService.js](../backend/src/services/onboardingService.js); **never used to send anything** |
| Dashboard login display ([Auth.jsx](../frontend/dashboard/src/Auth.jsx)) | user-visible | Cosmetic |

The README already acknowledges the four headline gaps: *"Email ownership
verification, email-based password recovery, team invitations, and production
approval are not implemented."* This document expands that into a complete,
end-to-end catalogue of every email the platform needs, the required content of
each, and every missing feature that must be built to support them safely.

**Design principle (data minimization, NDPA):** the *verification subject* (the
person being liveness-checked) never provides an email to VerifyPass. All
end-user delivery is the tenant's responsibility via webhooks or polling.
VerifyPass email is exclusively for **tenant workspace users** (admins,
reviewers, developers, auditors) and **platform operations** (super admins).
This boundary must not be crossed: no verification result, score, document
field, or biometric artifact ever appears in an email.

## 2. Where email is necessarily needed — end-to-end flow analysis

### 2.1 Account lifecycle (blocking gaps)

| # | Flow | Current behavior | Why email is necessary |
| --- | --- | --- | --- |
| A1 | Signup (`POST /v1/auth/register`) | Account is immediately active; token returned; email syntax-checked only | Without ownership verification, anyone can register with another person's address; NDPA/accountability requires a verified control channel; typos create permanently unreachable accounts |
| A2 | Password recovery | **Does not exist.** UI says "Contact your workspace administrator" ([Auth.jsx](../frontend/dashboard/src/Auth.jsx#L47)); no forgot/reset endpoint, no change-password endpoint at all | Self-service recovery is required before public signup can be treated as production acquisition (per [DASHBOARD_ONBOARDING_ANALYSIS.md](../DASHBOARD_ONBOARDING_ANALYSIS.md)). Admin resets without email proof are an account-takeover vector |
| A3 | Team invitation | Only `node scripts/createUser.js <email> <password> …` — password travels on the command line, lands in shell history, and is chosen by the creator, not the user | Dual-approval review requires a second reviewer; there is no safe way to onboard them. Invitation email with a one-time setup link is the standard control |
| A4 | Email change | No endpoint exists | Users must be able to rotate a lost/compromised mailbox; both old and new addresses need notification |
| A5 | MFA recovery | TOTP enrollment exists; **no recovery codes, no reset path**. Losing the authenticator = permanent lockout | Recovery requires either recovery codes (issued at enrollment, displayed once) plus a notification email, or an admin-mediated reset with email confirmation |

### 2.2 Security event notifications (required for account integrity)

| # | Event | Current behavior | Why email is necessary |
| --- | --- | --- | --- |
| B1 | Password changed | No change-password endpoint exists (must be built first) | Silent password change is a takeover indicator; notify the mailbox on file |
| B2 | MFA enrolled / disabled / reset | Audit row only (`user.mfa_enrolled`) | A hijacker enrolling their own authenticator must be visible to the real owner immediately |
| B3 | Successful login from new context | Audit row only (`user.logged_in`) | Anomaly login alerts (new IP/device) are standard; full every-login mail is optional |
| B4 | API key issued / rotated / revoked / deleted | Audit rows exist; plaintext shown once in UI | Keys are production credentials; out-of-band confirmation limits silent key creation by a compromised session |
| B5 | Webhook URL changed or signing secret rotated | Audit row; secret shown once | Webhook endpoint redirection silently reroutes all verification results — this is a high-impact security change and must be confirmed by email |
| B6 | Signup/signin rate-limit exhaustion on an address | Login limiter exists; silent to the owner | Alerting the owner on repeated failed access to their address surfaces brute-force attempts |

### 2.3 Operational notifications for tenants (business-continuity gaps)

| # | Event | Current behavior | Why email is necessary |
| --- | --- | --- | --- |
| C1 | Session enters `manual_review` | Reviewers must poll the dashboard; [review queue](../backend/src/routes/review.js#L19) has no push channel. Audit shows 14 sessions currently sitting in review with **0 reviewer notes** | Manual review is on the critical path of every borderline verification; without notification, end users wait indefinitely |
| C2 | Dual-approval decision pending second reviewer | `pending_second_approval` is only visible in the UI | Maker-checker stalls silently if the second reviewer never learns a proposal exists |
| C3 | Webhook delivery **exhausted** | After 5 retries the delivery is marked `exhausted` in [webhookDispatcher.js](../backend/src/worker/webhookDispatcher.js) — no alert anywhere. A tenant whose endpoint is down loses every result | This is exactly the class of failure email exists for: the primary channel (webhook) is the thing that broke |
| C4 | API key approaching expiry | `expiresAt` supported, no warning | Expired production keys = integration outage |
| C5 | Tenant suspended / disabled | Status change has no notification path | Tenants must be told why their integration stopped (also a legal/fairness requirement) |
| C6 | Production activation request & decision | Onboarding completes but there is **no request-activation or KYB queue at all** | Going live must be a reviewed transition; both the ops team (request received) and the tenant (approved/rejected with reason) need email |
| C7 | Evidence retention purge approaching | Retention jobs delete evidence silently per tenant policy | Optional tenant notice before irreversible deletion of case evidence (review teams may need to export PDFs first) |

### 2.4 Compliance notifications (NDPA / data-protection duties)

| # | Event | Current behavior | Why email is necessary |
| --- | --- | --- | --- |
| D1 | Data-subject biometric deletion executed | [deletionService.js](../backend/src/services/deletionService.js) deletes files and strips PII with an audit row, no confirmation to the requester or tenant | NDPA §12.8 fulfillment needs a verifiable completion record delivered to the requesting party |
| D2 | Personal-data breach | No incident-notification capability | NDPA requires notifying the Commission within 72 hours and affected individuals when risk is high; email is the operational channel for internal escalation and tenant notification |
| D3 | Consent copy delivery | Consent timestamp/version stored on the session; no copy delivered to the subject | Optional — subjects' addresses are not collected; if tenants request delivery it must be tenant-mediated, not platform-sent |
| D4 | Scheduled compliance reports / audit exports | Reports are dashboard downloads only | Optional signed-link email for weekly volume/risk digests to tenant admins |

### 2.5 Platform operations (super admin)

| # | Event | Current behavior | Why email is necessary |
| --- | --- | --- | --- |
| E1 | New tenant registered / production activation requested | No queue; super admin discovers via DB | Review workflow intake |
| E2 | Worker down, queue backlog, repeated job failures, stale worker running old policy (the 2026-09-07 incident class) | Log lines only | Ops alerting — email or pager; a stopped worker silently stalls all verifications |
| E3 | `release:check` failing / unvalidated liveness policy in production | Gate fails-closed locally, no escalation | Someone must be told the gate is blocking |
| E4 | Tenant abuse signals (signup rate limits, device-sharing velocity) | Risk flags recorded | Platform-level fraud review |

### 2.6 Explicitly out of scope for email

- **Verification results to end users** — delivered via webhooks/polling; VerifyPass does not hold subject addresses.
- **Biometrics, scores, document numbers, evidence links in email bodies** — never. Emails contain only neutral status words and short-TTL signed links.
- **Marketing/newsletter** — no requirement exists; every email here is transactional or compliance-driven, so no unsubscribe is legally required except on optional digests (which must offer opt-out).

## 3. Email catalogue — types and required content

All emails share a common envelope contract (§3.1), then per-type content (§3.2).

### 3.1 Envelope contract (every email)

| Aspect | Requirement |
| --- | --- |
| Sender | `VerifyPass <no-reply@verifypass.com>` (transactional); replies route to support for notice types that invite response (D1, C5, C6) |
| Subject | Neutral, no PII, no verdicts. Never "Your verification was rejected" style content for end users (we never mail subjects). Company names are user input → HTML-escape and length-cap in templates |
| Preheader | One-line neutral summary |
| Body | Brand header, one-sentence what-happened, key facts table (who/when/IP or actor where relevant), exactly one primary CTA, expiry statement for token links, "If this wasn't you" recovery path for security mail, footer with legal entity, address, and (digests only) unsubscribe |
| Link security | All action links: 128-bit+ CSPRNG token, stored **SHA-256 hash only**, single-use, bound to `(purpose, userId/tenantId)`, TTL per type, absolute HTTPS URL to the dashboard, no open-redirect parameters |
| Idempotency | Each send is an outbox row keyed by `(eventUid, recipient)`; worker retries; duplicate sends impossible |
| Audit | Every send/attempt/bounce writes an audit-log row with template id and recipient hash — never the full address in logs where avoidable |
| Localization | v1: English only; templates must externalize all strings for later locales |
| Accessibility | Semantic HTML, plain-text part always generated, ≥4.5:1 contrast, no image-only CTAs |
| Deliverability | SPF, DKIM, DMARC (p=quarantine→reject) on the sending domain; `List-Unsubscribe` header on digest types only; bounce/complaint events feed a suppression list; never retry hard bounces |

### 3.2 Per-type specification

#### Account lifecycle

**E-01 Verify your email** — *trigger: A1 signup, A4 change (new address), E-03 invitation acceptance.*
- Subject: `Confirm your VerifyPass workspace email`
- Content: greeting by first available identifier (company name for new tenants), one sentence ("Confirm this address to secure the Acme workspace"), CTA `Confirm email`, token TTL **24 h**, resend limited to 3/hour/IP and 5/day/address, link invalidates all prior verification tokens for that address.
- After confirmation: account flag `emailVerifiedAt` set; E-02 sent.

**E-02 Welcome / workspace ready** — *trigger: successful E-01.*
- Subject: `Welcome to VerifyPass — your sandbox is ready`
- Content: what sandbox means (test keys, no live traffic), 3-step next actions matching the onboarding journey, CTA `Finish setup`, support link. No token.

**E-03 You're invited** — *trigger: A3 team invitation (tenant_admin invites reviewer/developer/auditor).*
- Subject: `You've been added to the {Company} workspace on VerifyPass`
- Content: inviter's address, assigned role and what it can do, workspace name, CTA `Set your password` (token TTL **72 h**, single-use; acceptance enforces the 12-char password policy and offers MFA enrollment immediately after), expiry notice, ignore-path ("if you weren't expecting this, ignore — the link expires").
- The creator never sees or chooses the invitee's password — this replaces the `createUser.js` CLI credential flow for tenant staff.

**E-04 Reset your password** — *trigger: A2 forgot-password request.*
- Subject: `Reset your VerifyPass password`
- Content: time and IP/UA summary of the request, CTA `Choose a new password`, token TTL **30 min**, single-use, **uniform response regardless of account existence** (anti-enumeration: the API always answers success; the email is only sent when the address exists), all other sessions invalidated on successful reset, existing reset tokens invalidated on new request.
- Rate limits: 3/hour/address, 10/hour/IP.

**E-05 Your password was changed** — *trigger: B1 successful change/reset.*
- Subject: `Your VerifyPass password was changed`
- Content: timestamp, IP/UA summary, "if this wasn't you" CTA to E-04 flow plus support contact. No token. **Non-suppressible.**

**E-06 Confirm email change (old address)** — *trigger: A4.*
- Subject: `Email change requested for your VerifyPass account`
- Content: new address (masked: `j***@example.com`), timestamp, cancel-CTA (single-use token, 24 h) that aborts the change and flags the session. Non-suppressible. The new address receives E-01; the change only applies after the new address verifies.

**E-07 Authenticator changed** — *trigger: B2 (enroll, disable, admin/self recovery reset).*
- Subject: `Two-factor authentication changed on your VerifyPass account`
- Content: what changed, timestamp/IP, recovery path if unrecognized. Non-suppressible.

**E-08 New sign-in (anomaly only)** — *trigger: B3 first-seen IP/device fingerprint.*
- Subject: `New sign-in to your VerifyPass account`
- Content: time, approximate geo/IP, device summary, "secure my account" CTA (forces password reset + session revocation). Configurable per user (default on); every-login variant is not offered.

#### Operational — tenant

**E-09 API key event** — *trigger: B4.*
- Subject: `API key {action} for {Company} ({sandbox|live})`
- Content: key prefix only (e.g. `vpk_live_ab12…`), actor, action (created/rotated/revoked/deleted/expiring in 14 days for C4), CTA to Settings. Never contains key material.

**E-10 Webhook endpoint changed** — *trigger: B5.*
- Subject: `Webhook settings changed for {Company}`
- Content: new host (not full URL path), whether signing secret was rotated, actor, timestamp; CTA to Webhooks page; prominent "if you didn't make this change, rotate your secret and review API keys immediately". Non-suppressible.

**E-11 Webhook delivery failing** — *trigger: C3 — delivery reaches `exhausted`, or 24 h of continuous failure.*
- Subject: `Action needed: verification results are not reaching your endpoint`
- Content: endpoint host, last error class (DNS/TLS/HTTP status), attempt count and retry schedule, impact statement ("new results will continue to queue; none are lost"), CTA to the delivery log. Throttled: max 1/6 h/tenant; recovery email (`Recovered: webhook deliveries resumed`) when a subsequent delivery succeeds.

**E-12 Review case waiting** — *trigger: C1 — session enters `manual_review`.*
- Subject: `Review needed: 1 verification case waiting` (or digest `N cases waiting for review`)
- Content: count, oldest waiting time, risk-level breakdown (no customer references, no scores), CTA `Open review queue`. Recipients: tenant roles `tenant_admin`, `compliance_reviewer`. Immediate or hourly digest per user preference (default immediate). Daily cap 24/tenant.

**E-13 Decision awaiting your confirmation** — *trigger: C2 dual-approval proposal.*
- Subject: `A review decision needs a second confirmation`
- Content: case age, proposed decision word only (`approval`/`rejection`), proposer's address, CTA to queue. Sent to reviewer roles **excluding the proposer**.

**E-14 Production access requested** — *trigger: C6 tenant submits activation request.*
- To: platform ops (super admins). Subject: `Production access request: {Company}`. Content: onboarding checklist summary (all six steps with evidence), contact email, test-session count and outcomes, CTA to admin review screen.

**E-15 Production access decision** — *trigger: ops approve/reject E-14.*
- To: requesting tenant admin. Subject: `Your VerifyPass production access request: approved|declined`. Content: decision, reason text (free-form from reviewer), next steps (live keys / what's missing), support link.

**E-16 Workspace status changed** — *trigger: C5 suspension/disable/reactivation.*
- Subject: `Your VerifyPass workspace has been {suspended|reactivated|disabled}`
- Content: effective time, plain-language reason category (policy/billing/security request), what still works (dashboard read-only vs full stop), appeal/contact CTA. Non-suppressible.

**E-17 Evidence purge scheduled** — *trigger: C7, N days before retention expiry (default 3, tenant-configurable, off by default).*
- Subject: `Evidence for N completed cases will be deleted on {date}`
- Content: count, date, retention policy reference, CTA to export case PDFs. Explicitly notes deletion is irreversible. Optional per tenant.

#### Compliance

**E-18 Data deletion completed** — *trigger: D1.*
- To: tenant admin who executed, and the data-subject contact when the tenant supplied one. Subject: `Biometric data deletion completed (reference confirmed)`
- Content: sessions affected count, files deleted count, completion timestamp, retention statement (scores/metadata retained per policy), certificate-style reference id for the audit row. No customer reference value itself when mailed outside the tenant.

**E-19 Security incident notice** — *trigger: D2 (manual, ops-initiated, template-gated).*
- Two variants: regulator/ops internal escalation; affected-tenant notice. Content: incident window, data classes involved at category level only, actions taken, tenant actions required, contact. Requires dual-control send (two super admins) because of legal sensitivity.

**E-20 Weekly digest (optional)** — *trigger: D4/C-summary, weekly cron.*
- Subject: `Your VerifyPass week: {N} verifications`
- Content: counts by status, top rejection reasons, review queue depth, webhook health. Links, no rows. **Must include one-click unsubscribe and per-user opt-in default-off.**

#### Platform ops

**E-21 Ops alert** — *trigger: E2/E3/E4.*
- To: super admin distribution. Subject prefixed `[VerifyPass ops]`. Content: signal, host/worker id, first-seen/last-seen, runbook link. Throttled per signal key. (Primary channel should be paging; email is the durable record.)

## 4. Missing features required to support this

Grouped by layer, in dependency order.

### 4.1 Core mail platform (blocks everything)

1. **Mailer service** (`backend/src/services/mailer.js`): provider abstraction with two drivers — AWS SES (aligns with the existing AWS optional deps; recommended) and SMTP fallback for cPanel/development. Must support HTML+text parts, per-message metadata tags (template id, tenant), and bounce/complaint webhook ingestion.
2. **Email outbox**: new `email_queue` collection or reuse the existing job-queue/outbox pattern ([jobService.js](../backend/src/services/jobService.js)) with a `send_email` handler in the worker — sends are never inline in a request path. Payloads carry template id + variables, never rendered bodies.
3. **Template system**: versioned templates (`backend/src/email/templates/<id>/subject.txt, html.hbs, text.hbs`), variables validated per template, all user input escaped, template version recorded on each send for audit.
4. **Suppression list**: hard bounce / complaint → address suppressed; all sends check it; suppression events audited and surfaced in Settings.
5. **Config**: `EMAIL_PROVIDER`, `EMAIL_FROM`, `SES_*` or `SMTP_*`, dashboard base URL for links; production startup fails-closed if unset (same pattern as evidence key).

### 4.2 Token & endpoint layer (blocks §2.1, §2.2)

6. **Email-action token model**: `EmailToken` collection — `{ id, userId, purpose, tokenHash, expiresAt, usedAt, createdIp, metadata }`; sha256-hashed 128-bit+ tokens; single-use; issuing a new token for the same `(userId, purpose)` invalidates prior ones; sweep in retention job.
7. **New auth endpoints**:
   - `POST /v1/auth/verify-email/request` and `/confirm` (A1)
   - `POST /v1/auth/password/forgot` and `/reset` (A2) — uniform success response, rate-limited, sessions revoked on reset
   - `POST /v1/auth/password/change` (authenticated, current-password required) — **does not exist today at all** (B1)
   - `POST /v1/auth/email/change` + confirm/cancel (A4)
8. **Team invitation system**: `POST /v1/users/invite` (tenant_admin), `POST /v1/auth/invite/accept`; `User.status` gains `invited`; removes passwords from the CLI path for tenant staff (keep `createUser.js` for bootstrap super admin only).
9. **MFA recovery**: recovery codes at enrollment (8 codes, sha256-stored, single-use, shown once) + E-07 notifications + an admin reset flow that notifies the user.
10. **Schema additions**: `User.emailVerifiedAt`, `User.lastLoginIp/At` (for E-08 anomaly detection), `Invitation` collection, notification-preference subdocument on `User`.

### 4.3 Event integration (blocks §2.3–§2.5)

11. **Review notifications**: enqueue E-12 when a decision lands in `manual_review` (hook in the pipeline `finalize` path and in review route for C2), with per-user preference and digest batching.
12. **Webhook failure alerts**: hook in [webhookDispatcher.js](../backend/src/worker/webhookDispatcher.js) on `exhausted` transition + recovery detection; throttle state stored per tenant.
13. **Production activation queue**: onboarding gains a "Request production access" action → `TenantActivationRequest` collection + E-14/E-15 + admin approve/decline screen. Until this exists, onboarding completion cannot lead anywhere.
14. **Tenant status-change notifications**: wherever super admin sets `suspended/disabled` (needs an endpoint — currently only seed scripts touch status) → E-16.
15. **Retention pre-purge notice**: query in the existing `retention_cleanup` job for files nearing expiry → E-17.
16. **Deletion confirmation**: E-18 emitted from `deleteBiometricData` with the audit reference.
17. **Ops alerting**: worker heartbeat monitor (no successful tick in N minutes), queue depth, policy-validation failure → E-21.

### 4.4 Dashboard UX

18. Notification preferences page (per user: security mail — locked on; operational mail — toggles; digest — opt-in).
19. "Resend verification" state on login for unverified accounts (unverified users get a restricted, verify-first banner rather than a hard block in sandbox; production keys require verified email).
20. Invite management screen (pending invites, revoke, resend with token invalidation).
21. Email-change and password-change forms in Settings → Account (currently absent).

### 4.5 Security, privacy, compliance requirements for the whole feature

- Anti-enumeration: forgot-password, invite-resend and verify-resend always return identical success; timing-normalized.
- All email-triggering public endpoints rate-limited per IP **and** per address (signup limiter pattern already exists — extend it).
- No PII beyond the recipient address and workspace name in any email; no verdicts, scores, customer references, document data, or evidence URLs. Case links require an authenticated dashboard session anyway — the email only links to the queue, never to a tokenized evidence view.
- Email content is tenant-brandable only in v2 (name/logo), never custom HTML (phishing risk).
- Every template send path covered by tests: token single-use, expiry, invalidation-on-reissue, uniform responses, rate limits, suppression, outbox idempotency, tenant isolation of invitations.
- Retention: `EmailToken` rows purged 7 days after expiry; send metadata retained per audit policy with address hashed.
- Regulatory: transactional/security mail exempt from unsubscribe; digest (E-20) requires opt-in + List-Unsubscribe; breach-notice template (E-19) reviewed by counsel before first use.

## 5. Suggested build order

| Phase | Deliverables | Unblocks |
| --- | --- | --- |
| 0 | Mailer + outbox + templates + suppression + config (4.1) | All |
| 1 | Token model, email verification (E-01/E-02), forgot/reset (E-04/E-05), password change endpoint (4.2.6–8) | Public signup credibility |
| 2 | Invitations (E-03), MFA recovery + notifications (E-06/E-07/E-08) | Dual-approval staffing, account recovery |
| 3 | Review + webhook-failure notifications (E-09–E-13) | Operational safety for live tenants |
| 4 | Production activation queue (E-14/E-15), status notices (E-16), deletion confirmations (E-18) | Go-live readiness |
| 5 | Digest (E-20), retention notices (E-17), incident templates (E-19), ops alerting (E-21) | Maturity |

Phase 0–2 are required before self-service signup is exposed beyond controlled beta; phase 3 is required before any tenant goes live; phase 4 is required before the first production activation.

## 6. Validation requirements

- Unit: token lifecycle, template rendering/escaping, suppression, throttles, uniform responses.
- Integration: full signup→verify→login, forgot→reset→old-session-revoked, invite→accept→MFA-offer, webhook-exhausted→alert→recovery, review-entry→notification.
- Provider: SES sandbox + bounce/complaint simulator; SMTP capture (e.g. MailHog) in dev via `EMAIL_PROVIDER=smtp`.
- Deliverability pre-launch: SPF/DKIM/DMARC verified, seed-list inbox test, suppression-list drill.
