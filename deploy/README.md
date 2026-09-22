# Production Deployment: AWS + cPanel

## Release Contract

Every push to `main` (or a manual run on `main`) runs `Production release`:

1. Run backend/shared/SDK/dashboard tests, Playwright desktop/mobile checks, PHP mailer tests, workflow lint and SAM template lint.
2. Build and retain one cPanel artifact identified by the commit SHA. The artifact contains dashboard, verification page, standalone SDK and PHP mailer code. It excludes the sample harness, mail credentials, state and environment files.
3. Approve the production environment. Validate configuration, load one immutable Systems Manager Parameter Store version, apply an approved backward-compatible MongoDB schema update, and run `release:check` against the matching runtime/policy receipts.
4. Build digest-pinned Node 22 Lambda images with locked dependencies, deploy SAM with CloudFormation rollback enabled, then check worker database/model readiness, API commit identity and CORS.
5. Stage the CI artifact on cPanel over host-key-verified SSH/SCP, validate PHP configuration, atomically switch the shared `current` directory, and run release identity, mailer health and desktop/mobile browser smoke checks. A smoke failure restores the prior cPanel release.

The entire production release is serialized and is not cancelled by newer pushes. Reusable deployment workflows have no independent manual/push trigger. Pull requests run CI without production credentials. AWS OIDC permission exists only on the backend deployment job. The sample harness has a separate manual `demo` artifact build and is never published to production automatically.

## GitHub Configuration

Create a `prod` environment with deployment branches restricted to `main` (and optional required reviewers). Protect `main` with PR reviews and required CI checks (`backend`, `frontend`, `infrastructure`); disable direct unreviewed pushes. Configure the `demo` environment separately and restrict access to its artifacts. These repository settings are not provisioned by workflow YAML.

Set the following GitHub repository variables (or `prod` environment variables, except `API_PUBLIC_URL`, which must also be available at repository scope for CI builds). Do not override the repository API URL with a different environment value: artifact validation will reject it.

| Variable | Required? | Purpose & Default |
| --- | --- | --- |
| `AWS_REGION` | Optional | AWS region, defaults to `us-east-1` |
| `AWS_STACK_NAME` | Optional | SAM stack name, defaults to `verix` (fallback `verifypass` supported) |
| `AWS_PARAMETER_NAME` | Optional | SSM Parameter Store parameter name, defaults to `/verix/production` (fallback `/verifypass/production` supported) |
| `AWS_PARAMETER_VERSION` | Optional | Parameter version; if omitted, automatically fetches the latest version |
| `API_PUBLIC_URL` | Optional | Public API origin. If omitted on initial deploy, auto-detects and smoke-tests the generated Lambda Function URL |
| `HOSTED_BASE_URL` | Optional | Verification subdomain origin; defaults to placeholder until frontend is configured |
| `DASHBOARD_URL` | Optional | Dashboard subdomain origin; defaults to placeholder until frontend is configured |
| `EMAIL_API_URL` | Optional | Mailer subdomain origin; defaults to placeholder until mailer is configured |
| `CORS_ORIGINS` | Optional | Comma-separated allowed origins; defaults to hosted & dashboard URLs |
| `PROVIDER_MODEL_VERSION` | Optional | Biometrics model version label, defaults to `onnx-2026-07` |
| `SCHEMA_CHANGE_APPROVED` | Optional | Approval for schema rollout; defaults to `true` |
| `CPANEL_SSH_HOST` | Required for cPanel | SSH hostname, without protocol or username |
| `CPANEL_SSH_PORT` | Optional | SSH port, defaults to `22` |
| `CPANEL_SSH_USER` | Required for cPanel | Restricted hosting account username |
| `CPANEL_RELEASE_ROOT` | Required for cPanel | One directory name under the account home, e.g. `verix`; no slashes |

GitHub secrets:

