# VerifyPass Vue Sample (third-party integration)

A standalone Vue 3 application that embeds the **VerifyPass React SDK** (`@verifypass/react`) the way an external customer would. It does not import anything from this monorepo's working tree. The SDK is downloaded from the public repository [github.com/ibonly/verifypass](https://github.com/ibonly/verifypass), so you can copy this folder anywhere and it still works.

For architecture, API reference, security model, and troubleshooting, see the **[implementation guide](docs/IMPLEMENTATION.md)**.

## How it fits together

```text
Browser (Vue 3)                         Your server (server/verifypassApi.mjs)        VerifyPass API
───────────────                         ───────────────────────────────────────       ──────────────
POST /api/verification-sessions  ─────▶ Bearer VERIFYPASS_SECRET_KEY  ─────────────▶ POST /v1/verification-sessions
      ◀── { sessionId, sdkToken } ◀────
<VerifyPassWidget> ──▶ /v1/verification-sessions/:id/* ── relayed as-is (sdkToken) ──▶ captures / liveness
@complete  ──▶ GET /api/verification-sessions/:id/result ──▶ Bearer secret ──────▶ GET …/result (server-verified)
```

- **`src/components/VerifyPassWidget.vue`**: a Vue component that owns a private React root (`react-dom/client`). It renders `<VerifyPassProvider><VerificationWidget/></VerifyPassProvider>`, re-renders when props change, and unmounts on teardown, which releases the camera and models. Widget callbacks are re-emitted as Vue events: `complete`, `error` and `step-change`.
- **`server/verifypassApi.mjs`**: the backend half. It holds the secret key, creates sessions, and returns only `{ sessionId, sdkToken }` to the browser. It also reads the server-verified result. The Vite dev/preview servers mount it as middleware, and `server/index.mjs` mounts it in production.
- **`server/sdkProxy.mjs`**: a same-origin relay for the widget's own API calls. The VerifyPass API only answers CORS requests from origins on its `CORS_ORIGINS` allowlist, so the widget's `baseUrl` points at this app's origin and these calls go through the server instead. It relays only `GET`/`POST /v1/verification-sessions/:id/<action>`, forwards an allowlist of headers, caps uploads at 25 MiB, and never adds the secret key. The browser's short-lived `X-VP-SDK-Token` stays the only credential.
- **`src/App.vue`**: the host page. It requests camera permission up front, starts a session, and keeps the widget mounted for retryable outcomes (`rejected`, `manual_review`, `failed`). It then confirms the final outcome with the server, because widget callbacks are UI hints, not proof.

## Installing the SDK

`@verifypass/react` is not published to npm, and npm cannot install a sub-folder of a git repository. Instead, `npm run sdk:fetch` (`scripts/fetch-sdk.mjs`) does the following:

1. Resolves a git ref on `ibonly/verifypass` to a commit SHA.
2. Downloads that commit's archive and extracts `frontend/sdk/react` and `frontend/sdk/core` into `vendor/verifypass/`. It also copies the face models into `public/models/`.
3. Records the exact commit in `vendor/verifypass/SOURCE.json`.

`package.json` depends on `file:vendor/verifypass/*`, and `.npmrc` sets `install-links=true`, so npm copies the packages into `node_modules` like a registry install. Both `vendor/` and `public/models/` are git-ignored.

Pin a release or commit with `VERIFYPASS_SDK_REF`:

```bash
VERIFYPASS_SDK_REF=<tag-or-commit-sha> npm run sdk:fetch
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

Serve over HTTPS, and keep `VERIFYPASS_SECRET_KEY` in the server environment only. In a real app, the `/api` routes must authenticate your user. They should also derive `customerReference` from that user and check that a session belongs to the user before returning its result.

Through the relay, VerifyPass sees your server's IP rather than the end user's, which affects per-IP rate limits and recorded client IPs. If that matters for you, ask VerifyPass to add your production origin to `CORS_ORIGINS` and set `VITE_VP_API_BASE` so the widget calls the API directly.

## Configuration

| Variable | Where | Purpose |
| --- | --- | --- |
| `VERIFYPASS_SECRET_KEY` | server only | Creates sessions and reads results. Never prefix with `VITE_`. |
| `VERIFYPASS_API_BASE` | server only | VerifyPass API origin. Defaults to the live test API. |
| `PORT` | server only | Port for `npm start`. |
| `VITE_VP_PUBLIC_KEY` | browser | Optional public key. When unset, the widget uses token-only auth. |
| `VITE_VP_API_BASE` | browser | Optional. Makes the widget call this API origin directly instead of the same-origin relay. Your origin must then be on VerifyPass's `CORS_ORIGINS` allowlist. |
| `VITE_VP_FACE_MODEL_URL` / `VITE_VP_LANDMARK_MODEL_URL` | browser | Model locations (default `/models/…`). |

## Vite notes for Vue + React SDK

The SDK ships untranspiled `.jsx` and a CommonJS core, so `vite.config.js`:

- pre-bundles `@verifypass/react` with `jsx: "automatic"` so all SDK modules share one React context;
- pre-bundles `react`, `react/jsx-runtime`, `react/jsx-dev-runtime` and `react-dom/client`;
- dedupes `react`/`react-dom`.

The ONNX Runtime WASM file is emitted as a hashed asset. `server/index.mjs` returns 404 for missing model/WASM files instead of rewriting them to `index.html`.
