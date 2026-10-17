# VerifyPass Vue Sample (third-party integration)

A standalone Vue 3 application that embeds the VerifyPass **`<verifypass-liveness>`** web component the way an external customer would. The only VerifyPass dependency is `@verifypass/sdk-js`, downloaded from the public repository [github.com/ibonly/verifypass](https://github.com/ibonly/verifypass). It does not import anything from this monorepo's working tree, so you can copy this folder anywhere and it still works.

The app needs no React, no ONNX Runtime, no model files, no Vite plugins and no API relay. The element bundles its runtime. It loads the face models and WASM from the VerifyPass hosted origin and calls the VerifyPass API directly.

For architecture, the security model and troubleshooting, see the **[implementation guide](docs/IMPLEMENTATION.md)**.

## How it fits together

```text
Browser (Vue 3)                         Your server (server/verifypassApi.mjs)        VerifyPass
───────────────                         ───────────────────────────────────────       ──────────
POST /api/verification-sessions  ─────▶ Bearer VERIFYPASS_SECRET_KEY  ─────────────▶ POST /v1/verification-sessions
      ◀── { sessionId, sdkToken } ◀────
<verifypass-liveness> ─────────────────────── sdkToken ─────────────────────────────▶ API: challenge, captures, status
                      ─────────────────────── models + WASM (cached, checksummed) ──▶ hosted origin
vp-complete ──▶ GET /api/verification-sessions/:id/result ──▶ Bearer secret ───────▶ GET …/result (server-verified)
```

- **`src/components/VerifyPassWidget.vue`**: a thin wrapper. It imports `@verifypass/sdk-js/element`, maps props to the element's attributes and properties, and re-emits its `vp-*` DOM events as Vue events (`complete`, `error`, `step-change`, `telemetry`).
- **`server/verifypassApi.mjs`**: the backend half. It holds the secret key, creates sessions, returns only `{ sessionId, sdkToken }`, and reads the server-verified result. The Vite dev/preview servers mount it as middleware, and `server/index.mjs` mounts it in production.
- **`src/App.vue`**: the host page. It starts a session, keeps the widget mounted for retryable outcomes, and confirms the final outcome with the server, because widget events are UI hints, not proof.

## Installing the SDK

`npm run sdk:fetch` (`scripts/fetch-sdk.mjs`) resolves a git ref on `ibonly/verifypass` to a commit and vendors `frontend/sdk/js` into `vendor/verifypass/js`. That folder holds the prebuilt bundles and types. The exact commit is recorded in `vendor/verifypass/SOURCE.json`. `package.json` depends on `file:vendor/verifypass/js`, and `.npmrc` sets `install-links=true`, so npm copies it into `node_modules` like a registry install.

```bash
VERIFYPASS_SDK_REF=<tag-or-commit-sha> npm run sdk:fetch
```

Without a build step, a page can also load the element straight from the hosted origin:

```html
<script src="https://<hosted-verification-origin>/sdk/v1/verifypass-liveness.js"></script>
```

## Run locally

Requires Node.js 20.12+ and `tar`.

```bash
cp .env.example .env          # then set VERIFYPASS_SECRET_KEY=vp_sec_test_…
npm run setup                 # sdk:fetch + npm install
npm run dev                   # http://localhost:5176
```

Browsers treat `localhost` as a secure context, so the camera works over plain HTTP in development.

## Production

```bash
npm run build
npm start                     # serves dist/ + /api on PORT (default 8080)
```

Serve over HTTPS and keep `VERIFYPASS_SECRET_KEY` in the server environment only. In a real app, the `/api` routes must authenticate your user, derive `customerReference` from that user, and check that a session belongs to the user before returning its result. If you set a Content Security Policy, allow the VerifyPass API and hosted origins in `connect-src`, and add `'wasm-unsafe-eval'` to `script-src`.

## Configuration

| Variable | Where | Purpose |
| --- | --- | --- |
| `VERIFYPASS_SECRET_KEY` | server only | Creates sessions and reads results. Never prefix with `VITE_`. |
| `VERIFYPASS_API_BASE` | server only | VerifyPass API origin. Defaults to the live test API. |
| `PORT` | server only | Port for `npm start`. |
| `VITE_VP_PUBLIC_KEY` | browser | Optional public key. When unset, the widget uses token-only auth. |
| `VITE_VP_API_BASE` | browser | Optional API override for dev proxies or legacy tokens. v1 tokens carry their API origin. |

## Vite note

The only build setting is in `vite.config.js`: Vue is told that `verifypass-*` tags are custom elements (`compilerOptions.isCustomElement`).