- `AWS_DEPLOY_ROLE_ARN`: optional if you store the deploy role ARN as a GitHub variable instead. The workflow accepts either source. Restrict its trust policy audience to `sts.amazonaws.com` and subject to `repo:OWNER/REPO:environment:prod`; environment branch restrictions enforce `main`. Do not grant a repository-wide wildcard subject.
- `CPANEL_SSH_KEY`: dedicated unencrypted deployment key authorized only on the target hosting account. Do not reuse personal keys.
- `CPANEL_KNOWN_HOSTS`: host key verified with your hosting provider out-of-band. Include the bracketed `[hostname]:port` entry for non-default ports. The workflow never trusts a fresh `ssh-keyscan` response automatically.

The deploy role needs scoped CloudFormation/SAM artifact ECR/S3 operations, the required IAM role creation/pass-role permissions for this stack, read access to the configured SSM parameter version (`ssm:GetParameter` and KMS decrypt if applicable), stack descriptions and invocation of this stack's worker. Do not use AdministratorAccess as the final policy. Confirm the exact policy in the target AWS account before deployment.

## Runtime Configuration & Secrets (AWS Systems Manager Parameter Store)

Create the AWS Systems Manager Parameter Store parameter outside Git (type `SecureString` recommended, or `String`). All keys inside the JSON string value are strings:

```bash
aws ssm put-parameter \
  --name "/verix/production" \
  --type "SecureString" \
  --value file://secrets.json
```

- `DATABASE_URL`: TLS MongoDB replica-set or sharded connection string. Set `maxPoolSize` explicitly between 1 and 10, normally 5. `mongodb://` requires `tls=true`; insecure TLS overrides are rejected.
- `SDK_TOKEN_SECRET`, `AUTH_TOKEN_SECRET`, `EMAIL_API_KEY`: independent random values of at least 32 characters. `EMAIL_API_KEY` must match cPanel's mailer HMAC key.
- `EVIDENCE_ENCRYPTION_KEY`: the existing 64-character hex key. Never replace it without an evidence-key migration plan.
- `LIVENESS_VALIDATION_RECEIPTS`: a JSON-array string containing the real matching fingerprints, dataset references and evaluation references. Do not fabricate receipts or bypass the gate.

Generate receipts with the final source digest and the exact production runtime configuration (`VP_PROVIDER=onnx` and the configured `PROVIDER_MODEL_VERSION` included). Changing this code, thresholds, tenant policies, model hashes or relevant runtime settings requires matching evaluation evidence. Update `AWS_PARAMETER_VERSION` to the reviewed parameter version before releasing. Version pinning ensures validation and Lambda resolve the same values.

Lambda has a 4 KB total environment limit. Deployment checks reserve overhead and reject oversized secret/receipt sets. If the tenant count makes receipts exceed this budget, external receipt storage is a required separate migration; do not truncate receipts or weaken validation.

The API retains API-only auth configuration; the worker uses its own SDK signing configuration. Both receive email integration settings. The API concurrency cap is 10; budget database connections for worker bursts as well. One drain invocation handles one job within the 300-second worker timeout; EventBridge remains the queue recovery mechanism. Monitor backlog/queue latency and size worker capacity for your workload.

## AWS Prerequisites

- Docker is required on the build runner even with `sam build --no-use-container`, because these are image-based functions. GitHub-hosted Ubuntu supplies Docker.
- Provision a stable TLS API domain mapped to the Function URL before adopting this pipeline. SAM does not configure your DNS/custom-domain proxy or Atlas networking. The configured public domain must resolve to the new stack before smoke checks can pass.
- Restrict Atlas network access to approved runner/runtime egress. Private Atlas deployments require a runner with appropriate network access; do not solve this with unrestricted public database ingress.
- Back up the database before schema changes. The pipeline uses the backend-pinned Prisma CLI and never passes `--accept-data-loss` or `--force-reset`. A change requiring destructive migration must be handled as a separate reviewed migration. Expand first, release compatible code, and contract later.
- Evidence bucket identity is unchanged and its deletion/replacement policies retain data. A TLS-only bucket policy is added. Existing encryption keys and retention obligations must be preserved.
- Pinned base images and action/tool versions must be refreshed deliberately after security review and regression tests. Pinning gives reproducibility, not indefinite vulnerability protection.

