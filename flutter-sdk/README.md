# VerifyPass Flutter SDK (`verifypass_flutter`)

The official Flutter SDK for **VerifyPass** identity verification, active liveness detection, and biometric face matching.

This SDK allows fintech and enterprise mobile applications to embed VerifyPass verification with just a few lines of code, offering both a **one-line modal flow** (`VerifyPass.startVerification`) and a **composable embedded widget** (`VerifyPassView`).

---

## Table of Contents

1. [Architecture & Security](#architecture--security)
2. [Installation](#installation)
3. [Platform Configuration](#platform-configuration)
   - [Android Setup](#android-setup)
   - [iOS Setup](#ios-setup)
   - [macOS Setup](#macos-setup)
4. [Integration Guide](#integration-guide)
   - [Option A: One-Line Modal Flow (Recommended)](#option-a-one-line-modal-flow-recommended)
   - [Option B: Embedded Widget (`VerifyPassView`)](#option-b-embedded-widget-verifypassview)
   - [Option C: REST API Client (`VerifyPassClient`)](#option-c-rest-api-client-verifypassclient)
5. [Handling Outcomes & Reason Codes](#handling-outcomes--reason-codes)
6. [Complete Host App Integration Example](#complete-host-app-integration-example)

---

## Architecture & Security

> [!IMPORTANT]
> **Production Security Architecture**:
> Never store or bundle your VerifyPass **Secret Key** (`vp_sec_...`) in a mobile application binary.
> 
> ```
> ┌────────────────┐          ┌────────────────┐          ┌────────────────┐
> │   Mobile App   │          │  Your Backend  │          │   VerifyPass   │
> │ (Flutter SDK)  │          │  (Node/Python) │          │     Server     │
> └───────┬────────┘          └───────┬────────┘          └───────┬────────┘
>         │  1. Request KYC           │                           │
>         │──────────────────────────>│                           │
>         │                           │  2. POST /sessions        │
>         │                           │     (Bearer vp_sec_...)   │
>         │                           │──────────────────────────>│
>         │                           │  3. Returns sessionId     │
>         │                           │     & sdkToken            │
>         │                           │<──────────────────────────│
>         │  4. Returns sessionId     │                           │
>         │     & sdkToken            │                           │
>         │<──────────────────────────│                           │
>         │                                                       │
>         │  5. Launch VerifyPass Flow (In-App Camera & Checks)   │
>         │──────────────────────────────────────────────────────>│
>         │  6. Flow Complete / Webhook Notification              │
>         │<──────────────────────────────────────────────────────│
> ```
> 
> 1. Your mobile app requests a verification session from **your backend**.
> 2. Your backend calls VerifyPass API (`POST /v1/verification-sessions`) using your secret key.
> 3. Your backend returns only the `{ sessionId, sdkToken }` to the mobile app.
> 4. The Flutter SDK runs the verification flow using the client `sdkToken`.

---

## Installation

Add `verifypass_flutter` to your `pubspec.yaml`:

### Option 1: Path Dependency (Monorepo or Local Checkout)
```yaml
dependencies:
  flutter:
    sdk: flutter
  verifypass_flutter:
    path: ../flutter-sdk
```

### Option 2: Git Dependency
```yaml
dependencies:
  flutter:
    sdk: flutter
  verifypass_flutter:
    git:
      url: https://github.com/your-org/verifypass.git
      path: flutter-sdk
```

Then fetch packages:
```bash
flutter pub get
```

---

## Platform Configuration

Camera access is required for ID document capture and active liveness checks.

### Android Setup

Open `android/app/src/main/AndroidManifest.xml` and add the permissions before the `<application>` tag:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <!-- Required permissions -->
    <uses-permission android:name="android.permission.INTERNET"/>
    <uses-permission android:name="android.permission.CAMERA"/>
    <uses-feature android:name="android.hardware.camera" android:required="false"/>
    <uses-feature android:name="android.hardware.camera.autofocus" android:required="false"/>

    <application
        ...
        android:usesCleartextTraffic="true"> <!-- Optional: required only for local HTTP dev -->
```

### iOS Setup

Open `ios/Runner/Info.plist` and add camera and microphone usage descriptions:

```xml
<key>NSCameraUsageDescription</key>
<string>Camera access is required for identity verification and liveness checks.</string>
<key>NSMicrophoneUsageDescription</key>
<string>Microphone access may be used during verification capture.</string>
```

### macOS Setup (if targeting macOS Desktop)

macOS apps run in the **Apple App Sandbox** by default. Outgoing network requests and camera access must be enabled in both `macos/Runner/DebugProfile.entitlements` and `macos/Runner/Release.entitlements`:

```xml
<dict>
    <key>com.apple.security.app-sandbox</key>
    <true/>
    <!-- Required for outgoing API calls -->
    <key>com.apple.security.network.client</key>
    <true/>
    <!-- Required for camera capture -->
    <key>com.apple.security.device.camera</key>
    <true/>
</dict>
```

And in `macos/Runner/Info.plist`:
```xml
<key>NSCameraUsageDescription</key>
<string>Camera access is required for identity verification.</string>
```

---

## Integration Guide

### Option A: One-Line Modal Flow (Recommended)

Use `VerifyPass.startVerification` to launch a full-screen, branded verification modal route. It handles camera permissions, hosted session navigation, cancellation dialogs, and background polling automatically.

```dart
import 'package:flutter/material.dart';
import 'package:verifypass_flutter/verifypass_flutter.dart';

Future<void> launchVerification(BuildContext context) async {
  // 1. Obtain credentials from your fintech backend
  final session = VerificationSession(
    sessionId: 'vps_94a73b18c',
    sdkToken: 'vp_tok_live_8f0a2...',
    verificationType: 'ID_AND_FACE',
    raw: {},
  );

  // 2. Launch the verification flow
  final result = await VerifyPass.startVerification(
    context,
    session: session,
    hostedBaseUrl: 'https://verify.yourdomain.com', // or dev: http://10.0.2.2:5174
    apiBaseUrl: 'https://api.yourdomain.com',       // or dev: http://10.0.2.2:3000
    title: 'Verify Your Identity',
  );

  // 3. Handle the outcome
  if (result == null) {
    print('User cancelled the flow');
    return;
  }

  if (result.isApproved) {
    print('✅ Verification Approved!');
  } else if (result.isManualReview) {
    print('⏳ Manual Review Required.');
  } else {
    print('❌ Verification Failed / Rejected: ${result.status}');
    print('Reason codes: ${result.reasonCodes}');
  }
}
```

---

### Option B: Embedded Widget (`VerifyPassView`)

If you want to place the verification experience inside your own custom stepper, page view, or container, embed `VerifyPassView`:

```dart
import 'package:flutter/material.dart';
import 'package:verifypass_flutter/verifypass_flutter.dart';

class KycStepWidget extends StatelessWidget {
  final VerificationSession session;

  const KycStepWidget({super.key, required this.session});

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 600,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Colors.grey.shade300),
      ),
      clipBehavior: Clip.antiAlias,
      child: VerifyPassView(
        session: session,
        hostedBaseUrl: 'https://verify.yourdomain.com',
        onComplete: (sessionId, status) {
          print('Completed: $status for session $sessionId');
        },
        onError: (error) {
          print('Error in verification: $error');
        },
      ),
    );
  }
}
```

---

### Option C: REST API Client (`VerifyPassClient`)

The SDK provides `VerifyPassClient` for direct REST API communication (e.g. status polling or dev harnesses):

```dart
import 'package:verifypass_flutter/verifypass_flutter.dart';

final client = VerifyPassClient(apiBaseUrl: 'https://api.yourdomain.com');

// Check current session status using end-user SDK token
final status = await client.getStatus(
  sessionId: 'vps_sample_123',
  sdkToken: 'vp_tok_abc_456',
);
print('Status: ${status.status}');

// Wait for a terminal outcome (polls until terminal status or timeout)
final finalStatus = await client.waitForResult(
  sessionId: 'vps_sample_123',
  sdkToken: 'vp_tok_abc_456',
  timeout: const Duration(minutes: 5),
);
```

---

## Handling Outcomes & Reason Codes

The `VerificationStatusResponse` object provides convenience getters:

| Property | Type | Description |
|---|---|---|
| `status` | `String` | Raw status string: `approved`, `manual_review`, `rejected`, `failed`, `expired` |
| `isTerminal` | `bool` | `true` if the session has reached a final state |
| `isApproved` | `bool` | `true` if document, liveness, and face match all passed |
| `isManualReview`| `bool` | `true` if images require human reviewer inspection |
| `isRejected` | `bool` | `true` if verification failed or was rejected |
| `reasonCodes` | `List<String>`| Safe actionable reason codes returned to the user |

Common User-Safe Reason Codes:
- `LIVENESS_FAILED`: Liveness check failed (e.g. photo of photo, spoof detected).
- `LIVENESS_CHALLENGE_INCOMPLETE`: User did not complete required head movements.
- `LIVENESS_CHALLENGE_EXPIRED`: Time limit expired during movement challenge.
- `DOCUMENT_EXPIRED`: The provided ID document has expired.
- `DOCUMENT_SUSPECT`: Document authenticity check flagged an issue.

---

## Complete Host App Integration Example

Here is a full copy-pasteable Flutter example showing how another application integrates VerifyPass:

```dart
import 'package:flutter/material.dart';
import 'package:verifypass_flutter/verifypass_flutter.dart';

void main() {
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Fintech App KYC',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF6D28D9)),
        useMaterial3: true,
      ),
      home: const KycHomeScreen(),
    );
  }
}

class KycHomeScreen extends StatefulWidget {
  const KycHomeScreen({super.key});

  @override
  State<KycHomeScreen> createState() => _KycHomeScreenState();
}

class _KycHomeScreenState extends State<KycHomeScreen> {
  String? _status;

  Future<void> _startVerification() async {
    // 1. In production, request credentials from your backend:
    // final response = await http.post(Uri.parse('https://yourapp.com/api/kyc/start'));
    // final data = jsonDecode(response.body);
    
    // Example session object:
    final session = VerificationSession(
      sessionId: 'vps_sample_demo_123',
      sdkToken: 'vp_tok_demo_456',
      verificationType: 'ID_AND_FACE',
      raw: {},
    );

    // 2. Launch verification sheet
    final outcome = await VerifyPass.startVerification(
      context,
      session: session,
      hostedBaseUrl: 'https://verify.yourdomain.com',
      apiBaseUrl: 'https://api.yourdomain.com',
      title: 'Identity Verification',
      primaryColor: const Color(0xFF6D28D9),
    );

    if (outcome != null) {
      setState(() {
        _status = outcome.status;
      });

      if (outcome.isApproved) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Verification Successful! 🎉')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Account Verification')),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.shield_outlined, size: 72, color: Color(0xFF6D28D9)),
              const SizedBox(height: 16),
              const Text(
                'Complete Identity Verification',
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 8),
              const Text(
                'Verify your government ID and take a quick selfie to secure your account.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.black54),
              ),
              const SizedBox(height: 24),
              if (_status != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: Text(
                    'Last Result: $_status',
                    style: const TextStyle(fontWeight: FontWeight.bold),
                  ),
                ),
              ElevatedButton.icon(
                onPressed: _startVerification,
                icon: const Icon(Icons.camera_alt_outlined),
                label: const Text('Start Verification'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF6D28D9),
                  foregroundColor: Colors.white,
                  padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
```
