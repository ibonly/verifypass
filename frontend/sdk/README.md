# VerifyPass SDK

The SDK contains a framework-independent capture/client package (`core`), a React widget (`react`), and a hosted iframe entry point (`js`). Verification decisions remain server-authoritative.

## Public Application Configuration

Put public settings in the consuming Vite application's `.env`, for example `frontend/verify-page/.env` or `sample-app/.env`. Use `frontend/.env.example` as the template; the shared frontend directory is not the Vite environment root. Restart development or rebuild production after changing these values.

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

## Consent and screen flash

The widget gates capture behind a single consent statement, recorded server-side together with a `copyVersion` string so audits know exactly which wording the user accepted. Overriding `consentCopy` therefore means you own the audit trail for that wording.

The screen-flash liveness step has no separate opt-in checkbox. It is disclosed inside the one consent statement, and it is skipped automatically for users whose browser reports `prefers-reduced-motion: reduce` — that is the photosensitivity escape hatch, and the capture is still reviewable without the flash. Tenants that must disable the step outright pass `screenFlash={false}`.

Changing the shipped consent wording requires bumping `CONSENT_COPY_VERSION` in the widget; the current value is `2026-10-09.1`.

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
- Standard detector/landmark filenames use pinned checksums. Custom model filenames need an explicit digest when using the core cache API; use trusted immutable assets. Downloads default to 15 seconds and 32 MiB; the widget cancels model startup after 12 seconds.

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