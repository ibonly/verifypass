# VerifyPass SDK

The fastest browser integration is the `<verifypass-liveness>` web component. The SDK also includes a React widget (`@verifypass/react`), a headless controller (`@verifypass/sdk-core`), and a hosted iframe embed (`@verifypass/sdk-js`). Verification decisions remain server-authoritative.

## Quick start: web component

You need a VerifyPass **secret key** on your server, a deployed VerifyPass **API origin**, and a **hosted verification origin** that serves `/sdk/v1/verifypass-liveness.js`. Use HTTPS for the page and both origins; `localhost` is suitable for local camera testing.

### 1. Create a session on your server

After authenticating your user, call VerifyPass with your secret key. Return only `sessionId` and `sdkToken` to the browser. The following Express handlers assume your app supplies `requireUser`, `req.user.id`, and two database helpers: `saveVerificationSessionOwner(sessionId, userId)` and `sessionBelongsToUser(sessionId, userId)`.

```js
const apiBase = process.env.VERIFYPASS_API_BASE; // e.g. https://api.example.com
const secretKey = process.env.VERIFYPASS_SECRET_KEY; // vp_sec_...; server only

app.post("/api/verification-sessions", requireUser, async (req, res) => {
  const upstream = await fetch(`${apiBase}/v1/verification-sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      customerReference: String(req.user.id),
      verificationType: "ID_AND_FACE" // or FACE_ONLY / ID_ONLY
    })
  });
  if (!upstream.ok) return res.status(502).json({ error: "Could not start verification" });
  const { sessionId, sdkToken } = await upstream.json();
  await saveVerificationSessionOwner(sessionId, req.user.id);
  res.json({ sessionId, sdkToken });
});

app.get("/api/verification-sessions/:id/result", requireUser, async (req, res) => {
  if (!(await sessionBelongsToUser(req.params.id, req.user.id))) return res.sendStatus(404);
  const upstream = await fetch(
    `${apiBase}/v1/verification-sessions/${encodeURIComponent(req.params.id)}/result`,
    { headers: { Authorization: `Bearer ${secretKey}` } }
  );
  if (!upstream.ok) return res.status(502).json({ error: "Could not read verification result" });
  res.json(await upstream.json());
});
```

Set `VERIFYPASS_API_BASE` and `VERIFYPASS_SECRET_KEY` in your **server** environment. Implement the two database helpers against your user and session records. Never send the secret key to the browser.

### 2. Mount the widget in your page

Load the bundle from your hosted verification origin. The session token tells the SDK which API to use, so a normal integration needs no browser API URL or public key.

```html
<script src="https://<hosted-verification-origin>/sdk/v1/verifypass-liveness.js"></script>
<button id="start-verification">Verify identity</button>
<div id="verification"></div>
<p id="verification-message" role="status"></p>
<script>
  document.querySelector("#start-verification").addEventListener("click", async () => {
    const message = document.querySelector("#verification-message");
    try {
      const response = await fetch("/api/verification-sessions", { method: "POST" });
      if (!response.ok) throw new Error("Could not start verification");
      const { sessionId, sdkToken } = await response.json();

      const widget = document.createElement("verifypass-liveness");
      widget.setAttribute("session-id", sessionId);
      widget.setAttribute("sdk-token", sdkToken);
      widget.addEventListener("vp-complete", async () => {
        const resultResponse = await fetch(
          `/api/verification-sessions/${encodeURIComponent(sessionId)}/result`
        );
        if (!resultResponse.ok) {
          message.textContent = "Could not confirm the result. Please try again.";
          return;
        }
        const result = await resultResponse.json();
        message.textContent = `Verification status: ${result.status}`;
      });
      widget.addEventListener("vp-error", (event) => {
        message.textContent = event.detail.message;
      });
      document.querySelector("#verification").replaceChildren(widget);
    } catch (error) {
      message.textContent = error.message;
    }
  });
