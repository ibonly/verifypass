import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:verifypass_flutter/verifypass_flutter.dart';

class ResultScreen extends StatefulWidget {
  final String sessionId;
  final String sdkToken;
  final String apiBaseUrl;
  final String? hostedBaseUrl;
  final String? secretKey;
  final String? preliminaryStatus;

  const ResultScreen({
    super.key,
    required this.sessionId,
    required this.sdkToken,
    required this.apiBaseUrl,
    this.hostedBaseUrl,
    this.secretKey,
    this.preliminaryStatus,
  });

  @override
  State<ResultScreen> createState() => _ResultScreenState();
}

class _ResultScreenState extends State<ResultScreen> {
  bool _isLoading = true;
  bool _isRetrying = false;
  String? _errorMessage;

  VerificationResult? _result;
  VerificationStatusResponse? _statusResponse;

  @override
  void initState() {
    super.initState();
    _fetchOutcome();
  }

  Future<void> _fetchOutcome() async {
    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    final client = VerifyPassClient(apiBaseUrl: widget.apiBaseUrl);

    try {
      if (widget.secretKey != null && widget.secretKey!.isNotEmpty) {
        // Fetch full secret-key result
        final res = await client.getResult(
          sessionId: widget.sessionId,
          secretKey: widget.secretKey!,
        );
        if (mounted) {
          setState(() {
            _result = res;
            _isLoading = false;
          });
        }
      } else {
        // Fetch SDK status only
        final res = await client.getStatus(
          sessionId: widget.sessionId,
          sdkToken: widget.sdkToken,
        );
        if (mounted) {
          setState(() {
            _statusResponse = res;
            _isLoading = false;
          });
        }
      }
    } catch (err) {
      if (mounted) {
        setState(() {
          _errorMessage = err.toString();
          _isLoading = false;
        });
      }
    }
  }

