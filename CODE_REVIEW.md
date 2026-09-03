# VerifyPass — Codebase Analysis, Fixes & Feature Roadmap

**Date:** 2026-09-01
**Scope:** `backend/` (Express API + verification worker + shared decision engine), `frontend/sdk/*`, `frontend/verify-page`, `frontend/dashboard`
**Test suite:** 253/254 passing. The single failure (`tests/uploadFlow.test.js`) is an environment issue — the `sharp` native binary for this machine's architecture isn't installed — not a code defect.

---

## 1. How the system works

VerifyPass is a multitenant liveness, face-recognition and ID-verification service for Nigerian fintechs. The architecture in one pass:

**Session lifecycle.** A fintech's server calls `POST /v1/verification-sessions` with its secret key. The API mints a session with a self-locating SDK token (`sdk_v1_...` embeds the API origin, so the browser SDK never configures a baseUrl) and an active-liveness challenge — a randomized sequence of actions the user must perform. The end user, via the embedded SDK or the hosted verify page, records consent (NDPA lawful basis, set-once, audit-logged), uploads document/selfie/liveness-frame captures as base64 JSON, then calls `/verify`, which flips the session to `submitted` and enqueues a `run_verification` job.

**Processing.** A background worker (long-poll on `job_queue` with optimistic claims, or Lambda via SQS/db-drain) decrypts the evidence, runs provider calls (passive liveness, face compare, OCR on front and back of the document), verifies the challenge server-side (client scores are never trusted), computes tenant-scoped risk signals (repeated failures, device sharing, IP velocity), optionally screens against sanctions/PEP lists, and feeds everything into a pure, golden-table-tested decision engine → `approved / rejected / manual_review / failed` with reason codes. Finalization is atomic (compare-and-set on session status) and dispatches a signed webhook with a 1m/5m/30m/2h/12h retry ladder.

**Trust boundaries.** Every tenant-owned query goes through `req.scopedDb`, which forces `tenantId` into the where-clause; cross-tenant lookups 404. Evidence is AES-256-GCM encrypted before touching any storage backend (local fs or S3). Dashboard users authenticate with scrypt-hashed passwords + optional TOTP MFA, HMAC-signed 8-hour tokens, and RBAC; manual review supports maker-checker dual approval. Reviews, key operations, consent, and decisions are all audit-logged.

This remains a well-built codebase: disciplined multitenancy, real queue semantics, a pure decision engine, and comments that explain *why*.

---

## 2. Fixes applied (all 16 findings from the previous report)

| ID | Finding | Fix |
|----|---------|-----|
| **H1** | Global 1 MB JSON parser silently capped all capture uploads | Global parser now skips `POST /v1/verification-sessions/:id/*` so the per-route 12 MB parser fires; create-session keeps the 1 MB limit |
| **H2** | Plaintext biometric images mirrored to Cloudinary were never deleted (NDPA erasure gap) | New `destroyEvidenceImage()`; called from both `deleteBiometricData` (§12.8 right-to-erasure) and the retention cleanup loop |
| **H3** | Webhook SSRF — tenant-controlled URL, private ranges not blocked | Delivery-time validation: DNS resolution, rejection of loopback/RFC1918/link-local/CGNAT/multicast ranges, HTTPS + port 443 enforced; blocked deliveries recorded with reason |
| **M1** | `X-Forwarded-For` trusted blindly for rate limiting and risk signals | `trust proxy` configured (`TRUST_PROXY_HOPS`, default 1); all IP reads use `req.ip` |
| **M2** | Non-atomic finalize → duplicate results/webhooks on worker crash | Optimistic compare-and-set flips session status *first*; a racing worker finds it changed and skips |
| **M3** | Open redirect / `javascript:` scheme on hosted verify page | Redirect scheme validated: `https:` only (`http:` in dev); anything else stays on the result page |
| **M4** | Evidence endpoint fell back to hard-coded dev decryption keys in prod | Production now fails immediately on key mismatch with a loud log; dev fallback kept for dev/test only |
| **M5** | Evidence image endpoint not tenant-scoped | Evidence access tokens now HMAC-bound to the tenant; the serve endpoint verifies the token against the evidence's actual tenant |
| **M6** | Maker-checker interleaving untested | Three new tests: recapture immediacy, proposal after a recapture cycle, same-user re-proposal |
| **L1** | `verifySdkToken` threw a 500 on hash length mismatch | Null-hash and length guards → clean 401 |
| **L2** | Dead try/catch around base64 decode | Replaced with an explicit empty-decode check |
| **L4** | Login rate limiter failed open on DB errors | Login limiter is now fail-closed; others stay fail-open by design |
| **L6** | Unbounded session queries could OOM on large tenants | `take: 50000` caps on `/dashboard/stats` and report aggregations |
| **L7** | Retention deletes skipped Cloudinary | Covered by the H2 fix |
| L3, L5 | Documented known gaps (direction check off by default; staging limiter backend) | No code change — tracked below as open items |

## 3. New findings from this pass (fixed today)

### N1 — `GET /dashboard/sessions/:sessionId/attempts` had NO auth middleware — **FIXED**
The route was registered without the `anyUser, requireTenant, tenantScope` chain every sibling route uses. In practice it 500'd for everyone (`req.scopedDb` was never attached), so nothing leaked — but it was an unauthenticated endpoint one refactor away from exposing attempt history. The middleware chain is now applied, matching the rest of the dashboard router.

