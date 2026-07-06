# VerifyPass Developer Guide

Identity verification for Nigerian fintech onboarding: ID scan + live selfie +
liveness detection + face-to-ID matching, with webhooks and manual review.

**Compliance positioning:** VerifyPass is a KYC identity-assurance layer. It
does not replace your AML program, BVN/NIN validation obligations, or
transaction monitoring. Use its outputs (decision, scores, reason codes) as
inputs to your own CDD process.

## 1. Get keys

Your tenant admin creates keys (or run `node scripts/seedTenant.js` self-hosted).

| Key | Prefix | Use | Where |
|-----|--------|-----|-------|
| Public | `vp_pub_test_` / `vp_pub_live_` | SDK init in browsers | Frontend (safe to expose; domain-allowlisted) |
| Secret | `vp_sec_test_` / `vp_sec_live_` | Server API calls | Backend only. Never ship to clients. |

Sandbox (`test`) and production (`live`) are fully separate.

## 2. Create a verification session (backend)

```js
const res = await fetch("https://api.verifypass.com/v1/verification-sessions", {
  method: "POST",
  headers: { Authorization: "Bearer vp_sec_test_xxx", "Content-Type": "application/json" },
  body: JSON.stringify({
    customerReference: "USER-1001",
    verificationType: "ID_AND_FACE",
    documentTypes: ["NIN_SLIP", "PASSPORT"],
    callbackUrl: "https://yourapp.com/kyc/callback"
  })
});
const { sessionId, sdkToken, hostedUrl, expiresAt } = await res.json();
```

Hand `sessionId` + `sdkToken` to your frontend, **or** just redirect the user
to `hostedUrl` (the token rides in the URL fragment and never reaches server logs).

## 3a. React SDK

```jsx
import { VerifyPassProvider, VerificationWidget } from "@verifypass/react";

<!-- No API URL needed: the sdkToken embeds the environment (sandbox/production)
     of the key that created the session. -->
<VerifyPassProvider publicKey="vp_pub_test_xxx">
  <VerificationWidget
    sessionId={sessionId}
    sdkToken={sdkToken}
    theme={{ primaryColor: "#6D28D9", logoUrl: "https://you.com/logo.png" }}
    onComplete={(result) => submitKyc(result)}
    onError={(err) => console.error(err.code, err.message)}
  />
</VerifyPassProvider>
```

The widget guides capture (blur/lighting feedback), uploads, submits, and
polls until a terminal status.

## 3b. Plain JavaScript

```html
<script src="https://sdk.verifypass.com/v1/verifypass.js"></script>
<div id="verify-root"></div>
<script>
  VerifyPass.init({
    publicKey: "vp_pub_test_xxx",
    sessionId, sdkToken,
    container: "#verify-root",
    onComplete: (result) => { /* ... */ }
  });
</script>
```

## 4. Retrieve the result (backend, secret key)

`GET /v1/verification-sessions/{sessionId}/result`

```json
{
  "success": true,
  "sessionId": "vps_01JABC123",
  "status": "approved",
  "riskLevel": "low",
  "document": { "status": "valid", "ocrConfidence": 0.94, "extractedData": { "fullName": "ADEBAYO JOHN" } },
  "liveness": { "status": "passed", "score": 0.97 },
  "faceMatch": { "status": "matched", "similarityScore": 0.91 },
  "decision": { "status": "approved", "reasonCodes": [] },
  "completedAt": "2026-07-04T19:12:00Z"
}
```

## 5. Webhooks

Configure once (secret key): `PUT /v1/webhooks/config {"url": "https://yourapp.com/hooks/verifypass"}`
→ returns your signing `secret` (`whsec_...`) **once**. Store it.

Events: `verification.approved`, `verification.rejected`, `verification.manual_review`,
`verification.expired`, `verification.failed`.

Verify every delivery:

```js
const crypto = require("crypto");

function verify(req, secret) {
  const ts = Number(req.headers["x-verifypass-timestamp"]);
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false; // replay guard
  const expected = "sha256=" + crypto.createHmac("sha256", secret)
    .update(`${ts}.${req.rawBody}`).digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(req.headers["x-verifypass-signature"]),
    Buffer.from(expected)
  );
}
```

Failed deliveries retry automatically: 1m, 5m, 30m, 2h, 12h. Inspect with
`GET /v1/webhooks/deliveries`; force with `POST /v1/webhooks/{eventId}/retry`.

## 6. Decision statuses and reason codes

| Status | Meaning | Your action |
|--------|---------|-------------|
| `approved` | All checks passed tenant thresholds | Continue onboarding |
| `rejected` | Hard failure (spoof, mismatch, no face) | Deny; allow fresh attempt per your policy |
| `manual_review` | Borderline — queued for your reviewers | Wait for reviewer webhook |
| `expired` / `abandoned` / `failed` | Session never completed | Create a new session |

Reason codes: `LIVENESS_FAILED`, `LIVENESS_BORDERLINE`, `FACE_MATCH_FAILED`,
`FACE_MATCH_BORDERLINE`, `NO_FACE_ON_SELFIE`, `NO_FACE_ON_DOCUMENT`,
`MULTIPLE_FACES_DETECTED`, `DOCUMENT_OCR_FAILED`, `DOCUMENT_EXPIRED`,
`DOCUMENT_IMAGE_LOW_QUALITY`.

Error codes (HTTP): see `packages/shared/src/errorCodes.js` — stable strings
like `INVALID_API_KEY` (401), `SESSION_EXPIRED` (410), `RATE_LIMITED` (429).

## 7. Manual review

Reviewers use the dashboard (`app.verifypass.com`) with their own accounts
(TOTP MFA supported). Decisions (`approved` / `rejected` / `recapture`) fire
the same webhooks. `recapture` reopens the session so the same link/widget
can capture again.

## 8. Data retention & deletion

Defaults: raw images 30 days; results/audit 5–7 years; failed sessions 7 days.
To honor a data-subject erasure request:

`DELETE /v1/customers/{customerReference}/biometric-data`

Removes all evidence images and strips extracted ID data; retains
scores/decision metadata for compliance. Audit-logged.

## 9. Rate limits

300 req/min per IP (global), 60 captures/min per tenant, 10 login attempts
per 15 min. `429` responses carry `Retry-After`.

## 10. Go-live

Work through `docs/GO_LIVE_CHECKLIST.md`, then swap `test` keys for `live`.
