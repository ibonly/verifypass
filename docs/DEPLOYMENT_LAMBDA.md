# Serverless deployment (AWS Lambda + SAM)

> **The deployed configuration** (template.yaml + .github/workflows/deploy-aws.yml):
> BOTH the API and the worker run as Lambda container images with
> **QUEUE_BACKEND=db** — the `job_queue` table stays the source of truth,
> preserving the retry semantics, dashboards and tooling you already have.
>
> - **API**: Express wrapped by serverless-http (`backend/api.lambda.js`),
>   exposed via a Lambda Function URL. ⚠️ Lambda caps request bodies at
>   ~6MB → effective binary image cap ≈ 4MB via base64 uploads (camera
>   captures are ~0.1–1MB; only large manual file uploads are affected).
> - **Worker**: invoked, not polling. The API async-"kicks" a `drain` after
>   every immediate enqueue (verifications start in seconds) and EventBridge
>   drains every minute as the guarantee. Drains claim rows with the same
>   optimistic update as the polling worker and reclaim stale locks first,
>   so overlapping/killed drains are safe.
> - **Deploy**: GitHub Actions `deploy-aws` workflow — OIDC role (no static
>   AWS keys), tests must pass, `sam build && sam deploy`, then
>   `prisma migrate deploy` and a `/health` smoke check.
>   Required repo secrets: AWS_DEPLOY_ROLE_ARN, DATABASE_URL, API_PUBLIC_URL,
>   SDK_TOKEN_SECRET, AUTH_TOKEN_SECRET, EVIDENCE_ENCRYPTION_KEY.
>
> The SQS topology below remains available as an alternative
> (QUEUE_BACKEND=sqs) for higher volumes.

The verification worker can run as an SQS-triggered Lambda instead of a
polling process. At ~1,000 verifications/month the compute lands inside
Lambda's permanent free tier (each verification ≈ 15s × 2GB = 30 GB-s;
free tier = 400,000 GB-s/month → free until ≈ 13k verifications/month).

Everything is opt-in behind two env flags — **defaults are unchanged**
(local disk + DB queue), so the dev stack, VPS and cPanel deployments keep
working exactly as before.

## Topology

```
Browser SDK ──► API (anywhere: VPS/cPanel/Fargate)
                 │  EVIDENCE_BACKEND=s3   → encrypted objects to S3/R2/B2
                 │  QUEUE_BACKEND=sqs     → job messages to SQS
                 ▼
               SQS ──► Lambda (this image) ──► MySQL + S3 + tenant webhooks
               EventBridge Scheduler ──► Lambda (crons: expire/retention)
```

- Evidence is AES-256-GCM encrypted **before** upload — the bucket only ever
  holds ciphertext. Bucket must still be private + SSE enabled (defense in depth).
- SQS visibility timeout replaces the polling worker's claim/reclaim logic.
- Webhook retries beyond SQS's 900s delay cap use the built-in delay ladder
  (messages carry `notBefore`; early deliveries re-hop automatically).
- The stuck-submitted watchdog runs on the `expire_sessions` cron as a
  safety net for lost/exhausted messages.

## Steps

1. **Bucket** (S3 with SSE-KMS, or Cloudflare R2 / Backblaze B2 via
   `S3_ENDPOINT`): private, no public access, lifecycle rule optional
   (retention is enforced by the app).
2. **Queue**: standard SQS queue + a dead-letter queue (maxReceiveCount 5).
   Set visibility timeout ≥ 6× the function timeout (AWS guidance).
3. **Database**: MySQL reachable from Lambda (public RDS with TLS +
   IP allowlist, or VPC-attached Lambda — note VPC needs NAT for S3/SQS
   unless you add gateway endpoints).
4. **Build + push the image** (from repo root, on x86_64 or with buildx):
   ```bash
   npm run models:fetch
   docker build -f backend/Dockerfile.worker -t verifypass-worker .
   docker tag verifypass-worker:latest <acct>.dkr.ecr.<region>.amazonaws.com/verifypass-worker:latest
   docker push <acct>.dkr.ecr.<region>.amazonaws.com/verifypass-worker:latest
   ```
5. **Function**: create from the image. MemorySize **2048–3008** (Lambda CPU
   scales with memory; ONNX needs it), Timeout **120s**, env vars per the
   Dockerfile comment. Attach the SQS trigger with
   `ReportBatchItemFailures` enabled and batch size 1–5.
6. **Crons**: two EventBridge Scheduler rules invoking the function directly:
   `{"type":"expire_sessions"}` every 5 min, `{"type":"retention_cleanup"}`
   hourly.
7. **API side**: set `EVIDENCE_BACKEND=s3`, `S3_BUCKET`, `S3_REGION`
   (+`S3_ENDPOINT` for R2/B2), `QUEUE_BACKEND=sqs`, `SQS_QUEUE_URL` and give
   the API's role/user s3:PutObject + sqs:SendMessage. Install the optional
   deps: `npm i @aws-sdk/client-s3 @aws-sdk/client-sqs`.
8. **IAM for the function** (least privilege): s3 Get/Put/DeleteObject on the
   bucket prefix, sqs Receive/Delete/SendMessage on the queue, plus logs.

## Alarms (minimum viable)

- DLQ depth > 0 (a verification died 5 times — page someone)
- Lambda Errors > 0 over 15 min
- Duration p95 near timeout

## Mixed/rollback modes

- Reads dispatch on the storagePath scheme, so old local-disk rows stay
  readable after switching to S3 (relevant only if the worker still runs
  where those files exist). For a clean cutover, flip `EVIDENCE_BACKEND=s3`
  first, let retention age out local files, then move the worker.
- Rollback = unset the two env flags and start the polling worker again.
  Nothing about the DB schema changed.

## Cost at 1,000 verifications/month

Lambda + SQS + EventBridge: $0 (free tiers). S3: pennies. CloudWatch logs:
<$1. The remaining bill is wherever MySQL and the API live.