  Future<void> _handleRetry() async {
    if (_isRetrying) return;
    setState(() {
      _isRetrying = true;
      _errorMessage = null;
    });

    final client = VerifyPassClient(apiBaseUrl: widget.apiBaseUrl);

    try {
      final retrySession = await client.retrySession(
        sessionId: widget.sessionId,
        sdkToken: widget.sdkToken,
      );

      if (!mounted) return;

      final hostedBase = widget.hostedBaseUrl ??
          (widget.apiBaseUrl.contains(':3000')
              ? widget.apiBaseUrl.replaceAll(':3000', ':5174')
              : widget.apiBaseUrl);

      final outcome = await VerifyPass.startVerification(
        context,
        session: retrySession,
        hostedBaseUrl: hostedBase,
        apiBaseUrl: widget.apiBaseUrl,
        title: 'Retry Verification',
      );

      if (!mounted) return;

      if (outcome != null) {
        await _fetchOutcome();
      }
    } catch (err) {
      if (mounted) {
        setState(() {
          _errorMessage = 'Retry error: $err';
        });
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Retry failed: $err'),
            backgroundColor: const Color(0xFFDC2626),
          ),
        );
      }
    } finally {
      if (mounted) {
        setState(() {
          _isRetrying = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final rawStatus = _result?.status ??
        _statusResponse?.status ??
        widget.preliminaryStatus ??
        'pending';

    final livenessScore = _result?.livenessScore ?? _statusResponse?.livenessScore;
    final selfieScore = _result?.selfieScore ?? _statusResponse?.selfieScore;

    final bool meetsSixtyPercent = livenessScore != null &&
        selfieScore != null &&
        livenessScore > 0.60 &&
        selfieScore > 0.60;

    final bool isScoreBelowSixty = (livenessScore != null && livenessScore <= 0.60) ||
        (selfieScore != null && selfieScore <= 0.60);

    final String displayStatus = meetsSixtyPercent
        ? 'approved'
        : (isScoreBelowSixty ? 'retry_required' : rawStatus);

    final bool isApproved = displayStatus == 'approved';

    final bool shouldPromptRetry = !isApproved &&
        (isScoreBelowSixty ||
            rawStatus == 'rejected' ||
            rawStatus == 'manual_review' ||
            rawStatus == 'failed' ||
            rawStatus == 'retry_required');

    final theme = _statusTheme(
      displayStatus,
      isAutoApproved: meetsSixtyPercent,
      isScoreRetry: isScoreBelowSixty && !isApproved,
    );

    return Scaffold(
      backgroundColor: const Color(0xFFF9FAFB),
      appBar: AppBar(
        title: const Text(
          'Verification Result',
          style: TextStyle(fontWeight: FontWeight.bold, color: Colors.white),
        ),
        backgroundColor: const Color(0xFF111827),
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: Colors.white),
          onPressed: () => Navigator.of(context).pop(),
        ),
      ),
      body: _isLoading
          ? const Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  CircularProgressIndicator(
                    valueColor:
                        AlwaysStoppedAnimation<Color>(Color(0xFF6D28D9)),
                  ),
                  SizedBox(height: 16),
                  Text(
                    'Loading verification outcome...',
                    style: TextStyle(color: Colors.black54),
                  ),
                ],
              ),
            )
          : SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 540),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      // Main Outcome Banner
                      Container(
                        padding: const EdgeInsets.all(24),
                        decoration: BoxDecoration(
                          color: theme.bgColor,
                          borderRadius: BorderRadius.circular(20),
                          border: Border.all(color: theme.borderColor, width: 1.5),
                        ),
                        child: Column(
                          children: [
                            Container(
                              padding: const EdgeInsets.all(16),
                              decoration: BoxDecoration(
                                color: theme.iconBgColor,
                                shape: BoxShape.circle,
                              ),
                              child: Icon(
                                theme.icon,
                                color: theme.color,
                                size: 42,
                              ),
                            ),
                            const SizedBox(height: 14),
                            Text(
                              theme.title,
                              style: TextStyle(
                                fontSize: 22,
                                fontWeight: FontWeight.bold,
                                color: theme.color,
                              ),
                            ),
                            const SizedBox(height: 6),
                            Text(
                              theme.subtitle,
                              textAlign: TextAlign.center,
                              style: const TextStyle(
                                fontSize: 13.5,
                                color: Color(0xFF4B5563),
                                height: 1.35,
                              ),
                            ),
                            const SizedBox(height: 14),
                            Row(
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: [
                                Container(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 12,
                                    vertical: 6,
                                  ),
                                  decoration: BoxDecoration(
                                    color: Colors.white.withValues(alpha: 0.85),
                                    borderRadius: BorderRadius.circular(20),
                                  ),
                                  child: Text(
                                    'Session: ${widget.sessionId}',
                                    style: const TextStyle(
                                      fontFamily: 'monospace',
                                      fontSize: 12,
                                      color: Color(0xFF374151),
                                    ),
                                  ),
                                ),
                                if (meetsSixtyPercent) ...[
                                  const SizedBox(width: 8),
                                  Container(
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 10,
                                      vertical: 5,
                                    ),
                                    decoration: BoxDecoration(
                                      color: const Color(0xFF047857),
                                      borderRadius: BorderRadius.circular(20),
                                    ),
                                    child: const Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        Icon(Icons.check, size: 12, color: Colors.white),
                                        SizedBox(width: 4),
                                        Text(
                                          '>60% Approved',
                                          style: TextStyle(
                                            color: Colors.white,
                                            fontSize: 11,
                                            fontWeight: FontWeight.bold,
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                ] else if (isScoreBelowSixty) ...[
                                  const SizedBox(width: 8),
                                  Container(
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 10,
                                      vertical: 5,
                                    ),
                                    decoration: BoxDecoration(
                                      color: const Color(0xFFD97706),
                                      borderRadius: BorderRadius.circular(20),
                                    ),
                                    child: const Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        Icon(Icons.replay, size: 12, color: Colors.white),
                                        SizedBox(width: 4),
                                        Text(
                                          '≤60% Retry',
                                          style: TextStyle(
                                            color: Colors.white,
                                            fontSize: 11,
                                            fontWeight: FontWeight.bold,
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                ],
                              ],
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 16),

                      // Auto-Approval Rule Success Banner
                      if (meetsSixtyPercent) ...[
                        Container(
                          padding: const EdgeInsets.all(16),
                          decoration: BoxDecoration(
                            color: const Color(0xFFECFDF5),
                            borderRadius: BorderRadius.circular(14),
                            border: Border.all(color: const Color(0xFFA7F3D0), width: 1.5),
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Row(
                                children: [
                                  Icon(Icons.verified, color: Color(0xFF047857), size: 20),
                                  SizedBox(width: 8),
                                  Text(
                                    'Automatic Approval (>60% Threshold Met)',
                                    style: TextStyle(
                                      fontSize: 14,
                                      fontWeight: FontWeight.bold,
                                      color: Color(0xFF047857),
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 8),
                              const Text(
                                'Both liveness confidence and selfie frontal score exceed the 60% requirement. Verification has been automatically approved.',
                                style: TextStyle(
                                  fontSize: 12.5,
                                  color: Color(0xFF065F46),
                                  height: 1.35,
                                ),
                              ),
                              const SizedBox(height: 10),
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                                decoration: BoxDecoration(
                                  color: Colors.white,
                                  borderRadius: BorderRadius.circular(8),
                                  border: Border.all(color: const Color(0xFFA7F3D0)),
                                ),
                                child: Column(
                                  children: [
                                    _buildDetailRow(
                                      'Liveness Confidence',
                                      '${(livenessScore * 100).toStringAsFixed(1)}% (Pass >60%)',
                                      isGood: true,
                                    ),
                                    _buildDetailRow(
                                      'Selfie Frontal Score',
                                      '${(selfieScore * 100).toStringAsFixed(1)}% (Pass >60%)',
                                      isGood: true,
                                    ),
                                  ],
                                ),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 16),
                      ],

                      // Retry Required Banner (<60% or soft review/reject)
                      if (shouldPromptRetry) ...[
                        Container(
                          padding: const EdgeInsets.all(16),
                          decoration: BoxDecoration(
                            color: const Color(0xFFFFFBEB),
                            borderRadius: BorderRadius.circular(14),
                            border: Border.all(color: const Color(0xFFFDE68A), width: 1.5),
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  const Icon(Icons.warning_amber_rounded, color: Color(0xFFD97706), size: 22),
                                  const SizedBox(width: 8),
                                  Text(
                                    isScoreBelowSixty
                                        ? 'Score Below 60% — Retry Prompted'
                                        : 'Retry Verification Required',
                                    style: const TextStyle(
                                      fontSize: 14,
                                      fontWeight: FontWeight.bold,
                                      color: Color(0xFFB45309),
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 8),
                              Text(
                                isScoreBelowSixty
                                    ? 'Liveness confidence or selfie frontal score is 60% or lower. Auto-approval requires both scores to be above 60%.'
                                    : 'The verification was not approved automatically. Tap below to retry.',
                                style: const TextStyle(
                                  fontSize: 12.5,
                                  color: Color(0xFF92400E),
                                  height: 1.35,
                                ),
                              ),
                              if (livenessScore != null || selfieScore != null) ...[
                                const SizedBox(height: 10),
                                Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                                  decoration: BoxDecoration(
                                    color: Colors.white,
                                    borderRadius: BorderRadius.circular(8),
                                    border: Border.all(color: const Color(0xFFFDE68A)),
                                  ),
                                  child: Column(
                                    children: [
                                      if (livenessScore != null)
                                        _buildDetailRow(
                                          'Liveness Confidence',
                                          '${(livenessScore * 100).toStringAsFixed(1)}% ${livenessScore <= 0.60 ? "⚠️ (≤60% Needs Retry)" : "✓ (>60%)"}',
                                          isGood: livenessScore > 0.60,
                                        ),
                                      if (selfieScore != null)
                                        _buildDetailRow(
                                          'Selfie Frontal Score',
                                          '${(selfieScore * 100).toStringAsFixed(1)}% ${selfieScore <= 0.60 ? "⚠️ (≤60% Needs Retry)" : "✓ (>60%)"}',
                                          isGood: selfieScore > 0.60,
                                        ),
                                    ],
                                  ),
                                ),
                              ],
                              const SizedBox(height: 10),
                              const Text(
                                'Tips: Hold camera at eye level, ensure bright front-facing light, and perform challenge head movements smoothly.',
                                style: TextStyle(
                                  fontSize: 11.5,
                                  fontStyle: FontStyle.italic,
                                  color: Color(0xFF78350F),
                                ),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 16),
                      ],
                      const SizedBox(height: 18),

                      if (_errorMessage != null) ...[
                        Container(
                          padding: const EdgeInsets.all(14),
                          decoration: BoxDecoration(
                            color: const Color(0xFFFEE2E2),
                            borderRadius: BorderRadius.circular(12),
                          ),
                          child: Text(
                            'Error: $_errorMessage',
                            style: const TextStyle(
                              color: Color(0xFFDC2626),
                              fontSize: 13,
                            ),
                          ),
                        ),
                        const SizedBox(height: 18),
                      ],

                      // Reason codes (only shown when not approved to prevent contradicting approved outcome)
                      if (!isApproved && _hasReasonCodes) ...[
                        _buildCard(
                          title: 'Reason Codes',
                          icon: Icons.label_outline,
                          child: Wrap(
                            spacing: 8,
                            runSpacing: 8,
                            children: _reasonCodes.map((c) {
                              return Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 10,
                                  vertical: 5,
                                ),
                                decoration: BoxDecoration(
                                  color: const Color(0xFFF3F4F6),
                                  borderRadius: BorderRadius.circular(6),
                                  border: Border.all(
                                    color: const Color(0xFFD1D5DB),
                                  ),
                                ),
                                child: Text(
                                  c,
                                  style: const TextStyle(
                                    fontFamily: 'monospace',
                                    fontSize: 12,
                                    fontWeight: FontWeight.w600,
                                    color: Color(0xFF374151),
                                  ),
                                ),
                              );
                            }).toList(),
                          ),
                        ),
                        const SizedBox(height: 16),
                      ],

                      // Secret Key Detail Breakdown
                      if (_result != null) ...[
                        // Liveness Card
                        if (_result!.livenessStatus != null ||
                            _result!.livenessChallenge != null) ...[
                          _buildCard(
                            title: 'Active Liveness Check',
                            icon: Icons.face_retouching_natural,
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                _buildDetailRow(
                                  'Status',
                                  _result!.livenessStatus ?? 'n/a',
                                  isGood: _result!.livenessStatus == 'live',
                                ),
                                if (_result!.livenessScore != null)
                                  _buildDetailRow(
                                    'Liveness Confidence',
                                    '${(_result!.livenessScore! * 100).toStringAsFixed(1)}%',
                                  ),
                                if (_result!.selfieScore != null)
                                  _buildDetailRow(
                                    'Selfie Frontal Score',
                                    '${(_result!.selfieScore! * 100).toStringAsFixed(1)}%',
                                  ),
                                if (_result!.livenessChallenge != null) ...[
                                  const SizedBox(height: 10),
                                  const Text(
                                    'Challenge Actions Breakdown:',
                                    style: TextStyle(
                                      fontWeight: FontWeight.w600,
                                      fontSize: 13,
                                      color: Color(0xFF374151),
                                    ),
                                  ),
                                  const SizedBox(height: 6),
                                  ..._buildChallengeActionsList(
                                    _result!.livenessChallenge!,
                                  ),
                                ],
                              ],
                            ),
                          ),
                          const SizedBox(height: 16),
                        ],

                        // Document Card
                        if (_result!.documentStatus != null) ...[
                          _buildCard(
                            title: 'ID Document Verification',
                            icon: Icons.credit_card_outlined,
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                _buildDetailRow(
                                  'Document Status',
                                  _result!.documentStatus ?? 'n/a',
                                  isGood: _result!.documentStatus == 'passed' ||
                                      _result!.documentStatus == 'valid',
                                ),
                                if (_result!.ocrConfidence != null)
                                  _buildDetailRow(
                                    'OCR Confidence',
                                    '${(_result!.ocrConfidence! * 100).toStringAsFixed(1)}%',
                                  ),
                                if (_result!.extractedData != null &&
                                    _result!.extractedData!.isNotEmpty) ...[
                                  const SizedBox(height: 8),
                                  const Text(
                                    'Extracted Fields:',
                                    style: TextStyle(
                                      fontWeight: FontWeight.w600,
                                      fontSize: 13,
                                      color: Color(0xFF374151),
                                    ),
                                  ),
                                  const SizedBox(height: 6),
                                  ..._result!.extractedData!.entries.map((e) {
                                    return _buildDetailRow(
                                      e.key,
                                      e.value?.toString() ?? '',
                                    );
                                  }),
                                ],
                              ],
                            ),
                          ),
                          const SizedBox(height: 16),
                        ],

                        // Face Match Card
                        if (_result!.faceMatchStatus != null) ...[
                          _buildCard(
                            title: 'Face Match (Selfie vs Document)',
                            icon: Icons.compare_arrows_rounded,
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                _buildDetailRow(
                                  'Match Status',
                                  _result!.faceMatchStatus ?? 'n/a',
                                  isGood: _result!.faceMatchStatus == 'matched',
                                ),
                                if (_result!.faceMatchScore != null)
                                  _buildDetailRow(
                                    'Similarity Score',
                                    '${(_result!.faceMatchScore! * 100).toStringAsFixed(1)}%',
                                  ),
                              ],
                            ),
                          ),
                          const SizedBox(height: 16),
                        ],
                      ],

                      // Raw JSON Tile
                      Card(
                        elevation: 0,
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(16),
                          side: const BorderSide(color: Color(0xFFE5E7EB)),
                        ),
                        color: Colors.white,
                        child: Theme(
                          data: Theme.of(context).copyWith(
                            dividerColor: Colors.transparent,
                          ),
                          child: ExpansionTile(
                            title: const Text(
                              'Raw Response JSON',
                              style: TextStyle(
                                fontSize: 13,
                                fontWeight: FontWeight.w600,
                                color: Color(0xFF4B5563),
                              ),
                            ),
                            children: [
                              Container(
                                width: double.infinity,
                                margin: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                                padding: const EdgeInsets.all(12),
                                decoration: BoxDecoration(
                                  color: const Color(0xFF111827),
                                  borderRadius: BorderRadius.circular(8),
                                ),
                                child: SelectableText(
                                  const JsonEncoder.withIndent('  ').convert(
                                    _result?.raw ?? _statusResponse?.raw ?? {},
                                  ),
                                  style: const TextStyle(
                                    fontFamily: 'monospace',
                                    fontSize: 11,
                                    color: Color(0xFFE5E7EB),
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(height: 24),

                      // Bottom Action Buttons
                      if (shouldPromptRetry) ...[
                        SizedBox(
                          width: double.infinity,
                          height: 48,
                          child: ElevatedButton.icon(
                            onPressed: _isRetrying ? null : _handleRetry,
                            icon: _isRetrying
                                ? const SizedBox(
                                    width: 18,
                                    height: 18,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                      valueColor:
                                          AlwaysStoppedAnimation<Color>(Colors.white),
                                    ),
                                  )
                                : const Icon(Icons.replay_rounded, size: 20),
                            label: Text(
                              _isRetrying
                                  ? 'Preparing Retry Attempt...'
                                  : 'Retry Verification',
                              style: const TextStyle(
                                fontWeight: FontWeight.bold,
                                fontSize: 15,
                              ),
                            ),
                            style: ElevatedButton.styleFrom(
                              backgroundColor: const Color(0xFF6D28D9),
                              foregroundColor: Colors.white,
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(10),
                              ),
                              elevation: 0,
                            ),
                          ),
                        ),
                        const SizedBox(height: 12),
                      ],
                      Row(
                        children: [
                          Expanded(
                            child: OutlinedButton(
                              onPressed: _fetchOutcome,
                              style: OutlinedButton.styleFrom(
                                padding: const EdgeInsets.symmetric(vertical: 14),
                                shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(10),
                                ),
                              ),
                              child: const Text('Refresh Status'),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: ElevatedButton(
                              onPressed: () => Navigator.of(context).pop(),
                              style: ElevatedButton.styleFrom(
                                backgroundColor: shouldPromptRetry
                                    ? const Color(0xFF4B5563)
                                    : const Color(0xFF6D28D9),
                                foregroundColor: Colors.white,
                                padding: const EdgeInsets.symmetric(vertical: 14),
                                shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(10),
                                ),
                                elevation: 0,
                              ),
                              child: const Text(
                                'Run Another',
                                style: TextStyle(fontWeight: FontWeight.bold),
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 20),
                    ],
                  ),
                ),
              ),
            ),
    );
  }

  bool get _hasReasonCodes {
    return _reasonCodes.isNotEmpty;
  }

  List<String> get _reasonCodes {
    if (_result != null) return _result!.reasonCodes;
    if (_statusResponse != null) return _statusResponse!.reasonCodes;
    return [];
  }

  Widget _buildCard({
    required String title,
    required IconData icon,
    required Widget child,
  }) {
    return Card(
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: const BorderSide(color: Color(0xFFE5E7EB)),
      ),
      color: Colors.white,
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, size: 20, color: const Color(0xFF6D28D9)),
                const SizedBox(width: 8),
                Text(
                  title,
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.bold,
                    color: Color(0xFF111827),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 14),
            child,
          ],
        ),
      ),
    );
  }

  Widget _buildDetailRow(String label, String value, {bool? isGood}) {
    Color valColor = const Color(0xFF111827);
    if (isGood == true) valColor = const Color(0xFF047857);
    if (isGood == false) valColor = const Color(0xFFB91C1C);

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            label,
            style: const TextStyle(fontSize: 13, color: Color(0xFF6B7280)),
          ),
          Text(
            value,
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w600,
              color: valColor,
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _buildChallengeActionsList(Map<String, dynamic> challenge) {
    final perAction = challenge['perAction'] as Map<String, dynamic>? ?? {};
    if (perAction.isEmpty) {
      return [
        const Text(
          'No per-action breakdown available',
          style: TextStyle(fontSize: 12, color: Colors.black45),
        ),
      ];
    }

    return perAction.entries.map((entry) {
      final a = entry.key;
      final pa = entry.value as Map<String, dynamic>? ?? {};

      final present = pa['present'] == true;
      final live = pa['live'] == true;
      final poseChecked = pa['poseChecked'] == true;
      final poseOk = pa['poseOk'] == true;

      return Container(
        margin: const EdgeInsets.only(bottom: 6),
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(
          color: const Color(0xFFF9FAFB),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(
          children: [
            Icon(
              present && live ? Icons.check_circle : Icons.error,
              size: 16,
              color: present && live ? const Color(0xFF047857) : const Color(0xFFDC2626),
            ),
            const SizedBox(width: 8),
            Text(
              a,
              style: const TextStyle(
                fontFamily: 'monospace',
                fontWeight: FontWeight.bold,
                fontSize: 12,
              ),
            ),
            const Spacer(),
            Text(
              'live: $live${poseChecked ? " · pose: ${poseOk ? '✓' : '✗'}" : ""}',
              style: const TextStyle(fontSize: 11, color: Colors.black54),
            ),
          ],
        ),
      );
    }).toList();
  }

  _StatusTheme _statusTheme(
    String status, {
    bool isAutoApproved = false,
    bool isScoreRetry = false,
  }) {
    if (isAutoApproved || status == 'approved') {
      return _StatusTheme(
        title: 'Verification Approved',
        subtitle: isAutoApproved
            ? 'Automatically approved: Liveness confidence and selfie frontal score both exceeded 60%.'
            : 'Identity and active liveness checks passed successfully.',
        color: const Color(0xFF047857),
        bgColor: const Color(0xFFECFDF5),
        borderColor: const Color(0xFFA7F3D0),
        iconBgColor: const Color(0xFFD1FAE5),
        icon: Icons.check_circle_outline,
      );
    }
    if (isScoreRetry || status == 'retry_required') {
      return _StatusTheme(
        title: 'Retry Required (<60%)',
        subtitle: 'Liveness confidence or selfie frontal score is 60% or lower. Please retry the verification.',
        color: const Color(0xFFD97706),
        bgColor: const Color(0xFFFFFBEB),
        borderColor: const Color(0xFFFDE68A),
        iconBgColor: const Color(0xFFFEF3C7),
        icon: Icons.replay_rounded,
      );
    }
    switch (status) {
      case 'manual_review':
        return _StatusTheme(
          title: 'Manual Review Required',
          subtitle: 'Liveness or document quality requires agent review.',
          color: const Color(0xFFB45309),
          bgColor: const Color(0xFFFFFBEB),
          borderColor: const Color(0xFFFDE68A),
          iconBgColor: const Color(0xFFFEF3C7),
          icon: Icons.hourglass_empty_rounded,
        );
      case 'rejected':
        return _StatusTheme(
          title: 'Verification Rejected',
          subtitle: 'The submitted verification could not be validated.',
          color: const Color(0xFFB91C1C),
          bgColor: const Color(0xFFFEF2F2),
          borderColor: const Color(0xFFFECACA),
          iconBgColor: const Color(0xFFFEE2E2),
          icon: Icons.highlight_off_rounded,
        );
      default:
        return _StatusTheme(
          title: 'Status: $status',
          subtitle: 'Session finished with status: $status.',
          color: const Color(0xFF374151),
          bgColor: const Color(0xFFF3F4F6),
          borderColor: const Color(0xFFE5E7EB),
          iconBgColor: const Color(0xFFE5E7EB),
          icon: Icons.info_outline,
        );
    }
  }
}

class _StatusTheme {
  final String title;
  final String subtitle;
  final Color color;
  final Color bgColor;
  final Color borderColor;
  final Color iconBgColor;
  final IconData icon;

  _StatusTheme({
    required this.title,
    required this.subtitle,
    required this.color,
    required this.bgColor,
    required this.borderColor,
    required this.iconBgColor,
    required this.icon,
  });
}
