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
  StreamSubscription? _statusPollingSub;

  @override
  void initState() {
    super.initState();
    _startBackgroundPolling();
  }

  @override
  void dispose() {
    _statusPollingSub?.cancel();
    super.dispose();
  }

  /// Polls the session status in the background so even if the hosted page's
  /// redirect doesn't fire, the app automatically detects when verification finishes.
  void _startBackgroundPolling() {
    final client = VerifyPassClient(apiBaseUrl: widget.apiBaseUrl);

    // Poll every 3 seconds for terminal status
    Timer.periodic(const Duration(seconds: 3), (timer) async {
      if (!mounted || _isNavigatingToResult) {
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
          _navigateToResult(statusRes.status);
        }
      } catch (_) {
        // Ignore background polling transient network errors
      }
    });
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
          secretKey: widget.secretKey,
          preliminaryStatus: status,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: const Color(0xFF111827),
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.close, color: Colors.white),
          tooltip: 'Cancel verification',
          onPressed: () {
            showDialog(
              context: context,
              builder: (ctx) => AlertDialog(
                title: const Text('Cancel Verification?'),
                content: const Text(
                  'Are you sure you want to exit? Your verification progress will be stopped.',
                ),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.of(ctx).pop(),
                    child: const Text('Stay'),
                  ),
                  TextButton(
                    onPressed: () {
                      Navigator.of(ctx).pop();
                      Navigator.of(context).pop();
                    },
                    style: TextButton.styleFrom(foregroundColor: Colors.red),
                    child: const Text('Exit'),
                  ),
                ],
              ),
            );
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
    );
  }
}