</script>
```

The `vp-complete` event is a UI notification. Grant access only after your server confirms an `approved` result (or receives and verifies a webhook); `manual_review` is not approval. The widget handles capture, consent, upload, polling, retries, and optional phone QR handoff.

### Approved webhook payload

Set `customerReference` to your application's user or session ID when creating the verification session. Approved webhooks return that value as `userSessionId`, alongside the VerifyPass `sessionId`:

```json
{
  "event": "verification.approved",
  "sessionId": "vps_...",
  "userSessionId": "your-user-or-session-id",
  "status": "approved",
  "createdAt": "2026-10-16T15:02:00.000Z",
  "selfieUrl": "https://<api-origin>/v1/dashboard/evidence/<evidence-id>/image?token=<signed-token>"
}
```

Verify the webhook signature before trusting the result. Fetch `selfieUrl` from your server promptly: its bearer token expires after 15 minutes, and the image is served only while the evidence is retained. The URL is regenerated on delivery retries, so consume the URL from the current request. New approved events contain `selfieUrl` instead of `selfieBase64`; do not log or expose the URL to the browser. `userSessionId` is `null` if no `customerReference` was supplied. Failed liveness sends `verification.failed` with `status: "rejected"`; the explicit test button sends `webhook.test`.

Retries of older approved deliveries are upgraded when the original verification result identifies its consumed selfie. If that evidence is unavailable, the delivery is marked `skipped` instead of forwarding an incomplete or mismatched image.

**Using a bundler?** Import `@verifypass/sdk-js/element` instead of loading the script. These packages are currently installed from this repository or a vendored copy; they are not published to npm. See the [standalone Vue sample](../../vue-sample/README.md) for a complete external install and server integration. For React, see [React integration](#integration-options) below.

## Optional public application configuration

For custom API routing or model hosting, put public settings in the consuming Vite application's `.env`, for example `frontend/verify-page/.env` or `sample-app/.env`. The quick start above does not require them. Use `frontend/.env.example` as the template; the shared frontend directory is not the Vite environment root. Restart development or rebuild production after changing these values.

```dotenv
VITE_VP_API_BASE=https://api.example.com
VITE_VP_PUBLIC_KEY=vp_pub_test_REPLACE_WITH_PUBLIC_KEY
VITE_VP_FACE_MODEL_URL=/models/fr_detect.onnx
VITE_VP_LANDMARK_MODEL_URL=/models/fr_landmark.onnx
```

All `VITE_*` values are public and embedded in browser JavaScript. Never put a secret API key, SMTP credential, signing key, encryption key, database credential, session token, or user identity data in these settings. Store server credentials in your backend environment. Create sessions on your authenticated server and return only the session ID and short-lived SDK token needed by the browser.

```jsx
import { VerifyPassProvider, VerificationWidget } from "@verifypass/react";

