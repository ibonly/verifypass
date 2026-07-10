# VerifyPass

Multitenant liveness, face recognition, and ID verification service for Nigerian fintechs.

See `IMPLEMENTATION_PLAN.md` (repo root's parent folder) for architecture decisions and milestones.

## Layout

```
backend/            ONE service: Express API + verification worker
  api.lambda.js       API Lambda entry (serverless-http)
  worker.lambda.js    Worker Lambda entry (drain/crons)
  server.js           API server entry (VPS/cPanel/dev)
  worker.js           Polling worker entry (VPS/cPanel/dev)
  src/                API code; src/worker/ = pipeline, providers, watchdog
frontend/           Deployed to cPanel as static builds
  dashboard/          Tenant + super-admin dashboard (React/Vite)
  verify-page/        Hosted verification flow (React/Vite)
sample-app/         Integration demo app (cPanel)
packages/           Independent libraries
  shared/             Error codes, decision engine, storage, crypto
  sdk-core/           Framework-agnostic SDK internals
  sdk-react/          React widget          sdk-js/  CDN bundle
template.yaml       SAM — backend on AWS Lambda
deploy/             cPanel + Faceplugin deployment notes
scripts/            dev-stack, in-house setup, e2e smoke test
```

## Run the real stack (MySQL + Faceplugin)

This is an in-house, multi-tenant service: one deployment integrates many
internal products, each as its own tenant. It runs on **real MySQL** with the
**real Faceplugin** on-premise Docker services — no stubs, no mock data.

### 1. Prerequisites

- Node 18+
- MySQL 8+ running locally (a `verifypass` database)
- Docker (for the Faceplugin liveness + face-recognition containers)

### 2. Configure & migrate

```bash
npm install
cp .env.example .env            # then edit .env (DATABASE_URL, secrets, EVIDENCE_DIR)
npm run db:generate             # generate Prisma client
npm run db:migrate:dev          # create/apply the schema in MySQL
```

Generate real secrets for `.env`:

```bash
node -e "const c=require('crypto');for(const k of ['SDK_TOKEN_SECRET','AUTH_TOKEN_SECRET'])console.log(k+'='+c.randomBytes(24).toString('hex'));console.log('EVIDENCE_ENCRYPTION_KEY='+c.randomBytes(32).toString('hex'))"
```

### 3. Start Faceplugin (real scoring)

```bash
docker compose -f deploy/faceplugin-compose.yml up -d
# activate each container's license once per machine — see deploy/faceplugin.md
```

Liveness listens on `:8888`, face recognition on `:8889`. Until the containers
are running and licensed, verification jobs **fail closed** (the rest of the
app still works).

### 4. Boot the app

```bash
npm run dev                                                        # API :3000 + real worker + MySQL
VP_API_BASE=http://localhost:3000 npm run dev -w frontend/dashboard    # → :5173
VP_API_BASE=http://localhost:3000 npm run dev -w frontend/verify-page  # → :5174
```

`npm run dev` ensures a demo tenant + admin/reviewer users + API keys exist
(persisted to `.dev-credentials.json`) and prints them. Sign in to the
dashboard at http://localhost:5173.

### 5. End-to-end smoke test

```bash
node scripts/e2e-smoke.js   # create session → upload ID + selfie → verify → poll → result
```

### 6. Sample webcam app (real device camera)

A self-contained tester that uses the **device camera/webcam** via the real
verification widget (ID scan → active-liveness challenge → selfie):

```bash
npm run dev:sample     # → http://localhost:5175
```

Open it, paste a **secret key** from the `npm run dev` output (`vp_sec_…`),
pick a verification type, and click **Start verification**. Grant camera
access when prompted. The app creates the session (standing in for your
backend) and the widget captures on-device; the server makes the decision.
Camera access needs a secure context — `localhost` qualifies.

### Adding a tenant (per internal product)

```bash
node backend/scripts/seedTenant.js "Product Name"   # prints its public/secret keys once
```

## Production (cPanel)

`npm run db:migrate` (deploy), then run the API via Passenger and the worker as
a cron keep-alive. See `deploy/cpanel.md` and `deploy/faceplugin.md`.

## Tests

```bash
npm test        # unit/integration tests (mocked DB — no MySQL needed)
npm run ci      # lint + tests + builds + prisma validate
```

Tenant isolation tests run without a database and must stay green on every change.
