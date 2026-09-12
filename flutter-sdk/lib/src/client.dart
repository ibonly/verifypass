import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'models.dart';

class VerifyPassException implements Exception {
  final String message;
  final String? code;
  final int? statusCode;

  VerifyPassException(this.message, {this.code, this.statusCode});

  @override
  String toString() =>
      'VerifyPassException: $message${code != null ? ' (code: $code)' : ''}${statusCode != null ? ' [HTTP $statusCode]' : ''}';
}

class VerifyPassClient {
  final String apiBaseUrl;

  VerifyPassClient({required this.apiBaseUrl});

  String get _normalizedApiBase => apiBaseUrl.replaceAll(RegExp(r'/+$'), '');

  /// Creates a verification session on the VerifyPass API.
  ///
  /// NOTE: In production, sessions should be created by your trusted backend
  /// using your secret API key (`vp_sec_...`). Exposing secret keys inside client
  /// applications is not recommended for production environments.
  Future<VerificationSession> createSession({
    required String secretKey,
    String? customerReference,
    VerificationType verificationType = VerificationType.idAndFace,
  }) async {
    final uri = Uri.parse('$_normalizedApiBase/v1/verification-sessions');
    final response = await http.post(
      uri,
      headers: {
        'Authorization': 'Bearer ${secretKey.trim()}',
        'Content-Type': 'application/json',
      },
      body: jsonEncode({
        if (customerReference != null && customerReference.isNotEmpty)
          'customerReference': customerReference,
        'verificationType': verificationType.value,
      }),
    );

    final Map<String, dynamic> body;
    try {
      body = jsonDecode(response.body) as Map<String, dynamic>;
    } catch (_) {
      throw VerifyPassException(
        'Server returned invalid JSON response',
        statusCode: response.statusCode,
      );
    }

    if (response.statusCode >= 400 || body['error'] != null) {
      final error = body['error'] as Map<String, dynamic>?;
      throw VerifyPassException(
        error?['message']?.toString() ?? 'Session creation failed',
        code: error?['code']?.toString(),
        statusCode: response.statusCode,
      );
    }

    return VerificationSession.fromJson(body);
  }

  /// Polls the session status using the client SDK token.
  ///
  /// Safe to call from client applications; does not require the secret key.
  Future<VerificationStatusResponse> getStatus({
    required String sessionId,
    required String sdkToken,
  }) async {
    final uri = Uri.parse(
      '$_normalizedApiBase/v1/verification-sessions/$sessionId/status?sdkToken=${Uri.encodeComponent(sdkToken)}',
    );
    final response = await http.get(
      uri,
      headers: {
        'X-VP-SDK-Token': sdkToken,
        'Accept': 'application/json',
      },
    );

    final Map<String, dynamic> body;
    try {
      body = jsonDecode(response.body) as Map<String, dynamic>;
    } catch (_) {
      throw VerifyPassException(
        'Failed to parse status response',
        statusCode: response.statusCode,
      );
    }

    if (response.statusCode >= 400 || body['error'] != null) {
      final error = body['error'] as Map<String, dynamic>?;
      throw VerifyPassException(
        error?['message']?.toString() ?? 'Failed to get session status',
        code: error?['code']?.toString(),
        statusCode: response.statusCode,
      );
    }

    return VerificationStatusResponse.fromJson(body);
  }

  /// Periodically polls for a terminal outcome until completed or timed out.
  Future<VerificationStatusResponse> waitForResult({
    required String sessionId,
    required String sdkToken,
    Duration interval = const Duration(seconds: 2),
    Duration timeout = const Duration(minutes: 10),
  }) async {
    final stopwatch = Stopwatch()..start();
    while (stopwatch.elapsed < timeout) {
      final status = await getStatus(sessionId: sessionId, sdkToken: sdkToken);
      if (status.isTerminal) {
        return status;
      }
      await Future.delayed(interval);
    }
    throw TimeoutException('Timed out waiting for verification outcome');
  }

  /// Fetches the full verification result using the secret key.
  Future<VerificationResult> getResult({
    required String sessionId,
    required String secretKey,
  }) async {
    final uri =
        Uri.parse('$_normalizedApiBase/v1/verification-sessions/$sessionId/result');
    final response = await http.get(
      uri,
      headers: {
        'Authorization': 'Bearer ${secretKey.trim()}',
        'Accept': 'application/json',
      },
    );

    final Map<String, dynamic> body;
    try {
      body = jsonDecode(response.body) as Map<String, dynamic>;
    } catch (_) {
      throw VerifyPassException(
        'Failed to parse verification result',
        statusCode: response.statusCode,
      );
    }

    if (response.statusCode >= 400 || body['error'] != null) {
      final error = body['error'] as Map<String, dynamic>?;
      throw VerifyPassException(
        error?['message']?.toString() ?? 'Failed to fetch result',
        code: error?['code']?.toString(),
        statusCode: response.statusCode,
      );
    }

    return VerificationResult.fromJson(body);
  }
}
