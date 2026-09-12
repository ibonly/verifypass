import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';
import 'package:webview_flutter_wkwebview/webview_flutter_wkwebview.dart';
import 'models.dart';

/// A composable widget that embeds the hosted VerifyPass verification flow.
///
/// Handles in-app camera capture, liveness challenges, and completion events.
class VerifyPassView extends StatefulWidget {
  /// The active verification session credentials.
  final VerificationSession session;

  /// The base URL of the hosted verification page (e.g. `https://verify.example.com`).
  final String hostedBaseUrl;

  /// The redirect URI intercepted to determine completion (default: `verifypass://complete`).
  final String redirectUrl;

  /// Invoked when verification reaches a terminal outcome.
  final void Function(String sessionId, String status) onComplete;

  /// Optional callback invoked when a WebView load or network error occurs.
  final void Function(String error)? onError;

  /// Custom widget displayed while the hosted page is loading.
  final Widget? loadingWidget;

  /// Custom widget builder displayed when an error occurs.
  final Widget Function(BuildContext context, String error, VoidCallback onRetry)?
      errorBuilder;

  const VerifyPassView({
    super.key,
    required this.session,
    required this.hostedBaseUrl,
    this.redirectUrl = 'verifypass://complete',
    required this.onComplete,
    this.onError,
    this.loadingWidget,
    this.errorBuilder,
  });

  @override
  State<VerifyPassView> createState() => _VerifyPassViewState();
}

class _VerifyPassViewState extends State<VerifyPassView> {
  late final WebViewController _controller;
  double _progress = 0.0;
  bool _isLoading = true;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _initController();
  }

  void _initController() {
    late final PlatformWebViewControllerCreationParams params;
    if (WebViewPlatform.instance is WebKitWebViewPlatform) {
      params = WebKitWebViewControllerCreationParams(
        allowsInlineMediaPlayback: true,
        mediaTypesRequiringUserAction: const <PlaybackMediaTypes>{},
      );
    } else {
      params = const PlatformWebViewControllerCreationParams();
    }

    final WebViewController controller =
        WebViewController.fromPlatformCreationParams(params);

    controller.setJavaScriptMode(JavaScriptMode.unrestricted);

    try {
      controller.setBackgroundColor(const Color(0xFFFFFFFF));
    } catch (_) {
      // Safe fallback: setBackgroundColor / setOpaque is not implemented on macOS WKWebView
    }

    controller.setNavigationDelegate(
      NavigationDelegate(
        onProgress: (int progress) {
          if (mounted) {
            setState(() {
              _progress = progress / 100;
            });
          }
        },
        onPageStarted: (String url) {
          if (mounted) {
            setState(() {
              _isLoading = true;
              _errorMessage = null;
            });
          }
        },
        onPageFinished: (String url) {
          if (mounted) {
            setState(() {
              _isLoading = false;
            });
          }
        },
        onWebResourceError: (WebResourceError error) {
          if (kDebugMode) {
            print('VerifyPass WebView error: ${error.description}');
          }
          if (mounted) {
            setState(() {
              _isLoading = false;
              _errorMessage = error.description;
            });
            widget.onError?.call(error.description);
          }
        },
        onNavigationRequest: (NavigationRequest request) {
          if (_checkRedirect(request.url)) {
            return NavigationDecision.prevent;
          }
          return NavigationDecision.navigate;
        },
      ),
    );

    // Platform-specific configuration for Android
    if (controller.platform is AndroidWebViewController) {
      final androidController =
          controller.platform as AndroidWebViewController;
      if (kDebugMode) {
        AndroidWebViewController.enableDebugging(true);
      }
      androidController.setMediaPlaybackRequiresUserGesture(false);
      // Automatically grant web camera permissions requested by hosted verification
      androidController.setOnPlatformPermissionRequest(
        (PlatformWebViewPermissionRequest request) {
          request.grant();
        },
      );
    }

    final initialUri = widget.session.buildHostedUri(
      widget.hostedBaseUrl,
      redirectUrl: widget.redirectUrl,
    );

    controller.loadRequest(initialUri);
    _controller = controller;
  }

  bool _checkRedirect(String url) {
    try {
      final uri = Uri.parse(url);
      final isMatchingRedirect =
          url.startsWith(widget.redirectUrl) ||
          uri.scheme == 'verifypass' ||
          (uri.queryParameters.containsKey('sessionId') &&
              uri.queryParameters.containsKey('status'));

      if (isMatchingRedirect) {
        final sessionId =
            uri.queryParameters['sessionId'] ?? widget.session.sessionId;
        final status = uri.queryParameters['status'] ?? 'completed';
        widget.onComplete(sessionId, status);
        return true;
      }
    } catch (_) {}
    return false;
  }

  void _retry() {
    final uri = widget.session.buildHostedUri(
      widget.hostedBaseUrl,
      redirectUrl: widget.redirectUrl,
    );
    _controller.loadRequest(uri);
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        WebViewWidget(controller: _controller),
        if (_isLoading)
          widget.loadingWidget ??
              Positioned(
                top: 0,
                left: 0,
                right: 0,
                child: LinearProgressIndicator(
                  value: _progress > 0 && _progress < 1.0 ? _progress : null,
                  backgroundColor: Colors.transparent,
                  valueColor:
                      const AlwaysStoppedAnimation<Color>(Color(0xFF6D28D9)),
                ),
              ),
        if (_errorMessage != null)
          widget.errorBuilder != null
              ? widget.errorBuilder!(context, _errorMessage!, _retry)
              : Center(
                  child: Container(
                    margin: const EdgeInsets.all(24),
                    padding: const EdgeInsets.all(20),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(16),
                      boxShadow: const [
                        BoxShadow(
                          color: Colors.black12,
                          blurRadius: 10,
                          offset: Offset(0, 4),
                        ),
                      ],
                    ),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(
                          Icons.error_outline,
                          color: Colors.red,
                          size: 48,
                        ),
                        const SizedBox(height: 12),
                        const Text(
                          'Unable to load verification',
                          style: TextStyle(
                            fontSize: 18,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          _errorMessage!,
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                            color: Colors.black54,
                            fontSize: 13,
                          ),
                        ),
                        const SizedBox(height: 16),
                        ElevatedButton(
                          onPressed: _retry,
                          style: ElevatedButton.styleFrom(
                            backgroundColor: const Color(0xFF6D28D9),
                            foregroundColor: Colors.white,
                          ),
                          child: const Text('Retry'),
                        ),
                      ],
                    ),
                  ),
                ),
      ],
    );
  }
}