export function Verification({ sessionId, sdkToken, onComplete }) {
  return (
    <VerifyPassProvider>
      <VerificationWidget sessionId={sessionId} sdkToken={sdkToken} onComplete={onComplete} />
    </VerifyPassProvider>
  );
}
```

The provider reads public Vite configuration by default. Explicit props override configured values, including `publicKey={null}` for token-only hosted authentication. Non-Vite integrations can pass an `env` object containing the allowlisted settings, or explicit provider props. `readPublicConfig(env)` is also exported by the core package. No environment loader runs in a browser.

The API URL can be omitted for server-issued self-locating tokens. Explicit trusted API configuration takes precedence. Decoding a token's API URL does not authenticate the token: obtain tokens from your server, not arbitrary external input. HTTPS is required except on loopback development hosts. URLs containing credentials, queries or fragments are rejected. Existing build-time `VP_API_BASE` remains supported by the hosted/sample Vite configurations.

## Integration options

Pick one. None of them needs model files, WASM configuration, bundler plugins, React (except option 2) or an API relay. The face models and the ONNX Runtime WASM are served by the hosted verification origin (`HOSTED_BASE_URL`), verified against pinned SHA-256 digests, and cached in the browser. The browser SDK API routes accept CORS from any origin; they authenticate with the per-session token header, never cookies.

1. **Web component, any framework or plain HTML.** `@verifypass/sdk-js` ships self-contained bundles with zero runtime dependencies.

   ```html
   <script src="https://<hosted-origin>/sdk/v1/verifypass-liveness.js"></script>
   <!-- or: import "@verifypass/sdk-js/element"; -->
   <verifypass-liveness session-id="vps_…" sdk-token="sdk_v1_…" primary-color="#0F766E"></verifypass-liveness>
   <script>
     const el = document.querySelector("verifypass-liveness");
     el.addEventListener("vp-complete", (e) => confirmOnServer(e.detail.sessionId));
     el.addEventListener("vp-error", (e) => console.warn(e.detail.code, e.detail.message));
   </script>
   ```

   Attributes: `session-id` and `sdk-token` (required). Optional: `public-key`, `base-url`, `mobile-handoff` (`true` = QR only, `false` = this device only, absent = user chooses), `screen-flash="false"`, `primary-color`, `logo-url`, `consent-copy`, `theme` and `copy` (JSON, also settable as properties), `face-model-url` / `landmark-model-url` (`off` disables), `ort-wasm-url`. Events: `vp-complete`, `vp-error`, `vp-step-change`, `vp-telemetry`. They bubble and cross the shadow boundary. Vue needs `compilerOptions.isCustomElement: (t) => t.startsWith("verifypass-")`. Angular needs `CUSTOM_ELEMENTS_SCHEMA`. A playground is served at `/sdk/v1/playground.html`.

2. **React.** `@verifypass/react` ships prebuilt ESM (`dist/index.mjs`, no JSX), so webpack, Next.js, Rollup and Vite consume it as-is. `<VerifyPassProvider>` is optional.

   ```jsx
   <VerificationWidget sessionId={id} sdkToken={token} theme={{ primaryColor: "#0F766E" }} copy={{ consent: { title: "Before we start" } }} onComplete={…} onError={…} />
   ```

3. **Headless React.** `useVerification(props)` returns the full state machine (step, framing guidance, liveness phase, handoff QR) and actions (`capture`, `recordConsent`, `retry`, …). Bind `videoRef` to your own `<video>` and render any UI. `<VerificationWidget>` is built on it.

4. **Headless, any framework.** `createVerificationController({ sessionId, sdkToken, onComplete, onError })` from `@verifypass/sdk-core` or `@verifypass/sdk-js` owns the session lifecycle: challenge, consent, liveness frame budget, uploads, submit and polling, retry, reissue and mobile handoff. `subscribe(fn)` delivers state. You supply frames through `runCapture((capture) => capture.document(base64) | capture.livenessFrame(…) | capture.face(…))`. `createFaceDetector` and `runCaptureLoop` provide the same auto-capture engine the widget uses.

5. **Hosted embed.** `VerifyPass.init({ container, sessionId, sdkToken })` (`dist/verifypass.js`) embeds the hosted page in an iframe or shows a QR handoff.

**Theming.** All colours, the font and the radius are `--vp-*` CSS custom properties: `--vp-primary`, `--vp-on-primary`, `--vp-surface`, `--vp-text`, `--vp-muted`, `--vp-subtle`, `--vp-border`, `--vp-success`, `--vp-warning`, `--vp-danger`, `--vp-pill-bg`, `--vp-font`, `--vp-radius`. Set them on any ancestor (they inherit into the shadow root), or pass `theme` (`primaryColor`, `onPrimaryColor`, `surfaceColor`, `backgroundColor`, `textColor`, `mutedColor`, `borderColor`, `successColor`, `warningColor`, `dangerColor`, `fontFamily`, `borderRadius`, `logoUrl`).

**Text and localisation.** Every string lives in `DEFAULT_COPY`. Pass a partial `copy` object to override any of it; entries that take arguments accept a string or a function. Overriding the consent statement makes you responsible for its audit trail.

**Types.** All three packages ship TypeScript declarations. `@verifypass/sdk-js` types are self-contained.

**Errors.** Every `onError` / `vp-error` receives a `VerifyPassError` with a stable `code`, a readable `message` and the original error as `cause`. API errors keep their server code (for example `SESSION_EXPIRED`). Client codes: `CAMERA_PERMISSION_DENIED`, `CAMERA_NOT_FOUND`, `CAMERA_IN_USE`, `CAMERA_UNSUPPORTED`, `CAMERA_ERROR`, `NETWORK_ERROR`, `REQUEST_TIMEOUT`, `POLLING_TIMEOUT`, `INVALID_RESPONSE`, `INIT_FAILED`, `UNSUPPORTED_WORKFLOW`, `CAPTURE_FAILED`, `UNKNOWN_ERROR`. If the face model cannot load, capture falls back to motion detection, a `face_model_load_failed` telemetry event is emitted, and the console warns once.

**CSP.** Allow the API and hosted origins in `connect-src`, add `'wasm-unsafe-eval'` to `script-src`, and add the hosted origin to `script-src` when loading the CDN bundle.

**Building.** `dist/` of `react` and `js` is committed because the SDK is installed from git. After changing SDK source, run `npm run build --prefix frontend/sdk/react` and `npm run build --prefix frontend/sdk/js`. `npm test` fails when either `dist/` is stale, or when the pinned ONNX Runtime version or WASM checksum (`react/src/assets.js`) drifts from the installed package. The monorepo apps alias `@verifypass/react` to `src/`. Asset precedence for the detector: explicit URL, then the bundler asset (Vite builds of `src/`), then the hosted origin.

## Consent and screen flash

The widget gates capture behind a single consent statement, recorded server-side together with a `copyVersion` string so audits know exactly which wording the user accepted. Overriding `consentCopy` therefore means you own the audit trail for that wording.

The screen-flash liveness step has no separate opt-in checkbox. It is disclosed inside the one consent statement, and it is skipped automatically for users whose browser reports `prefers-reduced-motion: reduce` — that is the photosensitivity escape hatch, and the capture is still reviewable without the flash. Tenants that must disable the step outright pass `screenFlash={false}`.

Changing the shipped consent wording requires bumping `CONSENT_COPY_VERSION` in `react/src/copy.js`; the current value is `2026-10-09.1`.

## Mobile handoff (QR code)

The widget can hand verification to the user's phone instead of running it on the desktop. `mobileHandoff` on `<VerificationWidget>` is tri-state:

| Value | Behaviour |
| --- | --- |
| omitted | The widget decides. The consent screen shows a **Show QR code** call to action, and the QR screen offers **Use this device instead**. |
| `true` | QR handoff only; the desktop consent gate is skipped entirely. |
| `false` | This device only; no QR option is shown. |

Omitting the prop is the drop-in default: an integration that only mounts the widget gets the phone option with no code changes.

```jsx
{/* Drop-in: the user chooses on the consent screen. */}
<VerificationWidget sessionId={sessionId} sdkToken={sdkToken} onComplete={onComplete} />

