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

The sample application is a local integration harness. Its manually entered secret-key session-creation flow is not a production architecture. Build-time `VP_SECRET_KEY` injection has been removed; never deploy the harness as your customer verification experience.

## Hosting And Lifecycle

- Serve the hosted page, models and WASM asset over HTTPS. Serve deep links such as `/session/vps_...` through the application entry point, but do not rewrite missing model or WASM files to HTML.
- Allow the trusted API origin in CSP `connect-src`; configure backend CORS for the actual application origin. Permit only required scripts, models and frames. Test the WASM CSP requirements in your target browsers.
- Cross-origin embeds require camera permission delegation through the embedding page's Permissions Policy. Do not serve the Vite development server in production.
- Keep `hostedBaseUrl` under operator control: the iframe receives a short-lived token in its fragment. Protocol validation is not a domain allowlist.
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