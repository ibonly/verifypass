# VerifyPass Production Deployment & Operations Guide

This document provides a comprehensive, end-to-end guide for provisioning, configuring, deploying, and maintaining VerifyPass in production. It covers the complete architecture across AWS serverless infrastructure, cPanel web hosting, MongoDB Atlas, and GitHub Actions CI/CD automation.

---

## Table of Contents

1. [Architecture & Deployment Topology](#1-architecture--deployment-topology)
2. [Prerequisites Checklist](#2-prerequisites-checklist)
3. [Step 1: MongoDB Database Provisioning](#3-step-1-mongodb-database-provisioning)
4. [Step 2: AWS Secrets Manager & IAM OIDC Setup](#4-step-2-aws-secrets-manager--iam-oidc-setup)
5. [Step 3: cPanel Hosting Account Configuration](#5-step-3-cpanel-hosting-account-configuration)
6. [Step 4: GitHub Actions Variables & Secrets](#6-step-4-github-actions-variables--secrets)
7. [Step 5: Pre-Flight Local Verification](#7-step-5-pre-flight-local-verification)
8. [Step 6: Executing the Production Release](#8-step-6-executing-the-production-release)
9. [Step 7: Automated Deployment Smoke Checks](#9-step-7-automated-deployment-smoke-checks)
10. [Step 8: Rollback & Failure Recovery Procedures](#10-step-8-rollback--failure-recovery-procedures)
11. [Step 9: Maintenance, Monitoring & Key Rotation](#11-step-9-maintenance-monitoring--key-rotation)

---

## 1. Architecture & Deployment Topology

VerifyPass deploys as a hybrid serverless and static/PHP application:

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       VERIFYPASS MONOREPO                                   │
└───────────────┬─────────────────────────────────────────────┬───────────────────────────────┘
                │                                             │
      Push to main branch                           Build immutable artifact
                ▼                                             ▼
┌───────────────────────────────┐             ┌───────────────────────────────────────────────┐
│     AWS SERVERLESS STACK      │             │             cPANEL WEB HOSTING                │
│       (AWS SAM / Lambda)      │             │            (SSH/SCP & Atomic Symlink)         │
├───────────────────────────────┤             ├───────────────────────────────────────────────┤
│ • Express API (Docker Image)  │             │ • Dashboard: app.example.com                  │
│ • Worker Engine (Docker Image)│             │ • Verification: verify.example.com            │
│ • S3 Evidence (Encrypted SSE) │             │ • Mailer API: mail.example.com                │
│ • EventBridge Schedulers      │             │ • Standalone JS SDK: /verify/sdk/verifypass.js│
└───────────────┬───────────────┘             └───────────────────────┬───────────────────────┘
                │                                                     │
                │                Shared MongoDB Atlas                 │
                └─────────────────────────┬───────────────────────────┘
                                          ▼
                         ┌─────────────────────────────────┐
                         │   MongoDB Replica Set (Atlas)   │
                         │    • TLS 1.2+ Enforced          │
                         │    • Transactions Supported     │
                         │    • maxPoolSize: 1 to 10       │
                         └─────────────────────────────────┘
```

### Components:
- **API Function (`backend/Dockerfile.api`)**: Node 22 Lambda image running Express. Handles session creation, telemetry, document/face uploads, and dashboard management APIs.
- **Worker Function (`backend/Dockerfile.worker`)**: Node 22 Lambda image with ONNX Runtime. Executes active-liveness decision engine, facial embedding matching, and ID verification pipelines.
- **Evidence Store (AWS S3)**: Encrypted private bucket storing client-encrypted (AES-256-GCM) biometric frames, with strict TLS-only bucket policies.
- **cPanel Frontend & Mailer**: Hosts the React administrative dashboard, the hosted verification page, the vanilla JavaScript SDK distribution, and the PHP 8.1+ transactional mailer API.
- **CI/CD Orchestrator**: GitHub Actions pipeline (`.github/workflows/release.yml`) orchestrating tests, schema migration, container builds, CloudFormation deployment, and atomic cPanel release promotion.

---

## 2. Prerequisites Checklist

Before executing the deployment, ensure the following prerequisites are met:

- [ ] **Domain Names & DNS**:
  - `api.example.com`: Points to the API Lambda Function URL (or API Gateway / CloudFront / ALB).
  - `app.example.com`: Points to the cPanel server for the dashboard.
  - `verify.example.com`: Points to the cPanel server for the hosted verification flow.
  - `mail.example.com`: Points to the cPanel server for the PHP mailer service.
- [ ] **AWS Account**: Active AWS account with permissions to provision Secrets Manager, IAM roles, S3 buckets, ECR repositories, Lambda functions, and CloudFormation stacks.
- [ ] **cPanel Shared/Dedicated Host**:
  - Direct SSH/SCP access enabled on port 22 (or custom port).
  - PHP 8.1 or higher with `openssl`, `filter`, `json`, and `pcre` extensions.
  - Apache with `mod_rewrite` and `mod_headers` enabled.
  - Symlink-capable filesystem (symlinks allowed in document roots).
- [ ] **MongoDB Cluster**: MongoDB 6.0+ replica set (MongoDB Atlas M10+ recommended for production) with TLS enabled.
- [ ] **GitHub Repository**: Admin access to configure environments, repository variables, and GitHub Actions secrets.

---

## 3. Step 1: MongoDB Database Provisioning

Prisma requires MongoDB to run as a **replica set** to support atomic transactions across sessions, audit logs, and the job queue.

### Connection String Requirements
1. **Protocol**: Must use `mongodb://` or `mongodb+srv://`.
2. **TLS Requirement**: TLS must be verified. If using `mongodb://`, `tls=true` is mandatory. Insecure overrides (`tlsAllowInvalidCertificates=true`, `tlsInsecure=true`, `ssl=false`) are rejected by deployment checks.
3. **Connection Pool Cap**: You **must** explicitly set `maxPoolSize` between `1` and `10` (e.g., `&maxPoolSize=5`) to prevent Lambda container scaling from exhausting database connection limits.

#### Example Production Connection String:
```text
mongodb+srv://verifypass_prod:STRONG_DB_PASSWORD@cluster0.abcde.mongodb.net/verifypass?retryWrites=true&w=majority&maxPoolSize=5
```

### Network Access
- Whitelist the outbound IP addresses of your GitHub Actions runner (or enable temporary security group access) and AWS Lambda egress NAT gateways if using a VPC.
- If using MongoDB Atlas without VPC peering, configure approved IP access lists or AWS IAM database authentication.

---

## 4. Step 2: AWS Systems Manager Parameter Store & IAM OIDC Setup

### 4.1. Create Systems Manager SecureString Parameter
Create an AWS Systems Manager Parameter Store parameter outside Git named `/verifypass/production` (or your chosen naming convention).

All keys must be strings inside a single JSON object:

```json
{
  "DATABASE_URL": "mongodb+srv://verifypass_prod:PASSWORD@cluster0.abcde.mongodb.net/verifypass?retryWrites=true&w=majority&maxPoolSize=5",
  "SDK_TOKEN_SECRET": "32_OR_MORE_CRYPTOGRAPHICALLY_RANDOM_CHARACTERS",
  "AUTH_TOKEN_SECRET": "32_OR_MORE_CRYPTOGRAPHICALLY_RANDOM_CHARACTERS",
  "EMAIL_API_KEY": "32_OR_MORE_CRYPTOGRAPHICALLY_RANDOM_CHARACTERS",
  "EVIDENCE_ENCRYPTION_KEY": "64_HEX_CHARACTERS_EXACTLY_FOR_AES_256_GCM_ENCRYPTION",
  "LIVENESS_VALIDATION_RECEIPTS": "[{\"fingerprint\":\"<MATCHING_FINGERPRINT>\",\"dataset\":\"v1.0-held-out\",\"evaluation\":\"EVAL-REPORT-2026-09\"}]"
}
```

#### Field Specifications:
- `SDK_TOKEN_SECRET`, `AUTH_TOKEN_SECRET`, `EMAIL_API_KEY`: At least 32 cryptographically random characters. Do not use prefixes like `dev-only-` or `change-me-`.
- `EVIDENCE_ENCRYPTION_KEY`: Exactly 64 hex characters (32 bytes) for AES-256-GCM. Generate via:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- `LIVENESS_VALIDATION_RECEIPTS`: JSON-stringified array of evaluation receipts. Each entry maps an effective tenant policy fingerprint to evaluated dataset and report references.
- **Budget Constraint**: The total JSON payload must be under 2,700 bytes to stay within AWS Lambda's 4 KB total environment budget.

#### Provision the Parameter with the AWS CLI:
```bash
aws ssm put-parameter \
  --name "/verifypass/production" \
  --type "SecureString" \
  --value file://secrets.json
```

#### Record the Parameter Name and Version:
1. **Parameter Name**: e.g., `/verifypass/production` (or full ARN: `arn:aws:ssm:us-east-1:123456789012:parameter/verifypass/production`).
2. **Version**: The immutable integer version number (e.g., `1`, `2`). Pinned version IDs guarantee audit reproducibility and prevent accidental runtime configuration drift.

---

### 4.2. Configure AWS IAM OIDC Role for GitHub Actions
Configure GitHub as an OIDC identity provider in AWS IAM, then create a deployment role (`VerifyPassDeployRole`).

#### Trust Policy:
Restrict the trust policy strictly to your repository and the `production` environment:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:YOUR_ORG/YOUR_REPO:environment:prod"
        }
      }
    }
  ]
}
```

#### Permissions Policy:
Attach a policy granting:
- CloudFormation operations for stack `verifypass`
- S3 and ECR operations for SAM deployment artifacts
- IAM `PassRole` and `CreateRole` for the Lambda execution roles defined in `backend/template.yaml`
- SSM Parameter Store `GetParameter` on the specific parameter ARN (and KMS decrypt if using a custom key)
- Lambda `InvokeFunction` on `WorkerFunction` for post-deploy health smoke checks

---

## 5. Step 3: cPanel Hosting Account Configuration

### 5.1. Directory Structure
Log into the cPanel server via SSH under the hosting account (e.g. username `accountuser`) and prepare the release root:

```bash
mkdir -p /home/accountuser/verifypass/incoming
mkdir -p /home/accountuser/verifypass/releases
mkdir -p /home/accountuser/verifypass/shared
chmod 711 /home/accountuser
chmod 755 /home/accountuser/verifypass
chmod 700 /home/accountuser/verifypass/shared
```

### 5.2. Map Subdomain Document Roots
In cPanel > **Domains** (or **Subdomains**), map the document roots to the symlinked `current` paths:

| Subdomain | Document Root in cPanel |
|---|---|
| `app.example.com` | `/home/accountuser/verifypass/current/dashboard` |
| `verify.example.com` | `/home/accountuser/verifypass/current/verify` |
| `mail.example.com` | `/home/accountuser/verifypass/current/mailer/public` |

> **Critical**: Do not set document roots to the entire release root or `/mailer`. Only `/mailer/public` should be accessible to the web.

### 5.3. Configure Shared Email Settings
Create the private configuration file `/home/accountuser/verifypass/shared/email-config.php`:

```bash
nano /home/accountuser/verifypass/shared/email-config.php
```

Add the following configuration:

```php
<?php
return [
    // Must exactly match EMAIL_API_KEY in AWS Secrets Manager
    'api_key' => 'SAME_32_CHAR_KEY_AS_IN_SECRETS_MANAGER',

    'require_https' => true,
    'trusted_proxies' => [],
    'enable_render_endpoint' => false,

    'from'     => ['address' => 'no-reply@example.com', 'name' => 'VerifyPass'],
    'reply_to' => ['address' => 'support@example.com', 'name' => 'VerifyPass Support'],

    'dashboard_url' => 'https://app.example.com',

    'smtp' => [
        'host'     => 'mail.example.com',
        'port'     => 587,
        'secure'   => 'tls',
        'username' => 'no-reply@example.com',
        'password' => 'STRONG_SMTP_PASSWORD',
        'timeout'  => 15,
    ],

    'brand' => [
        'product' => 'VerifyPass',
        'legal'   => 'VerifyPass Inc.',
        'address' => 'Lagos, Nigeria',
        'support' => 'https://example.com/support',
    ],

    'rate_limit' => [
        'max' => 300,
        'windowSeconds' => 3600,
        'file' => '/home/accountuser/verifypass/shared/.security-state'
    ],

    'env' => 'production',
];
```

#### Enforce Permissions:
The file **must** be readable only by the account owner:
```bash
chmod 600 /home/accountuser/verifypass/shared/email-config.php
```
*Note: The cPanel deployment script validates that `email-config.php` has permissions matching `0600` and will fail if group or other permissions are present.*

### 5.4. Generate Dedicated SSH Deployment Key
Generate a dedicated key pair on your deployment machine or workstation:

```bash
ssh-keygen -t ed25519 -C "github-deploy@verifypass" -f ./id_cpanel_deploy -N ""
```

1. Append `id_cpanel_deploy.pub` to `/home/accountuser/.ssh/authorized_keys` on cPanel.
2. Store the private key `id_cpanel_deploy` in GitHub Secret `CPANEL_SSH_KEY`.
3. Capture the verified host key for `CPANEL_KNOWN_HOSTS`:
   ```bash
   ssh-keyscan -p 22 -t ed25519 cpanel.example.com
   ```
   *(For non-default ports, format as `[hostname]:port key-type key`)*.

---

## 6. Step 4: GitHub Actions Variables & Secrets

### 6.1. GitHub Environment: `production`
In GitHub repository settings > **Environments**, create an environment named `production`.
- Enable **Required reviewers** for production deployments.
- Restrict deployment branches strictly to `main`.

### 6.2. GitHub Repository / Environment Variables

Configure the following variables in GitHub (under **Settings > Secrets and variables > Actions**):

| Variable Name | Scope | Example Value | Description |
|---|---|---|---|
| `API_PUBLIC_URL` | **Repository & Environment** | `https://api.example.com` | Exact HTTPS origin of the API (must match across CI and deploy). |
| `HOSTED_BASE_URL` | Environment | `https://verify.example.com` | HTTPS origin of the verification flow. |
| `DASHBOARD_URL` | Environment | `https://app.example.com` | HTTPS origin of the dashboard. |
| `EMAIL_API_URL` | Environment | `https://mail.example.com` | HTTPS origin of the email mailer (without `/send.php`). |
| `CORS_ORIGINS` | Environment | `https://app.example.com,https://verify.example.com` | Comma-separated allowed origins (no wildcards). |
| `AWS_REGION` | Environment | `us-east-1` | Target AWS region. |
| `AWS_STACK_NAME` | Environment | `verifypass` | CloudFormation SAM stack name. |
| `AWS_PARAMETER_NAME` | Environment | `/verifypass/production` | Systems Manager Parameter Store parameter name or ARN. |
| `AWS_PARAMETER_VERSION` | Environment | `1` | Pinned Parameter Store integer version number. |
| `PROVIDER_MODEL_VERSION` | Environment | `onnx-2026-07` | Pinned biometrics model version label. |
| `SCHEMA_CHANGE_APPROVED` | Environment | `true` | Must be `true` to approve backward-compatible Prisma push. |
| `CPANEL_SSH_HOST` | Environment | `cpanel.example.com` | Hostname or IP of the cPanel server. |
| `CPANEL_SSH_PORT` | Environment | `22` | SSH port on the cPanel server. |
| `CPANEL_SSH_USER` | Environment | `accountuser` | cPanel Linux username. |
| `CPANEL_RELEASE_ROOT` | Environment | `verifypass` | Directory name under `/home/accountuser`. |

### 6.3. GitHub Repository Secrets

Configure the following GitHub Secrets:

| Secret Name | Description |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | Full ARN of the IAM OIDC deployment role (e.g. `arn:aws:iam::123456789012:role/VerifyPassDeployRole`). |
| `CPANEL_SSH_KEY` | Private Ed25519 SSH deployment key content. |
| `CPANEL_KNOWN_HOSTS` | Pre-verified `known_hosts` single-line entry. |

---

## 7. Step 5: Pre-Flight Local Verification

Before committing and merging to `main`, run the local validation battery:

```bash
# 1. Run monorepo test suite (backend, SDK core, dashboard, deploy contracts)
npm test

# 2. Run email API security and template self-tests
npm run test:email

# 3. Run Playwright browser verification tests (headless Chromium)
npm run test:playwright

# 4. Run Flutter SDK and Flutter App test suites
npm run test:flutter

# 5. Run static analysis on Flutter code
(cd flutter-sdk && flutter analyze) && (cd flutter-app && flutter analyze)

# 6. Test full monorepo build
npm run build

# 7. Test immutable release artifact packager
GITHUB_SHA=$(git rev-parse HEAD) VITE_VP_API_BASE=https://api.example.com npm run package
rm -f release.tar.gz
```

---

## 8. Step 6: Executing the Production Release

The production release is completely automated and serialized:

```
    Developer PR
         │
         ▼
    Pull Request CI (checks backend, SDK, dashboard, Playwright, mailer)
         │
         ▼
    Merge PR into 'main'
         │
         ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Workflow: .github/workflows/release.yml (concurrency: production-release)│
├────────────────────────────────────────────────────────────────────────┤
│ 1. CI Job:                                                             │
│    • Runs all tests & linters                                          │
│    • Builds frontend apps and packages immutable release.tar.gz        │
│    • Uploads cpanel-${{ github.sha }} artifact                        │
├────────────────────────────────────────────────────────────────────────┤
│ 2. Backend Job (AWS Lambda):                                           │
│    • Environment approval gate ('production')                          │
│    • Assumes AWS_DEPLOY_ROLE_ARN via OIDC                             │
│    • Validates configuration & runtime secret budget                   │
│    • Applies backward-compatible MongoDB schema push                   │
│    • Builds Docker images and deploys SAM stack                        │
│    • Executes AWS smoke tests (Worker health, API commit, CORS)        │
├────────────────────────────────────────────────────────────────────────┤
│ 3. Frontend Job (cPanel):                                              │
│    • Downloads immutable release.tar.gz                                │
│    • Connects via SSH/SCP with host-key verification                   │
│    • Stages release in /home/user/verifypass/releases/<id>             │
│    • Links /shared/email-config.php and lints PHP                      │
│    • Atomically updates /current symlink                               │
│    • Executes cPanel smoke tests (Release JSON, Mailer, Playwright)    │
│    • Automatically rolls back if any check fails                       │
└────────────────────────────────────────────────────────────────────────┘
```

### Steps to Trigger:
1. Open a pull request from `dev` into `main`.
2. Ensure all PR status checks pass.
3. Merge the PR into `main` (or run **Workflow Dispatch** on `.github/workflows/release.yml`).
4. In the GitHub Actions run, designated reviewers must approve the `production` environment prompt.

---

## 9. Step 7: Automated Deployment Smoke Checks

The pipeline automatically validates both tiers before completing promotion:

### AWS Smoke Suite (`deploy/aws.cjs`):
1. **Worker Health & Commit Verification**: Invokes `WorkerFunctionArn` directly with `{"type":"health"}`. Confirms `worker.ok === true` and `worker.release.commit` matches the deployed commit SHA.
2. **Public API Identity**: Fetches `https://api.example.com/health`. Asserts HTTP 200 and commit SHA equality.
3. **CORS Validation**: Sends `OPTIONS` preflight requests from each origin configured in `CORS_ORIGINS` to `POST /v1/verification-sessions`. Verifies `Access-Control-Allow-Origin` matches each exact origin.

### cPanel Smoke Suite (`deploy/cpanel.cjs`):
1. **Release JSON Checks**: Queries `/release.json` on `app.example.com`, `verify.example.com`, and `mail.example.com`. Verifies HTTP 200 and commit SHA equality.
2. **Mailer Health**: Fetches `https://mail.example.com/health.php` and verifies healthy HTTP 200 response.
3. **End-to-End Headless Browser Check**: Launches Playwright in desktop (1280x800) and mobile (390x844) viewports:
   - Navigates to `https://verify.example.com/session/vps_release` and verifies the localized error state renders without unhandled browser runtime errors.
   - Navigates to `https://app.example.com` and asserts `#root` renders content without JavaScript exceptions.

---

## 10. Step 8: Rollback & Failure Recovery Procedures

### Automatic Rollback
- **CloudFormation Rollback**: If SAM deployment fails, AWS CloudFormation automatically rolls back to the previous stack state. The evidence S3 bucket has `DeletionPolicy: Retain` to protect stored data.
- **cPanel Rollback**: If any cPanel smoke check fails after switching the `current` symlink, `deploy/cpanel.cjs` immediately triggers `cpanel-remote.sh rollback`, restoring the prior working release symlink.

### Manual cPanel Rollback
If a deployment runner terminates abruptly during promotion, you can trigger a manual rollback via SSH on the cPanel host:

```bash
ssh -p 22 accountuser@cpanel.example.com
bash /home/accountuser/verifypass/cpanel-remote.sh rollback verifypass <FAILED_RELEASE_IDENTIFIER>
```
*Note: The script verifies that the current symlink points to the specified release before reverting to the prior release recorded in `incoming/<release>.previous`.*

### Restoring Previous AWS Release
To revert AWS Lambda to a previous version:
1. Update `AWS_PARAMETER_VERSION` in GitHub Environment variables to the version number associated with the prior commit.
2. Re-run `.github/workflows/release.yml` on the previous known-good Git commit.

---

## 11. Step 9: Maintenance, Monitoring & Key Rotation

### EventBridge Cron Schedules (AWS Lambda)
The SAM stack configures EventBridge schedules to run automated maintenance against the database:
- **Every 1 minute**: `{"type":"drain"}` — Drains queued verification jobs and acts as a latency fallback.
- **Every 5 minutes**: `{"type":"expire_sessions"}` — Expires overdue `created` and `started` sessions.
- **Every 1 hour**: `{"type":"retention_cleanup"}` — Purges expired evidence files in accordance with tenant data retention policies.

### Monitoring & Logs
- **AWS CloudWatch**:
  - API Logs: `/aws/lambda/verifypass-ApiFunction-...`
  - Worker Logs: `/aws/lambda/verifypass-WorkerFunction-...`
  - CloudWatch Alarms: Monitor 5xx errors, Lambda throttling, and execution duration approaching 300 seconds.
- **cPanel Logs**:
  - Apache error logs: `/usr/local/apache/logs/error_log` or cPanel > **Errors**.
  - Rate limiting state: `/home/accountuser/verifypass/shared/.security-state`.

### Key Rotation Procedures
- **Rotating `EMAIL_API_KEY`**:
  1. Generate a new 32+ character random key.
  2. Update `/home/accountuser/verifypass/shared/email-config.php` on cPanel.
  3. Put a new version of the AWS Systems Manager parameter with the updated `EMAIL_API_KEY`.
  4. Update `AWS_PARAMETER_VERSION` in GitHub and deploy.
- **Rotating `EVIDENCE_ENCRYPTION_KEY`**:
  - **Warning**: Do not rotate `EVIDENCE_ENCRYPTION_KEY` in place without running an offline re-encryption script against existing S3 evidence objects. Old evidence encrypted under the prior key will become unreadable.
- **Rotating Biometrics Models (`PROVIDER_MODEL_VERSION`)**:
  1. Upload new model files and compute SHA-256 digests.
  2. Run calibration dataset evaluation (`node backend/scripts/evaluate-liveness-dataset.js`).
  3. Generate new policy validation receipts and update `LIVENESS_VALIDATION_RECEIPTS` in Parameter Store.
  4. Update `AWS_PARAMETER_VERSION` and `PROVIDER_MODEL_VERSION` variables, then deploy.
