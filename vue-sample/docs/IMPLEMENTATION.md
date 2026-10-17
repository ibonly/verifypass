# VerifyPass Vue Sample: Implementation Guide

This document explains how `vue-sample/` is built and why. It is for engineers who want to run and extend the sample, reproduce the integration in their own app, or review the security model before shipping. For the quick start, see [../README.md](../README.md).

## 1. Purpose and constraints

The sample is a **third-party integration**: a company that is not VerifyPass adds identity verification to its Vue 3 app.

| Constraint | How it is met |
| --- | --- |
| Only use what an external customer could use | The SDK comes from the public repository `ibonly/verifypass` at a pinned commit. Nothing is imported from sibling folders. |
| No framework or asset coupling | `<verifypass-liveness>` is a framework-free custom element with its runtime bundled. The face models and ONNX Runtime WASM are served by the VerifyPass hosted origin. |
| Secret key never reaches the browser | A small Node server holding `VERIFYPASS_SECRET_KEY` creates sessions and reads results. The browser receives only `{ sessionId, sdkToken }`. |
| Don't trust browser callbacks | The final decision shown comes from a server-side result lookup, not from the `vp-complete` event. |

## 2. Architecture

```text
Browser (http://localhost:5176)
  Vue 3 app (src/App.vue)
    ├─ src/lib/api.js ─────────────────────► /api/*  (this app's server: session create + result)
    └─ <VerifyPassWidget> → <verifypass-liveness> (shadow DOM)
          ├─ VerifyPass API (origin from the sdkToken): challenge, consent, captures, status
          └─ VerifyPass hosted origin: /models/*.onnx, /sdk-assets/ort/<version>/*.wasm
```

1. The user clicks **Start verification**. The server calls `POST /v1/verification-sessions` with the secret key and returns `{ sessionId, sdkToken }`.
2. The element fetches the challenge, records consent, runs the capture flow and submits. Every request authenticates with the per-session `X-VP-SDK-Token` header and never with cookies. The VerifyPass API answers CORS for these SDK routes from any origin.
3. Once the challenge is loaded, the element downloads the models and WASM from the hosted origin. They are checked against pinned SHA-256 digests and stored in the browser's Cache Storage. If they cannot load, capture falls back to motion detection and a `vp-telemetry` event with `type: "face_model_load_failed"` is emitted.
4. On `vp-complete`, the app asks its own server for `GET …/result` and shows that decision.

## 3. The wrapper component

`src/components/VerifyPassWidget.vue` imports `@verifypass/sdk-js/element`, which registers the tag on import, and renders it:

| Vue prop | Element binding |
| --- | --- |
| `sessionId`, `sdkToken` | `session-id`, `sdk-token` (required) |
| `publicKey`, `baseUrl` | `public-key`, `base-url` (optional) |
| `mobileHandoff` (tri-state) | `mobile-handoff="true"` / `"false"`, or absent so the user chooses |
| `screenFlash` | `screen-flash` |
| `theme`, `copy` | `.theme` / `.copy` properties (objects) |
| `consentCopy` | `consent-copy` |

The `vp-complete`, `vp-error`, `vp-step-change` and `vp-telemetry` DOM events are re-emitted as `complete`, `error`, `step-change` and `telemetry`. `vp-error` details are `VerifyPassError` objects with a stable `code`. Removing the element from the DOM releases the camera, the ONNX sessions and the polling. Changing the session ID or token remounts the flow.

Theming: pass `theme` (`primaryColor`, `fontFamily`, `borderRadius`, `textColor`, …) or set `--vp-*` CSS custom properties on any ancestor. Text: pass a partial `copy` object, for example `{ consent: { title: "…" } }`.

## 4. Server

`server/verifypassApi.mjs` exposes three routes and is mounted by Vite in development and by `server/index.mjs` in production.

| Route | Purpose |
| --- | --- |
| `GET /api/config` | Reports whether the secret key is configured. |
| `POST /api/verification-sessions` | Creates a session (`customerReference`, `verificationType`). Returns only `sessionId`, `sdkToken`, `expiresAt`, `verificationType`. |
| `GET /api/verification-sessions/:id/result` | Server-verified outcome via the secret key. |

Request bodies are capped at 4 KiB and session IDs are validated. In your app, authenticate the user on these routes and check session ownership.

## 5. Security model

- **Secret key**: server only. The browser never sees it.
- **SDK token**: short-lived and scoped to one session. It is sent in a header, never in a query string. It is the only browser credential.
- **CORS**: the VerifyPass SDK routes allow any origin without credentials. Session creation and results are server-to-server and are not callable from browsers.
- **Assets**: models and WASM are verified by SHA-256 before use. They are fetched without credentials or a referrer.
- **CSP** (if you use one): `connect-src` for the VerifyPass API and hosted origins, and `script-src 'wasm-unsafe-eval'`.
- **Decisions**: browser events are hints. Always confirm via `…/result` or signed webhooks.

## 6. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Failed to fetch` on mount | The VerifyPass API is not reachable from the browser, or it predates SDK-route CORS. Check the network tab for a blocked preflight. |
| `vp-error` with `INIT_FAILED` and "credential does not embed an API origin" | Legacy token: set `VITE_VP_API_BASE`. |
| "Face model unavailable - capture manually" | The hosted origin blocked or failed the model/WASM download (check `vp-telemetry`). Capture still works without it. |
| Camera prompt never appears | Serve over HTTPS (or `localhost`), and allow `camera` in your Permissions-Policy. |
| Vue warns "Failed to resolve component: verifypass-liveness" | Keep `isCustomElement` in `vite.config.js`. |

## 7. Adapting this to your own application

1. Copy `server/verifypassApi.mjs` (or reimplement its three routes) behind your authentication.
2. Install `@verifypass/sdk-js`, or load `https://<hosted-origin>/sdk/v1/verifypass-liveness.js` with a script tag.
3. Render `<verifypass-liveness session-id sdk-token>` and listen for `vp-complete` / `vp-error`.
4. Confirm the decision on your server before granting access.
