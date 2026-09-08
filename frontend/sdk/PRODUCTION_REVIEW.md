# SDK Production Review

## Scope And Outcome

Reviewed the SDK transport, session flow, camera lifecycle, model cache/inference integration, React widget, vanilla embed, and the hosted/sample environment configuration. Existing numerical capture guidance and server verification thresholds were preserved. This is a targeted source/dependency review with automated regression testing, not a penetration-test certification or a biometric accuracy certification.

## Remediated Findings

| Priority | Finding | Change |
| --- | --- | --- |
| High | Tracked frontend environment example contained private-looking credentials | Replaced with public-only placeholders; removed sample build-time secret-key injection |
| High | Credentialed requests accepted unsafe API destinations and redirect behavior | HTTPS/loopback URL validation, public-key validation, restricted session IDs, redirect rejection, omitted cookies/referrers and no-store requests |
| High | Disposed requests could issue work or accept late responses | Abort guards before requests and after response parsing; React ownership and cancellation guards |
| Medium | Malformed HTTP success bodies could be treated as successful uploads | Require an object containing `success: true` |
| Medium | Polling could exceed its total deadline; callback errors were retried as network failures | Bound status requests by remaining time; propagate observer errors separately |
| Medium | Late camera permission could attach a stale stream; stalled playback could hang | Abortable startup, bounded playback readiness, late-track cleanup and replacement-stream protection |
| Medium | Initialization failures rendered a blank widget | Visible loading/error state and recoverable retry; constructor/workflow errors handled |
| Medium | Manual document-back uploads were sent as front | Bind each file read to its original client/step and upload the correct side |
| Medium | Retry telemetry and configuration transitions could retain obsolete state | Reset per-attempt telemetry, serialize widget retries, remount on session/API identity changes |
| Medium | Old vanilla embed destruction could erase a replacement instance | Container ownership tracking and previous-client cancellation |
| Medium | Hosted URL accepted credentials and unrelated URL suffixes | Reject credentials, query, fragment and ambiguous whitespace/backslash inputs |
| Medium | Model downloads were unbounded and corrupt-cache eviction could prevent recovery | Size/time limits, abort propagation, credential omission, resilient eviction and no unconsumed cloned response |
| Medium | ONNX temporary tensors accumulated and session release could race inference | Tensor cleanup, reusable input buffer, concurrent-run guard and deferred session release |
| Medium | Build dependencies had published advisories | Patched Vite, esbuild and affected transitive packages in SDK consumers |

## Verification

- Repository tests: 529 passing (backend 303, shared 100, SDK 124, dashboard 2).
- Browser regressions: 8 passing across desktop and mobile-sized Chromium.
- Browser coverage: failed initialization/retry, front/back upload and single submit, public environment configuration with explicit override, consent reset on session change, late camera permission cleanup, repeated real ONNX inference and disposal during inference.
- Production builds: standalone SDK, hosted verification page and sample application pass with patched tooling.
- npm audits: zero reported advisories in standalone SDK, React SDK, hosted page and sample application dependency trees at review time.
- Editor diagnostics: no errors reported in the SDK and affected consumers.

## Required Before Release

1. Rotate any real credentials previously used from the tracked frontend example. Removing current content does not remove Git history or invalidate previously exposed credentials. No automatic credential rotation or history rewrite was performed.
2. Configure trusted production API/model/hosted URLs and backend CORS. The self-locating token decoder and hosted URL checks do not establish domain trust. The hosted completion redirect still accepts an HTTPS destination supplied in the link; enforce an approved destination policy in the session/link issuer before distributing links.
3. Use an authenticated server endpoint to create sessions. Do not publish the local sample harness's runtime secret-key workflow. User identity data and session credentials must not be stored in frontend `.env` files.
4. Run real-device iOS Safari and Android Chrome camera/permission/backgrounding tests, including denied permissions, orientation changes, poor networks and consent/flash accessibility. Mobile viewport emulation is not a substitute for hardware testing.
5. Refresh the application's liveness release validation evidence for the changed source digest and run the existing release gates before deployment. Synthetic browser images do not establish biometric accuracy or spoof resistance.
6. Verify production CSP, Permissions Policy, asset caching and deep-link routing on the actual hosting platform. WASM remains approximately 14 MB uncompressed; this review reduces per-frame allocations but does not claim a measured device-level speedup.

No production deployment, registry publication, credential rotation or Git commit was performed. Unrelated user deletions were preserved.