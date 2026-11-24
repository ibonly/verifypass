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

/// Default production/live test API base URL.
const String defaultLiveApiBase =
    'https://uybb6wv27prwyijtkcteovvvke0hfkqw.lambda-url.us-east-2.on.aws';

/// Default production/live test hosted verification base URL.
const String defaultLiveHostedBase =
    'https://verify.verix.ifsolutions.org';

/// Decodes the embedded API origin from a self-locating `sdk_v1_...` token.
/// Returns null if the token is not a self-locating v1 token.
String? parseSdkTokenOrigin(String token) {
  if (token.isEmpty) return null;
  final match = RegExp(r'^sdk_v1_([A-Za-z0-9_-]+)$').firstMatch(token);
  if (match == null) return null;
  try {
    var b64 = match.group(1)!;
    b64 = b64.replaceAll('-', '+').replaceAll('_', '/');
    while (b64.length % 4 != 0) {
      b64 += '=';
    }
    final jsonStr = utf8.decode(base64Decode(b64));
    final data = jsonDecode(jsonStr) as Map<String, dynamic>;
    final u = data['u']?.toString();
    if (u != null && u.isNotEmpty) {
      final uri = Uri.parse(u);
      if (uri.hasScheme && uri.hasAuthority) {
        return '${uri.scheme}://${uri.host}${uri.hasPort ? ':${uri.port}' : ''}';
      }
    }
  } catch (_) {}
  return null;
}

class VerifyPassClient {
  final String apiBaseUrl;
  final Duration requestTimeout;
  final http.Client _http;
  final bool _ownsClient;

  VerifyPassClient({
    String? apiBaseUrl,
    this.requestTimeout = const Duration(seconds: 30),
    http.Client? httpClient,
  })  : apiBaseUrl = (apiBaseUrl != null && apiBaseUrl.isNotEmpty)
            ? apiBaseUrl
            : defaultLiveApiBase,
        _http = httpClient ?? http.Client(),
        _ownsClient = httpClient == null;

  void close() {
    if (_ownsClient) _http.close();
  }

  String get _normalizedApiBase => apiBaseUrl.replaceAll(RegExp(r'/+$'), '');

  String _resolveApiBase(String? sdkToken) {
    if (sdkToken != null && sdkToken.isNotEmpty) {
      final tokenBase = parseSdkTokenOrigin(sdkToken);
      if (tokenBase != null) return tokenBase;
    }
    return _normalizedApiBase;
  }

  Map<String, dynamic> _parseJsonObject(http.Response response, String errMsg) {
    try {
      final decoded = jsonDecode(response.body);
      if (decoded is Map<String, dynamic>) return decoded;
    } catch (_) {}
    throw VerifyPassException(errMsg, statusCode: response.statusCode);
  }

  void _throwIfError(
    http.Response response,
    Map<String, dynamic> body,
    String fallbackMessage,
  ) {
    if (response.statusCode < 400 && body['error'] == null) return;
    final rawError = body['error'];
    if (rawError is Map<String, dynamic>) {
      throw VerifyPassException(
        rawError['message']?.toString() ?? fallbackMessage,
        code: rawError['code']?.toString(),
        statusCode: response.statusCode,
      );
    }
    throw VerifyPassException(
      rawError?.toString() ?? body['message']?.toString() ?? fallbackMessage,
      statusCode: response.statusCode,
    );
  }

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
    final response = await _http
        .post(
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
        )
        .timeout(requestTimeout);

    final body = _parseJsonObject(response, 'Server returned invalid JSON response');
    _throwIfError(response, body, 'Session creation failed');
    return VerificationSession.fromJson(body);
  }

  /// Polls the session status using the client SDK token.
  ///
  /// Safe to call from client applications; does not require the secret key.
  Future<VerificationStatusResponse> getStatus({
    required String sessionId,
    required String sdkToken,
  }) async {
    final effectiveBase = _resolveApiBase(sdkToken);
    final uri = Uri.parse(
      '$effectiveBase/v1/verification-sessions/$sessionId/status',
    );
    final response = await _http
        .get(
          uri,
          headers: {
            'X-VP-SDK-Token': sdkToken,
            'Accept': 'application/json',
          },
        )
        .timeout(requestTimeout);

    final body = _parseJsonObject(response, 'Failed to parse status response');
    _throwIfError(response, body, 'Failed to get session status');
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
    final response = await _http
        .get(
          uri,
          headers: {
            'Authorization': 'Bearer ${secretKey.trim()}',
            'Accept': 'application/json',
          },
        )
        .timeout(requestTimeout);

    final body = _parseJsonObject(response, 'Failed to parse verification result');
    _throwIfError(response, body, 'Failed to fetch result');
    return VerificationResult.fromJson(body);
  }

  /// Reopens a terminal-but-retryable session for another attempt,
  /// generating a new attemptId and reissuing the liveness challenge.
  Future<VerificationSession> retrySession({
    required String sessionId,
    required String sdkToken,
    String? attemptId,
    String verificationType = 'ID_AND_FACE',
    String? hostedBaseUrl,
  }) async {
    // Result-only screens may not have retained the creation response. Fetch
    // the current attempt before retrying; never weaken the server's fence.
    final currentAttemptId = attemptId ??
        (await getStatus(sessionId: sessionId, sdkToken: sdkToken)).attemptId;
    final effectiveBase = _resolveApiBase(sdkToken);
    final uri =
        Uri.parse('$effectiveBase/v1/verification-sessions/$sessionId/retry');
    final response = await _http
        .post(
          uri,
          headers: {
            'X-VP-SDK-Token': sdkToken,
            'Content-Type': 'application/json',
          },
          body: jsonEncode({
            'sdkToken': sdkToken,
            if (currentAttemptId != null) 'attemptId': currentAttemptId,
          }),
        )
        .timeout(requestTimeout);

    final body = _parseJsonObject(response, 'Server returned invalid JSON response');
    _throwIfError(response, body, 'Retry failed');

    return VerificationSession(
      sessionId: sessionId,
      sdkToken: sdkToken,
      attemptId: body['attemptId'] as String?,
      verificationType: verificationType,
      hostedBaseUrl: hostedBaseUrl,
      raw: body,
    );
  }
}