{/* Force the QR handoff. */}
<VerificationWidget
  sessionId={sessionId}
  sdkToken={sdkToken}
  mobileHandoff
  onComplete={onComplete}
/>
```

Pass `mobileHandoff={false}` on any surface that is itself the capture device — the hosted verification page does this so a scanned QR cannot re-issue another single-use handoff token for a session already being captured.

```js
// Vanilla / CDN bundle (dist/verifypass.js)
VerifyPass.init({
  container: "#verification",
  sessionId,
  sdkToken,
  mobileHandoff: true,
  onComplete: (result) => { /* … */ },
  onError: (error) => { /* … */ }
});
```

Both integrations accept `onTelemetry(event)` for handoff UX diagnostics. Events contain only a fixed event type, failure stage, and error class; URLs, session IDs, and credentials are never included. Supported handoff events are `mobile_handoff_qr_failed`, `mobile_handoff_link_copied`, and `mobile_handoff_copy_failed`.

The flow then becomes `mobile → processing → complete` for every verification type. The desktop shows a QR code the user scans with their phone camera; the phone opens the **hosted verification page** in its browser, records its own consent, and performs the capture there. The desktop never acquires a camera — it polls `/status` until the session reaches a terminal outcome, then calls `onComplete`.

The QR payload is the hosted URL `<hostedBaseUrl>/session/<sessionId>#h=<handoffToken>`. The handoff token is separate from the desktop SDK credential, expires after five minutes (or when the session expires, whichever comes first), and can be claimed once. Claiming it issues a mobile-only SDK credential while the desktop retains its credential for status polling. The hosted page removes the token from the address bar after claiming it and keeps the mobile credential in session storage for same-tab refreshes.

