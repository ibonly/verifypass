import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:verifypass_sample/screens/result_screen.dart';

void main() {
  for (final useSecretKey in [false, true]) {
    testWidgets('retry sends current attempt from result screen (secret=$useSecretKey)', (tester) async {
      String? postedAttempt;
      var statusReads = 0;
      final mock = MockClient((request) async {
        if (request.method == 'POST') {
          postedAttempt = jsonDecode(request.body)['attemptId'] as String?;
          // Stop before native WebView navigation; the SDK tests cover the
          // successful retry response and the new returned attempt ID.
          return http.Response(jsonEncode({'error': {'message': 'Test stopped after request'}}), 400);
        }
        if (request.url.path.endsWith('/status')) statusReads++;
        return http.Response(jsonEncode({
          'success': true, 'sessionId': 'vps_retry', 'status': 'rejected',
          'attemptId': 'current_attempt', 'livenessScore': 0.358,
          'selfieScore': 0.358,
        }), 200);
      });
      await http.runWithClient(() async {
        await tester.pumpWidget(MaterialApp(home: ResultScreen(
          sessionId: 'vps_retry', sdkToken: 'token', apiBaseUrl: 'https://example.test',
          secretKey: useSecretKey ? 'test-secret' : null,
        )));
        await tester.pumpAndSettle();
        final button = find.widgetWithText(ElevatedButton, 'Retry Verification');
        await tester.ensureVisible(button);
        await tester.tap(button);
        await tester.pumpAndSettle();
        expect(postedAttempt, 'current_attempt');
        expect(statusReads, useSecretKey ? 1 : 2);
      }, () => mock);
    });
  }
}