## cPanel Prerequisites

This deployment requires SSH/SCP, Bash, PHP 8.1+, `tar`, Apache rewrite/headers support and symlink-capable document roots. FTPS-only plans cannot provide the implemented atomic switch; arrange SSH support with the host before enabling production. Do not silently revert to in-place uploads.

For account `ACCOUNT` and release root `verix`, map subdomain document roots to:

```text
app.example.com     /home/ACCOUNT/verix/current/dashboard
verify.example.com  /home/ACCOUNT/verix/current/verify
mail.example.com    /home/ACCOUNT/verix/current/mailer/public
```

The hostname origins must match the GitHub variables. These builds use root-relative assets and are not configured for path-prefix hosting such as `example.com/verify/`. Some shared hosts restrict document roots to `public_html` or disallow symlink traversal: get provider confirmation before proceeding. Never expose the entire release root or `mailer` directory as a document root.

Create `/home/ACCOUNT/verix/shared/email-config.php` using the structure in `email-api/config.example.php`. Configure the actual SMTP account, HMAC key, HTTPS dashboard URL and branding; keep `env=production`, `require_https=true`, and `enable_render_endpoint=false`. Set its permissions to `0600`. Set `rate_limit.file` to an absolute path inside the same `shared` directory, which must be writable by the account's PHP process. This preserves replay/rate-limit state across releases and rollbacks.

The deployment never transfers SMTP credentials or overwrites shared configuration. It links each mailer release to the existing private config and validates it before promotion. Health checks verify configuration, not SMTP delivery; run an approved test email after SMTP setup or key rotation. Review-waiting emails currently use an application-level asynchronous notification path; a successful deployment does not certify delivery of every notification.

Configure TLS certificates, CSP and camera Permissions Policy on the real hosts. The verification iframe requires camera delegation from the embedding page. Apache rules disable directory listing, prevent missing models/WASM from becoming HTML, supply the WASM MIME type and route deep links to the app. Do not apply `X-Frame-Options: DENY` to the verification page. Test your actual CSP with ONNX/WASM before release.

## Recovery

- CI/config/schema/release-gate failure: no new Lambda code is deployed. An approved schema synchronization may already have run; compatible additive changes should remain in place.
- CloudFormation deployment failure: normal CloudFormation rollback is enabled; inspect stack events and preserve the retained evidence bucket.
- AWS smoke failure after a successful stack update: cPanel stays on the previous release. Investigate, then redeploy a reviewed known-good commit through the release process with that commit's matching secret version and validation receipts. Application smoke failure does not automatically roll back an otherwise completed CloudFormation update or database changes.
- cPanel smoke failure: the previous shared `current` directory is restored automatically. A failed first release removes the new `current` directory because no previous release exists. Staged releases and archives are retained for diagnosis; prune them under an explicit retention policy, never delete the current release or private shared state.
- Runner termination during promotion: inspect `current` and `incoming/RELEASE.previous`. The remote script supports an ownership-checked rollback: run `bash deploy/cpanel-remote.sh rollback verix RELEASE` as the hosting account. It refuses to undo a newer unrelated release.

No automated sample deployment remains. The manually built demo artifact is for restricted internal testing only; it still offers runtime secret-key entry and must not become a customer-facing production app.

## Local Verification

```sh
node --test deploy/tests/*.test.cjs
npm test
npm run test:sdk --prefix frontend/verify-page
actionlint
cfn-lint backend/template.yaml
sam validate --lint -t backend/template.yaml
```

AWS/cPanel deployment, IAM trust, DNS, Atlas connectivity, PHP host settings, physical-device cameras and SMTP delivery require operator validation in the real environments. No credentials should be pasted into chat, committed, or placed in frontend environment files.
