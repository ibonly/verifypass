import 'dart:async';
import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';
import 'client.dart';
import 'models.dart';
import 'view.dart';

/// Convenient helper for launching a complete VerifyPass verification flow.
class VerifyPass {
  VerifyPass._();

  /// One-line integration entry point.
  ///
  /// Requests camera permission if needed, launches the hosted verification
  /// flow, and optionally handles in-place retries when [autoRetry] is `true`.
  static Future<VerificationStatusResponse?> start(
    BuildContext context, {
    required String sessionId,
    required String sdkToken,
    String? hostedBaseUrl,
    String? apiBaseUrl,
    String title = 'Identity Verification',
    String redirectUrl = 'verifypass://complete',
    Color primaryColor = const Color(0xFF6D28D9),
    Color appBarColor = const Color(0xFF111827),
    bool enableBackgroundPolling = true,
    bool autoRetry = true,
  }) {
    return startVerification(
      context,
      session: VerificationSession.credentials(
        sessionId: sessionId,
        sdkToken: sdkToken,
        hostedBaseUrl: hostedBaseUrl,
      ),
      hostedBaseUrl: hostedBaseUrl,
      apiBaseUrl: apiBaseUrl,
      title: title,
      redirectUrl: redirectUrl,
      primaryColor: primaryColor,
      appBarColor: appBarColor,
      enableBackgroundPolling: enableBackgroundPolling,
      autoRetry: autoRetry,
    );
  }

  /// Launches a full-screen verification modal sheet / route.
  ///
  /// Returns a [VerificationStatusResponse] upon completion, or `null` if the
  /// user dismissed / cancelled the flow.
  static Future<VerificationStatusResponse?> startVerification(
    BuildContext context, {
    required VerificationSession session,
    String? hostedBaseUrl,
    String? apiBaseUrl,
    String title = 'Identity Verification',
    String redirectUrl = 'verifypass://complete',
    Color primaryColor = const Color(0xFF6D28D9),
    Color appBarColor = const Color(0xFF111827),
    bool enableBackgroundPolling = true,
    bool autoRetry = false,
  }) async {
    final granted = await _ensureCameraPermission(context);
    if (!granted || !context.mounted) return null;

    final effectiveHostedBase =
        (hostedBaseUrl != null && hostedBaseUrl.isNotEmpty)
            ? hostedBaseUrl
            : (session.hostedBaseUrl ?? defaultLiveHostedBase);

    final effectiveApiBase = (apiBaseUrl != null && apiBaseUrl.isNotEmpty)
        ? apiBaseUrl
        : (parseSdkTokenOrigin(session.sdkToken) ?? defaultLiveApiBase);

    return Navigator.of(context).push<VerificationStatusResponse>(
      MaterialPageRoute(
        fullscreenDialog: true,
        builder: (ctx) => _VerifyPassFlowPage(
          session: session,
          hostedBaseUrl: effectiveHostedBase,
          apiBaseUrl: effectiveApiBase,
          title: title,
          redirectUrl: redirectUrl,
          primaryColor: primaryColor,
          appBarColor: appBarColor,
          enableBackgroundPolling: enableBackgroundPolling,
          autoRetry: autoRetry,
        ),
      ),
    );
  }

  static Future<bool> _ensureCameraPermission(BuildContext context) async {
    var status = await Permission.camera.status;
    if (status.isGranted) return true;
    status = await Permission.camera.request();
    if (status.isGranted) return true;

    if (!context.mounted) return false;
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Camera Permission Required'),
        content: const Text(
          'VerifyPass needs camera access to capture your ID document and selfie liveness check.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Cancel'),
          ),
          if (status.isPermanentlyDenied)
            TextButton(
              onPressed: () {
                Navigator.of(ctx).pop();
                openAppSettings();
              },
              child: const Text('Open Settings'),
            ),
        ],
      ),
    );
    return false;
  }
}

class _VerifyPassFlowPage extends StatefulWidget {
  final VerificationSession session;
  final String hostedBaseUrl;
  final String? apiBaseUrl;
  final String title;
  final String redirectUrl;
  final Color primaryColor;
  final Color appBarColor;
  final bool enableBackgroundPolling;
  final bool autoRetry;

  const _VerifyPassFlowPage({
    required this.session,
    required this.hostedBaseUrl,
    this.apiBaseUrl,
    required this.title,
    required this.redirectUrl,
    required this.primaryColor,
    required this.appBarColor,
    required this.enableBackgroundPolling,
    required this.autoRetry,
  });

  @override
  State<_VerifyPassFlowPage> createState() => _VerifyPassFlowPageState();
}

class _VerifyPassFlowPageState extends State<_VerifyPassFlowPage> {
  late VerificationSession _session;
  VerifyPassClient? _client;
  bool _isFinished = false;
  bool _handlingOutcome = false;

