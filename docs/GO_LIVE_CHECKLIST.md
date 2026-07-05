# Go-Live Checklist (PRD §33)

Status legend: ✅ implemented in code · 🔧 operational step for you · ⚠️ decision/legal step

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | SSL on all subdomains | 🔧 | AutoSSL for api./app./sdk./verify. — verify each |
| 2 | API keys hashed | ✅ | sha256, prefix-only lookup; plaintext shown once |
| 3 | Tenant isolation tested | ✅ | Isolation suites run in CI (`serviceIsolation`, `tenantIsolation`, `hostedAuth` tests) |
| 4 | Webhook HMAC implemented | ✅ | `timestamp.body` signing + replay tolerance |
| 5 | Evidence outside public directory | ✅/🔧 | Code enforces `EVIDENCE_DIR`; set it outside `public_html` and verify perms (0700) |
| 6 | File upload validation | ✅ | Magic-byte sniffing, 1KB–8MB, jpeg/png/webp only |
| 7 | Dashboard MFA enabled | ✅/🔧 | TOTP implemented; enforce enrollment for admin roles as policy |
| 8 | Admin audit logs | ✅ | All admin/review/key/webhook actions logged |
| 9 | Retention cleanup job | ✅/🔧 | `retention_cleanup` handler done; add cron entry (deploy/cpanel.md) |
| 10 | Database backups | 🔧 | Daily mysqldump cron + offsite copy |
| 11 | Terms of service | ⚠️ | Legal review needed |
| 12 | Privacy notice | ⚠️ | NDPA-compliant notice; cover biometric processing + retention |
| 13 | User consent copy | ✅/⚠️ | Widget blocks capture behind configurable consent copy; legal must approve final text |
| 14 | SDK domain allowlisting | ✅/🔧 | Live public keys fail closed unless `allowed_domains` is configured; sandbox keys may remain open for local testing |
| 15 | Rate limiting | ✅ | Global/login/captures; add mod_ratelimit at Apache when scaling processes |
| 16 | Manual review workflow tested | ✅ | Approve/reject/recapture with audit + webhooks |
| 17 | Webhook retry tested | ✅ | Backoff schedule + exhaustion + manual retry |
| 18 | Sandbox/production separated | ✅/🔧 | `is_live` flag + separate keys; deploy as separate cPanel apps + DBs |
| 19 | Legal review completed | ⚠️ | Include CBN positioning ("KYC support tool") |
| 20 | Faceplugin commercial license reviewed | ⚠️ | Confirm SaaS resale rights + per-machine licenses for liveness, face, ID SDKs |

## Pre-launch operational runbook

1. Provision VPS (or confirm cPanel host allows long-running processes) for worker + Faceplugin containers (`deploy/faceplugin.md`).
2. Activate all three Faceplugin services with licenses; smoke-test each endpoint.
3. Ensure GitHub Actions CI is green, then deploy to cPanel and run `prisma migrate deploy`; create super admin (`scripts/createUser.js`); create first tenant (`scripts/seedTenant.js`).
4. Set all secrets: `SDK_TOKEN_SECRET`, `AUTH_TOKEN_SECRET`, `EVIDENCE_ENCRYPTION_KEY` (64 hex), `DATABASE_URL` — production refuses to boot evidence crypto without a real key.
5. Install cron entries (worker keep-alive, expire_sessions, retention_cleanup, webhook sweep, backups).
6. Run an end-to-end verification against production with a test tenant: create → hosted URL → capture → decision → webhook received.
7. Load test 100 concurrent sessions; confirm p95 processing < 15s (PRD §18) — if not, move worker/Faceplugin to bigger VPS.
8. Confirm `/health` monitored + alerting on webhook failure rate and job queue depth.
