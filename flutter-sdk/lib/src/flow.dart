import 'dart:async';
import 'package:flutter/material.dart';
import 'client.dart';
import 'models.dart';
import 'view.dart';

/// Convenient helper for launching a complete VerifyPass verification flow.
class VerifyPass {
  VerifyPass._();

  /// Launches a full-screen verification modal sheet / route.
  ///
  /// Returns a [VerificationStatusResponse] upon completion, or `null` if the
  /// user dismissed / cancelled the flow.
  static Future<VerificationStatusResponse?> startVerification(
    BuildContext context, {
    required VerificationSession session,
    required String hostedBaseUrl,
    String? apiBaseUrl,
    String title = 'Identity Verification',
    String redirectUrl = 'verifypass://complete',
    Color primaryColor = const Color(0xFF6D28D9),
    Color appBarColor = const Color(0xFF111827),
    bool enableBackgroundPolling = true,
  }) {
    return Navigator.of(context).push<VerificationStatusResponse>(
      MaterialPageRoute(
        fullscreenDialog: true,
        builder: (ctx) => _VerifyPassFlowPage(
          session: session,
          hostedBaseUrl: hostedBaseUrl,
          apiBaseUrl: apiBaseUrl,
          title: title,
          redirectUrl: redirectUrl,
          primaryColor: primaryColor,
          appBarColor: appBarColor,
          enableBackgroundPolling: enableBackgroundPolling,
        ),
      ),
    );
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

  const _VerifyPassFlowPage({
    required this.session,
    required this.hostedBaseUrl,
    this.apiBaseUrl,
    required this.title,
    required this.redirectUrl,
    required this.primaryColor,
    required this.appBarColor,
    required this.enableBackgroundPolling,
  });

  @override
  State<_VerifyPassFlowPage> createState() => _VerifyPassFlowPageState();
}

class _VerifyPassFlowPageState extends State<_VerifyPassFlowPage> {
  Timer? _pollingTimer;
  bool _isFinished = false;

  @override
  void initState() {
    super.initState();
    if (widget.enableBackgroundPolling && widget.apiBaseUrl != null) {
      _startPolling();
    }
  }

  @override
  void dispose() {
    _pollingTimer?.cancel();
    super.dispose();
  }

  void _startPolling() {
    final client = VerifyPassClient(apiBaseUrl: widget.apiBaseUrl!);
    _pollingTimer = Timer.periodic(const Duration(seconds: 3), (timer) async {
      if (!mounted || _isFinished) {
        timer.cancel();
        return;
      }

      try {
        final statusRes = await client.getStatus(
          sessionId: widget.session.sessionId,
          sdkToken: widget.session.sdkToken,
        );

        if (statusRes.isTerminal) {
          timer.cancel();
          _finish(statusRes);
        }
      } catch (_) {
        // Ignore background polling transient errors
      }
    });
  }

  void _finish(VerificationStatusResponse response) {
    if (_isFinished || !mounted) return;
    _isFinished = true;
    Navigator.of(context).pop(response);
  }

  Future<void> _handleRedirectCompletion(String sessionId, String status) async {
    if (_isFinished || !mounted) return;

    if (widget.apiBaseUrl != null) {
      try {
        final client = VerifyPassClient(apiBaseUrl: widget.apiBaseUrl!);
        final statusRes = await client.getStatus(
          sessionId: sessionId,
          sdkToken: widget.session.sdkToken,
        );
        _finish(statusRes);
        return;
      } catch (_) {}
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
            session: widget.session,
            hostedBaseUrl: widget.hostedBaseUrl,
            redirectUrl: widget.redirectUrl,
            onComplete: _handleRedirectCompletion,
          ),
        ),
      ),
    );
  }
}
