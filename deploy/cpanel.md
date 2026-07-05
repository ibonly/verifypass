# cPanel Deployment Notes

## API (`api.` subdomain)

1. cPanel → **Setup Node.js App** (Application Manager / Passenger):
   - Application root: `verifypass/apps/api`
   - Application startup file: `app.js` (exports the Express app — do not use `server.js`; Passenger binds the port)
   - Node version: 18+
2. Deploy the full GitHub repository, not only `apps/api`; workspace packages resolve from the repo root.
3. From the cPanel terminal, run dependency and Prisma commands at the repo root:
   ```bash
   cd ~/verifypass
   npm ci --omit=dev
   npm run prisma:generate -w apps/api
   npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
   ```
   Use plain `npm ci` instead of `--omit=dev` if the same cPanel account also builds dashboard, verify-page, or SDK assets.
4. Set env vars in the Node.js App UI (see `.env.example`). `EVIDENCE_DIR` must point outside `public_html`; production will refuse weak/missing token secrets and invalid evidence keys.
5. Seed first tenant: `cd ~/verifypass/apps/api && node scripts/seedTenant.js "Company Name"`.

## GitHub Actions CI

The repository includes `.github/workflows/ci.yml`. GitHub Actions runs from the repo root with Node 20, `npm ci`, lint, tests, frontend/SDK builds, and Prisma schema validation. Keep deployment to cPanel as a separate pull/publish step after CI is green.

## Static builds

Build static assets before uploading to their cPanel subdomain document roots:

```bash
cd ~/verifypass
npm ci
npm run build -w apps/dashboard
npm run build -w apps/verify-page
npm run build -w packages/sdk-js
```

Publish `apps/dashboard/dist` to `app.`, `apps/verify-page/dist` to `verify.`, and `packages/sdk-js/dist` to `sdk.`.

## Worker

Run `apps/worker/index.js` as a long-lived process. On shared cPanel without
daemon support, use a cron keep-alive:

```
* * * * * cd ~/verifypass/apps/worker && flock -n /tmp/vp-worker.lock node index.js >> ~/logs/worker.log 2>&1
```

When verification load grows (p95 > 15s or sustained CPU > 70%), move this
directory to a VPS — it only needs `DATABASE_URL` and evidence storage access.

## Cron jobs

| Schedule | Command | Purpose |
|----------|---------|---------|
| `*/5 * * * *` | enqueue `expire_sessions` job | expire stale sessions |
| `0 2 * * *` | enqueue `retention_cleanup` job (M5) | delete evidence past retention |
| `0 3 * * *` | mysqldump backup | daily DB backup |

## Subdomains

`api.` → Node app · `app.` → dashboard static build (M4) · `verify.` → hosted page (M2) · `sdk.` → SDK bundle (M2). AutoSSL on all four.

## Sandbox vs production

Create two separate Node apps + databases (e.g. `verifypass_sandbox`, `verifypass_live`). Never share a DB between them.
