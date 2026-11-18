import 'dart:async';
import 'package:flutter/material.dart';
import 'package:verifypass_flutter/verifypass_flutter.dart';
import 'result_screen.dart';

class VerificationScreen extends StatefulWidget {
  final VerificationSession session;
  final String apiBaseUrl;
  final String hostedBaseUrl;
  final String? secretKey;

  const VerificationScreen({
    super.key,
    required this.session,
    required this.apiBaseUrl,
    required this.hostedBaseUrl,
    this.secretKey,
  });

  @override
  State<VerificationScreen> createState() => _VerificationScreenState();
}

class _VerificationScreenState extends State<VerificationScreen> {
  bool _isNavigatingToResult = false;
  bool _disposed = false;
  late final VerifyPassClient _client;

  @override
  void initState() {
    super.initState();
    _client = VerifyPassClient(apiBaseUrl: widget.apiBaseUrl);
    _startBackgroundPolling();
  }

  @override
  void dispose() {
    _disposed = true;
    _client.close();
    super.dispose();
  }

  /// Polls the session status in the background so even if the hosted page's
  /// redirect doesn't fire, the app automatically detects when verification finishes.
  Future<void> _startBackgroundPolling() async {
    while (mounted && !_isNavigatingToResult && !_disposed) {
      await Future<void>.delayed(const Duration(seconds: 3));
      if (!mounted || _isNavigatingToResult || _disposed) return;

      try {
        final statusRes = await _client.getStatus(
          sessionId: widget.session.sessionId,
          sdkToken: widget.session.sdkToken,
        );

        if (statusRes.isTerminal && mounted && !_isNavigatingToResult) {
          _navigateToResult(statusRes.status);
          return;
        }
      } catch (_) {
        // Ignore background polling transient network errors
      }
    }
  }

  void _navigateToResult(String status) {
    if (_isNavigatingToResult || !mounted) return;
    _isNavigatingToResult = true;

    Navigator.of(context).pushReplacement(
      MaterialPageRoute(
        builder: (_) => ResultScreen(
          sessionId: widget.session.sessionId,
          sdkToken: widget.session.sdkToken,
          apiBaseUrl: widget.apiBaseUrl,
          hostedBaseUrl: widget.hostedBaseUrl,
          secretKey: widget.secretKey,
          preliminaryStatus: status,
        ),
      ),
    );
  }

  Future<bool> _confirmExit() async {
    final exit = await showDialog<bool>(
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
    return exit == true;
  }

  @override
  Widget build(BuildContext context) {
    final navigator = Navigator.of(context);
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        if (await _confirmExit() && mounted) navigator.pop();
      },
      child: Scaffold(
        backgroundColor: Colors.white,
        appBar: AppBar(
          backgroundColor: const Color(0xFF111827),
          elevation: 0,
          leading: IconButton(
            icon: const Icon(Icons.close, color: Colors.white),
            tooltip: 'Cancel verification',
            onPressed: () async {
              if (await _confirmExit() && mounted) navigator.pop();
            },
          ),
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Identity Verification',
              style: TextStyle(
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
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh, color: Colors.white70),
            tooltip: 'Check Status',
            onPressed: () async {
              final messenger = ScaffoldMessenger.of(context);
              try {
                final client = VerifyPassClient(apiBaseUrl: widget.apiBaseUrl);
                final s = await client.getStatus(
                  sessionId: widget.session.sessionId,
                  sdkToken: widget.session.sdkToken,
                );
                if (!mounted) return;
                messenger.showSnackBar(
                  SnackBar(
                    content: Text('Current status: ${s.status}'),
                    duration: const Duration(seconds: 2),
                  ),
                );
                if (s.isTerminal) {
                  _navigateToResult(s.status);
                }
              } catch (e) {
                if (!mounted) return;
                messenger.showSnackBar(
                  SnackBar(content: Text('Error checking status: $e')),
                );
              }
            },
          ),
        ],
      ),
      body: SafeArea(
        child: VerifyPassView(
          session: widget.session,
          hostedBaseUrl: widget.hostedBaseUrl,
          redirectUrl: 'verifypass://complete',
          onComplete: (sessionId, status) {
            _navigateToResult(status);
          },
          onError: (err) {
            if (mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(
                  content: Text('WebView note: $err'),
                  backgroundColor: Colors.black87,
                ),
              );
            }
          },
        ),
      ),
      ),
    );
  }
}