### N2 — MFA secret can be overwritten without re-verification (open, recommended fix)
**File:** `backend/src/routes/auth.js` (`POST /v1/auth/mfa/confirm`)
`/mfa/enroll` refuses when MFA is already enrolled, but `/mfa/confirm` doesn't check — a caller holding a valid session token can POST a *new* secret + matching TOTP and silently replace the existing MFA secret without proving control of the old factor or the password. A stolen 8-hour session token becomes durable account takeover. **Fix:** in `/mfa/confirm`, reject if `req.user.mfaSecret` is already set (require a password- or TOTP-verified reset flow instead).

### N3 — Dashboard auth tokens have no revocation (open, low)
`vpu_` tokens are pure HMAC with an 8-hour expiry — there is no jti/deny-list, so password change, MFA change, or user deactivation... deactivation *is* covered (the middleware re-reads the user row and requires `status: "active"`), but password/MFA changes don't invalidate outstanding tokens. Consider a `tokenVersion` field on the user row, bumped on credential changes and embedded/checked in the token.

### N4 — DNS rebinding window in the SSRF check (known limitation, low)
The new webhook validation resolves the host and checks the IPs, but the subsequent `fetch` re-resolves DNS — a malicious authoritative server could answer differently the second time. Full mitigation means pinning the resolved IP via a custom agent/dispatcher. Low priority given the tenant is an authenticated, paying fintech, but worth noting in the threat model.

### Open items carried forward
- **L3:** `strictDirection` liveness pose enforcement is opt-in and off by default — "turn_left" vs "turn_right" are indistinguishable until calibrated. Don't mistake it for an active control.
- **L5:** Staging must keep `RATE_LIMIT_BACKEND=db` (the default) or caps multiply per process.
- **Dashboard token in `sessionStorage`:** acceptable at MVP with the strict CSP in place; an httpOnly-cookie session would remove the XSS-exfiltration path if the dashboard grows.

---

## 4. New features worth building

Ranked by leverage for a Nigerian KYC product; each is sized roughly (S = days, M = 1–2 weeks, L = multi-week).

### Verification capability
1. **NIN / BVN registry lookup (L, highest value).** Today the pipeline validates that a document is real-ish and matches the face — it never confirms the identity *exists*. Integrating NIMC NIN and NIBSS BVN (via an aggregator like Dojah, Prembly, or QoreID) and cross-checking OCR name/DOB against the registry would move VerifyPass from document verification to true identity verification — the thing CBN-regulated customers actually need for tiered KYC. The pluggable-provider pattern in `worker/config.js` is already the right seam.
2. **Address verification (M).** Utility-bill OCR + optional field-agent API for CBN Tier-3 KYC.
3. **Document authenticity checks (M).** Font/hologram/template tampering detection on the ID image (screen-recapture detection, moiré analysis) — the current `liveFaceAsDocument` check catches one spoof class; template matching per Nigerian document type (NIN slip, voter's card, driver's licence, passport) would catch photoshopped IDs.
4. **Face dedup / one-identity-per-person (M).** Store face embeddings (encrypted) and flag when the same face enrolls under different `customerReference`s — the strongest anti-fraud signal a lender can have. The risk-signal framework is already there to consume it.
5. **AML ongoing monitoring (M).** Screening currently runs once at verification. Re-screen the approved customer base on a schedule (the job queue + cron plumbing already exists) and emit a `customer.screening_hit` webhook when someone becomes sanctioned/PEP after onboarding.

### Platform & developer experience
6. **Sandbox test fixtures (S).** Magic `customerReference` values (e.g. `TEST_APPROVED`, `TEST_REJECTED`, `TEST_MANUAL_REVIEW`) that short-circuit the pipeline in test mode — every payment API does this; it makes integration testable without staged photos.
7. **Idempotency keys on session creation (S).** `Idempotency-Key` header so client retries can't double-create (and double-bill) sessions.
8. **Webhook management UX (S/M).** Endpoint verification handshake, a "send test event" button, and delivery replay from the dashboard (the delivery rows and manual-retry endpoint already exist — this is mostly UI).
9. **Usage-based billing surface (M).** `usageSummary` already computes billable sessions; add per-tenant plans, quotas, and a Paystack/Flutterwave metered-billing hook.
10. **Team management UI (S).** `createUser` and RBAC exist server-side but there's no invite flow — tenant admins currently can't self-serve adding reviewers.

### Operations & compliance
11. **Data-residency mode (M).** A per-tenant flag forcing evidence to Nigerian-region storage and disabling the Cloudinary mirror entirely — a selling point under NDPA cross-border rules now that erasure is fixed.
12. **Reviewer console upgrades (M).** Side-by-side face compare with zoom, per-action liveness frame strip (Cloudinary naming already encodes the action), and keyboard-driven queue triage — reviewer throughput is the bottleneck at scale.
13. **Analytics: conversion funnel (S/M).** Sessions created → consent → captures → submitted → decided, with drop-off per step and per SDK version; the audit trail already contains every event needed.
14. **Status page + SLA metrics (S).** Provider latency and queue-depth gauges from the watchdog's vantage point; expose p95 decision time per tenant.
15. **Model calibration loop (M).** `scoreDistribution` exports exist; close the loop with an admin view that proposes threshold updates per model version (FAR/FRR curves) and applies them through the existing bounded settings validator.

If you'd like, I can start on any of these — the sandbox fixtures (#6), idempotency keys (#7), and the MFA re-enrollment guard (N2) are all small, self-contained wins I'd suggest first.