The fragment is not included in HTTP requests or normal server access logs, but the QR and copied link are still bearer credentials until claimed. Treat them like passwords: do not share, screenshot, log, or send them to analytics. The widget exposes a copy-link and open-on-this-device fallback, labels the credential as private, and allows QR generation to be retried.

`getChallenge()` returns `hostedBaseUrl`, `handoffToken`, `handoffExpiresAt`, and the session `expiresAt`. `VerifyPassClient.getHostedUrl()` builds the URL in one place and rejects credentials, queries, fragments, insecure non-loopback URLs, and missing handoff credentials. Polling follows the server-provided session expiry instead of a shorter client-only timeout.

The phone's user records their own biometric consent; the desktop skips its consent gate in this mode. Two retry affordances remain on the desktop in handoff mode: a **Retry** link in the mobile step re-arms polling after a failed poll (no server call, so a transient network blip does not burn a retry attempt), and the result screen's **Try again** reopens the session server-side (audit-logged, attempt-capped) after a rejected, failed, or manual-review outcome. The vanilla bundle reports outcomes through `onComplete`; re-init for a fresh session.

The sample application is a local integration harness. Its manually entered secret-key session-creation flow is not a production architecture. Build-time `VP_SECRET_KEY` injection has been removed; never deploy the harness as your customer verification experience.

## Hosting And Lifecycle

- Serve the hosted page, models and WASM asset over HTTPS. Serve deep links such as `/session/vps_...` through the application entry point, but do not rewrite missing model or WASM files to HTML.
- Allow the trusted API origin in CSP `connect-src`; configure backend CORS for the actual application origin. Permit only required scripts, models and frames. Test the WASM CSP requirements in your target browsers.
- Cross-origin embeds require camera permission delegation through the embedding page's Permissions Policy. Do not serve the Vite development server in production.
- Keep `hostedBaseUrl` under operator control: hosted URLs carry short-lived credentials in their fragments. Protocol validation is not a domain allowlist.
- A self-locating credential and an explicitly configured API URL must identify the same API deployment. Mismatches fail closed instead of sending a valid credential to the wrong environment.
- Call `destroy()` on vanilla embeds and `dispose()` on direct clients at teardown. React handles camera/client/model cleanup and remounts when the session, token, API base or public key changes.
- Browser callbacks are UI notifications, not proof of verification. Confirm outcomes through your backend or verified webhooks before granting access.
- Standard detector/landmark filenames use pinned checksums. Custom model filenames need an explicit digest when using the core cache API; use trusted immutable assets. Downloads default to 15 seconds and 32 MiB; the widget cancels model startup after 12 seconds (30 seconds when the WASM comes from the hosted origin, since its first download is ~3.7 MB gzipped).

## Validation

From the repository root:

```sh
npm test
npm run test:sdk --prefix frontend/verify-page
npm run build --prefix frontend/sdk/js
npm run build --prefix frontend/verify-page
npm run build --prefix sample-app
```

Install browser binaries once with `frontend/verify-page/node_modules/.bin/playwright install chromium`. Browser tests start their own loopback Vite server on port 5187 and use synthetic API/camera data plus the local ONNX models. They cover desktop/mobile-sized Chromium, not physical iOS/Android camera behavior.

See `PRODUCTION_REVIEW.md` for findings, verification and remaining release gates.
