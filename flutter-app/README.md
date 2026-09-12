# VerifyPass Flutter Integration & Sample App

This directory contains the official **Flutter integration package and sample app** for VerifyPass identity verification, active liveness checks, and face matching.

---

## Features

- **Embedded Hosted Verification Flow**: Seamless in-app WebView integration (`VerifyPassWebView`) with device camera permissions pre-configured for Android and iOS.
- **REST Client (`VerifyPassClient`)**: Dart client to create sessions, poll SDK verification status, and retrieve detailed inspection reports.
- **Dual Flow Modes**:
  1. **Test Harness Mode**: Enter a sandbox secret key (`vp_sec_test_...`) to create sessions directly from Flutter for development and testing.
  2. **Connected Session Mode**: Connect directly to pre-created sessions (`sessionId` + `sdkToken`) simulating a production fintech backend flow.
- **Interactive Result Screen**: Visual outcome badge (`approved`, `manual_review`, `rejected`, `failed`), reason codes, active liveness action breakdown, document OCR extraction, face similarity scores, and raw JSON inspection.

---

## Architecture & Security Guidelines

> [!IMPORTANT]
> **Production Architecture**:
> In a production deployment, **never store or expose your secret key in the mobile application**.
> 1. Your mobile app calls your **fintech backend** (e.g. `POST /api/kyc/start`).
> 2. Your backend calls VerifyPass API `POST /v1/verification-sessions` with your `Bearer vp_sec_...` secret key.
> 3. Your backend returns `{ sessionId, sdkToken }` to the Flutter app.
> 4. Flutter launches `VerifyPassWebView` with the session ID and SDK token.
> 5. When verification completes, the app receives the redirect callback and verifies the outcome with your backend.

---

## Platform Permissions

### Android (`android/app/src/main/AndroidManifest.xml`)

Camera and internet permissions are required:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET"/>
    <uses-permission android:name="android.permission.CAMERA"/>
    <uses-feature android:name="android.hardware.camera" android:required="false"/>
    <uses-feature android:name="android.hardware.camera.autofocus" android:required="false"/>

    <application
        ...
        android:usesCleartextTraffic="true"> <!-- Needed for local HTTP dev testing -->
```

### iOS (`ios/Runner/Info.plist`)

Camera usage description is required:

```xml
<key>NSCameraUsageDescription</key>
<string>VerifyPass requires camera access for identity verification and liveness checks.</string>
<key>NSMicrophoneUsageDescription</key>
<string>Camera microphone access if needed for video capture.</string>
```

### macOS Desktop (`macos/Runner/*.entitlements` and `Info.plist`)

macOS apps run in the Apple App Sandbox by default. Network client and camera entitlements are required:

```xml
<!-- DebugProfile.entitlements & Release.entitlements -->
<key>com.apple.security.network.client</key>
<true/>
<key>com.apple.security.device.camera</key>
<true/>
```

```xml
<!-- macos/Runner/Info.plist -->
<key>NSCameraUsageDescription</key>
<string>VerifyPass requires camera access for identity verification and liveness checks.</string>
```

---

## How to Run the Sample App

### 1. Start VerifyPass Backend & Hosted Verification

In the root directory:

```bash
# Start backend API (port 3000), worker, and hosted verify-page (port 5174)
npm start
# or: node scripts/start-all.js
```

### 2. Launch the Flutter Application

In this `flutter-app` directory:

```bash
# Fetch dependencies
flutter pub get

# Run on macOS desktop
flutter run -d macos

# Or run on Chrome
flutter run -d chrome

# Or run on connected Android emulator / iOS simulator
flutter run
```

> **Network Note for Android Emulator**:
> - The Android emulator accesses the host machine at `http://10.0.2.2`.
> - The app automatically defaults API Base to `http://10.0.2.2:3000` and Hosted Base to `http://10.0.2.2:5174` on Android.

---

## Quick Integration Guide

To use VerifyPass in your own Flutter project:

### 1. Add Dependency (`pubspec.yaml`)

```yaml
dependencies:
  flutter:
    sdk: flutter
  verifypass_flutter:
    path: ../flutter-sdk
```

### 2. Launch Verification Flow

```dart
import 'package:verifypass_flutter/verifypass_flutter.dart';

// 1. Obtain session credentials from your backend
final session = VerificationSession(
  sessionId: 'vps_sample123',
  sdkToken: 'vp_tok_sample456',
  verificationType: 'ID_AND_FACE',
  raw: {},
);

// 2. Launch one-line modal verification flow:
final outcome = await VerifyPass.startVerification(
  context,
  session: session,
  hostedBaseUrl: 'https://verify.yourdomain.com',
  apiBaseUrl: 'https://api.yourdomain.com',
  title: 'Identity Verification',
);

// Or embed the widget directly inside your own UI:
VerifyPassView(
  session: session,
  hostedBaseUrl: 'https://verify.yourdomain.com',
  redirectUrl: 'verifypass://complete',
  onComplete: (sessionId, status) {
    print('Verification finished: $status for session $sessionId');
  },
  onError: (error) {
    print('Verification error: $error');
  },
)
```

---

## Testing

Run static analysis and unit tests:

```bash
flutter analyze
flutter test
```
