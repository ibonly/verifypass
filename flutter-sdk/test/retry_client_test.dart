import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:verifypass_flutter/verifypass_flutter.dart';

void main() {
  test('retry without attemptId fetches current attempt and sends it', () async {
    final requests = <http.Request>[];
    final mock = MockClient((request) async {
      requests.add(request);
      expect(request.headers['X-VP-SDK-Token'], 'token');
      if (request.method == 'GET') {
        expect(request.url.path, '/v1/verification-sessions/vps_test/status');
        return http.Response(jsonEncode({
          'success': true, 'sessionId': 'vps_test', 'status': 'rejected',
          'attemptId': 'attempt_current',
        }), 200);
      }
      expect(request.url.path, '/v1/verification-sessions/vps_test/retry');
      expect(jsonDecode(request.body)['attemptId'], 'attempt_current');
      return http.Response(jsonEncode({'attemptId': 'attempt_next'}), 200);
    });
    await http.runWithClient(() async {
      final session = await VerifyPassClient(apiBaseUrl: 'https://example.test')
          .retrySession(sessionId: 'vps_test', sdkToken: 'token');
      expect(session.attemptId, 'attempt_next');
      expect(session.sdkToken, 'token');
      expect(requests.map((r) => r.method), ['GET', 'POST']);
    }, () => mock);
  });

  test('explicit attempt is sent unchanged; a stale rejection is not auto-retried', () async {
    var calls = 0;
    final mock = MockClient((request) async {
      calls++;
      expect(request.method, 'POST');
      expect(jsonDecode(request.body)['attemptId'], 'stale_attempt');
      return http.Response(jsonEncode({'error': {
        'code': 'VALIDATION_ERROR', 'message': 'Attempt superseded',
      }}), 400);
    });
    await http.runWithClient(() async {
      await expectLater(
        VerifyPassClient(apiBaseUrl: 'https://example.test').retrySession(
          sessionId: 'vps_test', sdkToken: 'token', attemptId: 'stale_attempt'),
        throwsA(isA<VerifyPassException>()),
      );
      expect(calls, 1);
    }, () => mock);
  });

  test('status failure prevents retry mutation', () async {
    final mock = MockClient((request) async {
      expect(request.method, 'GET');
      return http.Response(jsonEncode({'error': {'message': 'Invalid token'}}), 403);
    });
    await http.runWithClient(() async {
      await expectLater(
        VerifyPassClient(apiBaseUrl: 'https://example.test').retrySession(
          sessionId: 'vps_test', sdkToken: 'token'),
        throwsA(isA<VerifyPassException>()),
      );
    }, () => mock);
  });
}
