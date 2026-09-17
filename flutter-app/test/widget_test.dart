import 'package:flutter_test/flutter_test.dart';
import 'package:verifypass_sample/main.dart';
import 'package:verifypass_flutter/verifypass_flutter.dart';

void main() {
  group('VerifyPass Models and Logic', () {
    test('VerificationSession builds hosted URL correctly', () {
      final session = VerificationSession(
        sessionId: 'vps_test123',
        sdkToken: 'vp_tok_abc456',
        attemptId: 'att_001',
        verificationType: 'ID_AND_FACE',
        raw: {},
      );

      final uri = session.buildHostedUri(
        'https://verify.example.com',
        redirectUrl: 'verifypass://complete',
      );

      expect(uri.scheme, 'https');
      expect(uri.host, 'verify.example.com');
      expect(uri.path, '/session/vps_test123');
      expect(uri.fragment, contains('t=vp_tok_abc456'));
      expect(uri.fragment, contains('r=verifypass%3A%2F%2Fcomplete'));
    });

    test('VerificationStatusResponse parses status and reason codes', () {
      final json = {
        'success': true,
        'sessionId': 'vps_sample',
        'status': 'approved',
        'attemptId': 'att_123',
        'decision': {
          'status': 'approved',
          'reasonCodes': ['DOCUMENT_AUTHENTIC', 'LIVENESS_CONFIRMED'],
        },
      };

      final res = VerificationStatusResponse.fromJson(json);
      expect(res.isTerminal, isTrue);
      expect(res.isApproved, isTrue);
      expect(res.isRejected, isFalse);
      expect(res.reasonCodes, contains('LIVENESS_CONFIRMED'));
    });

    test('VerificationResult parses full report correctly', () {
      final json = {
        'success': true,
        'sessionId': 'vps_sample_999',
        'status': 'approved',
        'riskLevel': 'LOW',
        'customerReference': 'cust_01',
        'decision': {
          'status': 'approved',
          'reasonCodes': [],
        },
        'document': {
          'status': 'passed',
          'ocrConfidence': 0.98,
          'extractedData': {'fullName': 'John Doe', 'documentNumber': 'A12345678'},
        },
        'liveness': {
          'status': 'live',
          'score': 0.95,
          'selfieScore': 0.92,
          'activeStatus': 'checked',
        },
        'faceMatch': {
          'status': 'matched',
          'similarityScore': 0.94,
        },
      };

      final result = VerificationResult.fromJson(json);
      expect(result.isApproved, isTrue);
      expect(result.riskLevel, 'LOW');
      expect(result.documentStatus, 'passed');
      expect(result.ocrConfidence, 0.98);
      expect(result.extractedData?['fullName'], 'John Doe');
      expect(result.livenessScore, 0.95);
      expect(result.selfieScore, 0.92);
      expect(result.faceMatchScore, 0.94);
      expect(result.meetsSixtyPercentThreshold, isTrue);
      expect(result.shouldPromptRetry, isFalse);
    });

    test('VerificationResult enforces >60% auto-approve and <=60% retry', () {
      final autoApprove = VerificationResult(
        success: true,
        sessionId: 'vps_pass',
        status: 'manual_review',
        reasonCodes: ['LIVENESS_BORDERLINE'],
        livenessScore: 0.65,
        selfieScore: 0.70,
        raw: {},
      );
      expect(autoApprove.meetsSixtyPercentThreshold, isTrue);
      expect(autoApprove.shouldPromptRetry, isFalse);
      expect(autoApprove.effectiveStatus, 'approved');

      final needsRetryLiveness = VerificationResult(
        success: true,
        sessionId: 'vps_fail_1',
        status: 'approved', // even if raw status was approved, score below 60% prompts retry
        reasonCodes: [],
        livenessScore: 0.58,
        selfieScore: 0.75,
        raw: {},
      );
      expect(needsRetryLiveness.meetsSixtyPercentThreshold, isFalse);
      expect(needsRetryLiveness.shouldPromptRetry, isTrue);
      expect(needsRetryLiveness.effectiveStatus, 'retry_required');

      final needsRetrySelfie = VerificationResult(
        success: true,
        sessionId: 'vps_fail_2',
        status: 'manual_review',
        reasonCodes: [],
        livenessScore: 0.85,
        selfieScore: 0.52,
        raw: {},
      );
      expect(needsRetrySelfie.meetsSixtyPercentThreshold, isFalse);
      expect(needsRetrySelfie.shouldPromptRetry, isTrue);
      expect(needsRetrySelfie.effectiveStatus, 'retry_required');
    });
  });

  group('VerifyPass App Widget Smoke Test', () {
    testWidgets('App renders Home Screen with VerifyPass header', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(const VerixSampleApp());
      await tester.pumpAndSettle();

      expect(find.text('Verix'), findsOneWidget);
      expect(find.text('Start a Verification'), findsOneWidget);
      expect(find.text('Start Verification (SDK Modal)'), findsOneWidget);
    });
  });
}
