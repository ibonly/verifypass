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
      expect(result.faceMatchScore, 0.94);
    });
  });

  group('VerifyPass App Widget Smoke Test', () {
    testWidgets('App renders Home Screen with VerifyPass header', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(const VerifyPassSampleApp());
      await tester.pumpAndSettle();

      expect(find.text('VerifyPass'), findsOneWidget);
      expect(find.text('Start a Verification'), findsOneWidget);
      expect(find.text('Start Verification (SDK Modal)'), findsOneWidget);
    });
  });
}
