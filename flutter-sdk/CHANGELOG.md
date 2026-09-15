# Changelog

## 1.0.0

* Initial production release of VerifyPass Flutter SDK.
* WebView-based hosted identity verification flow via `VerifyPassVerificationView`.
* Status querying and polling mechanisms (`VerifyPassClient.getStatus` and `pollStatus`).
* Comprehensive data models for sessions, status responses, and audit verification results.
* Enforced >60% auto-approval threshold rule and <=60% retry handling with actionable coaching signals.
* Platform-specific camera, microphone, and hardware acceleration permission integration for Android and iOS.