  @override
  void initState() {
    super.initState();
    _session = widget.session;
    if (widget.apiBaseUrl != null) {
      _client = VerifyPassClient(apiBaseUrl: widget.apiBaseUrl);
    }
    if (widget.enableBackgroundPolling && _client != null) {
      _pollLoop();
    }
  }

  @override
  void dispose() {
    _isFinished = true;
    _client?.close();
    super.dispose();
  }

  Future<void> _pollLoop() async {
    while (mounted && !_isFinished) {
      await Future<void>.delayed(const Duration(seconds: 3));
      if (!mounted || _isFinished || _handlingOutcome) continue;

      try {
        final statusRes = await _client!.getStatus(
          sessionId: _session.sessionId,
          sdkToken: _session.sdkToken,
        );
        if (!mounted || _isFinished) return;
        if (statusRes.isTerminal &&
            (_session.attemptId == null ||
                statusRes.attemptId == null ||
                statusRes.attemptId == _session.attemptId)) {
          await _handleOutcome(statusRes);
        }
      } catch (_) {
        // Ignore transient polling errors
      }
    }
  }

  Future<void> _handleOutcome(VerificationStatusResponse response) async {
    if (_isFinished || _handlingOutcome || !mounted) return;
    final canOfferRetry = widget.autoRetry &&
        _client != null &&
        (response.shouldPromptRetry || response.isRejected || response.isFailed);

    if (!canOfferRetry) {
      _finish(response);
      return;
    }

    _handlingOutcome = true;
    try {
      final shouldRetry = await showDialog<bool>(
        context: context,
        barrierDismissible: false,
        builder: (ctx) => AlertDialog(
          title: const Text('Verification Needs Another Try'),
          content: Text(
            response.shouldPromptRetry
                ? 'Your capture confidence was below the threshold. Would you like to try again?'
                : 'Verification was not approved (${response.effectiveStatus}). Would you like to try again?',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('Done'),
            ),
            ElevatedButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('Try Again'),
            ),
          ],
        ),
      );

      if (shouldRetry == true && mounted && !_isFinished) {
        try {
          final nextSession = await _client!.retrySession(
            sessionId: _session.sessionId,
            sdkToken: _session.sdkToken,
            attemptId: response.attemptId ?? _session.attemptId,
            verificationType: _session.verificationType,
            hostedBaseUrl: widget.hostedBaseUrl,
          );
          if (mounted && !_isFinished) {
            setState(() {
              _session = nextSession;
            });
            return;
          }
        } catch (_) {
          // Retry limit reached or failed — return current outcome
        }
      }
      _finish(response);
    } finally {
      _handlingOutcome = false;
    }
  }

  void _finish(VerificationStatusResponse response) {
    if (_isFinished || !mounted) return;
    _isFinished = true;
    Navigator.of(context).pop(response);
  }

  Future<void> _handleRedirectCompletion(String sessionId, String status) async {
    if (_isFinished || _handlingOutcome || !mounted) return;

    if (_client != null) {
      try {
        final statusRes = await _client!.getStatus(
          sessionId: sessionId,
          sdkToken: _session.sdkToken,
        );
        if (statusRes.isTerminal) {
          await _handleOutcome(statusRes);
        }
        return;
      } catch (_) {
        // Let background poll loop pick up the authoritative outcome if transient
        return;
      }
    }

    _finish(
      VerificationStatusResponse(
        success: true,
        sessionId: sessionId,
        status: status,
        reasonCodes: [],
        raw: {'sessionId': sessionId, 'status': status},
      ),
    );
  }

  Future<bool> _confirmExit() async {
    final shouldExit = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Cancel Verification?'),
        content: const Text(
          'Are you sure you want to exit? Your verification progress will be stopped.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Stay'),
          ),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            style: TextButton.styleFrom(foregroundColor: Colors.red),
            child: const Text('Exit'),
          ),
        ],
      ),
    );
    return shouldExit == true;
  }

  @override
  Widget build(BuildContext context) {
    final navigator = Navigator.of(context);
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, result) async {
        if (didPop) return;
        final ok = await _confirmExit();
        if (ok && mounted) {
          navigator.pop();
        }
      },
      child: Scaffold(
        backgroundColor: Colors.white,
        appBar: AppBar(
          backgroundColor: widget.appBarColor,
          elevation: 0,
          leading: IconButton(
            icon: const Icon(Icons.close, color: Colors.white),
            tooltip: 'Close',
            onPressed: () async {
              final ok = await _confirmExit();
              if (ok && mounted) {
                navigator.pop();
              }
            },
          ),
          title: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                widget.title,
                style: const TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.bold,
                  color: Colors.white,
                ),
              ),
              Text(
                'Session: ${widget.session.sessionId}',
                style: const TextStyle(fontSize: 11, color: Colors.white60),
              ),
            ],
          ),
        ),
        body: SafeArea(
          child: VerifyPassView(
            session: _session,
            hostedBaseUrl: widget.hostedBaseUrl,
            redirectUrl: widget.redirectUrl,
            onComplete: _handleRedirectCompletion,
          ),
        ),
      ),
    );
  }
}
