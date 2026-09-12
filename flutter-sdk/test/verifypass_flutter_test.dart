import 'package:flutter_test/flutter_test.dart';
import 'package:verifypass_flutter/verifypass_flutter.dart';

void main() {
  group('VerificationSession', () {
    test('buildHostedUri formats URL correctly with fragment and redirect', () {
      final session = VerificationSession(
        sessionId: 'vps_sample_123',
        sdkToken: 'vp_tok_test_456',
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
      expect(uri.path, '/session/vps_sample_123');
      expect(uri.fragment, contains('t=vp_tok_test_456'));
      expect(uri.fragment, contains('r=verifypass%3A%2F%2Fcomplete'));
    });
  });

  group('VerificationStatusResponse', () {
    test('correctly identifies terminal and approved states', () {
      final json = {
        'success': true,
        'sessionId': 'vps_abc',
        'status': 'approved',
        'attemptId': 'att_xyz',
        'decision': {
          'status': 'approved',
          'reasonCodes': ['LIVENESS_CONFIRMED'],
        },
      };

      final status = VerificationStatusResponse.fromJson(json);
      expect(status.isTerminal, isTrue);
      expect(status.isApproved, isTrue);
      expect(status.isManualReview, isFalse);
      expect(status.isRejected, isFalse);
      expect(status.reasonCodes, ['LIVENESS_CONFIRMED']);
    });

    test('correctly identifies manual review and rejection', () {
      final reviewJson = {
        'success': true,
        'sessionId': 'vps_review',
        'status': 'manual_review',
        'decision': {'reasonCodes': ['LIVENESS_BORDERLINE']},
      };
      final review = VerificationStatusResponse.fromJson(reviewJson);
      expect(review.isTerminal, isTrue);
      expect(review.isManualReview, isTrue);
      expect(review.isApproved, isFalse);

      final rejectedJson = {
        'success': true,
        'sessionId': 'vps_rej',
        'status': 'rejected',
        'decision': {'reasonCodes': ['FACE_MISMATCH']},
      };
      final rejected = VerificationStatusResponse.fromJson(rejectedJson);
      expect(rejected.isTerminal, isTrue);
      expect(rejected.isRejected, isTrue);
    });
  });

  group('VerificationResult', () {
    test('parses full tenant result payload', () {
      final json = {
        'success': true,
        'sessionId': 'vps_full_123',
        'status': 'approved',
        'riskLevel': 'LOW',
        'decision': {
          'status': 'approved',
          'reasonCodes': ['DOCUMENT_AUTHENTIC'],
        },
        'document': {
          'status': 'passed',
          'ocrConfidence': 0.99,
          'extractedData': {'fullName': 'Jane Doe'},
        },
        'liveness': {
          'status': 'live',
          'score': 0.97,
        },
        'faceMatch': {
          'status': 'matched',
          'similarityScore': 0.95,
        },
      };

      final result = VerificationResult.fromJson(json);
      expect(result.isApproved, isTrue);
      expect(result.riskLevel, 'LOW');
      expect(result.ocrConfidence, 0.99);
      expect(result.extractedData?['fullName'], 'Jane Doe');
      expect(result.livenessScore, 0.97);
      expect(result.faceMatchScore, 0.95);
    });

    test('evaluates >60% auto-approval and <=60% retry rule correctly', () {
      // Both scores > 60% -> auto-approve
      final autoApproveResult = VerificationResult(
        success: true,
        sessionId: 'vps_1',
        status: 'manual_review',
        reasonCodes: ['LIVENESS_BORDERLINE'],
        livenessScore: 0.85,
        selfieScore: 0.72,
        raw: {},
      );
      expect(autoApproveResult.meetsSixtyPercentThreshold, isTrue);
      expect(autoApproveResult.shouldPromptRetry, isFalse);
      expect(autoApproveResult.effectiveStatus, 'approved');
      expect(autoApproveResult.isApproved, isTrue);

      // Liveness score <= 60% -> prompt retry
      final lowLivenessResult = VerificationResult(
        success: true,
        sessionId: 'vps_2',
        status: 'manual_review',
        reasonCodes: ['LIVENESS_FAILED'],
        livenessScore: 0.55,
        selfieScore: 0.80,
        raw: {},
      );
      expect(lowLivenessResult.meetsSixtyPercentThreshold, isFalse);
      expect(lowLivenessResult.shouldPromptRetry, isTrue);
      expect(lowLivenessResult.effectiveStatus, 'retry_required');

      // Selfie score <= 60% -> prompt retry
      final lowSelfieResult = VerificationResult(
        success: true,
        sessionId: 'vps_3',
        status: 'rejected',
        reasonCodes: ['LIVENESS_FAILED'],
        livenessScore: 0.75,
        selfieScore: 0.58,
        raw: {},
      );
      expect(lowSelfieResult.meetsSixtyPercentThreshold, isFalse);
      expect(lowSelfieResult.shouldPromptRetry, isTrue);
      expect(lowSelfieResult.effectiveStatus, 'retry_required');
    });
  });

  group('VerificationType', () {
    test('resolves from value correctly', () {
      expect(
        VerificationType.fromValue('ID_AND_FACE'),
        VerificationType.idAndFace,
      );
      expect(
        VerificationType.fromValue('FACE_ONLY'),
        VerificationType.faceOnly,
      );
      expect(
        VerificationType.fromValue('ID_ONLY'),
        VerificationType.idOnly,
      );
      expect(
        VerificationType.fromValue('UNKNOWN_TYPE'),
        VerificationType.idAndFace,
      );
    });
  });
}
