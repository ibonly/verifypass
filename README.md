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
sample-app/    integration demo (cPanel)
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
node scripts/dev-stack.js                # API :3000 + worker + seeded tenant
```

## Tests

`cd backend && npm test` (API + worker + shared) · `cd frontend/sdk/core && npm test`

## Deploy

- **Backend → AWS Lambda**: `.github/workflows/backend-deploy.yml` (SAM, OIDC).
  Manual trigger; secrets: AWS_DEPLOY_ROLE_ARN, DATABASE_URL, API_PUBLIC_URL,
  SDK_TOKEN_SECRET, AUTH_TOKEN_SECRET, EVIDENCE_ENCRYPTION_KEY.
- **Frontend + sample-app → cPanel**: path-filtered FTPS workflows;
  secrets: CPANEL_FTP_SERVER/USERNAME/PASSWORD, VP_API_BASE.
