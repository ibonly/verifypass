import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:verifypass_flutter/verifypass_flutter.dart';

class ResultScreen extends StatefulWidget {
  final String sessionId;
  final String sdkToken;
  final String apiBaseUrl;
  final String? secretKey;
  final String? preliminaryStatus;

  const ResultScreen({
    super.key,
    required this.sessionId,
    required this.sdkToken,
    required this.apiBaseUrl,
    this.secretKey,
    this.preliminaryStatus,
  });

  @override
  State<ResultScreen> createState() => _ResultScreenState();
}

class _ResultScreenState extends State<ResultScreen> {
  bool _isLoading = true;
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

  @override
  Widget build(BuildContext context) {
    final status = _result?.status ??
        _statusResponse?.status ??
        widget.preliminaryStatus ??
        'pending';

    final theme = _statusTheme(status);

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
                            const SizedBox(height: 16),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 12,
                                vertical: 6,
                              ),
                              decoration: BoxDecoration(
                                color: Colors.white.withValues(alpha: 0.8),
                                borderRadius: BorderRadius.circular(20),
                              ),
                              child: Text(
                                'Session ID: ${widget.sessionId}',
                                style: const TextStyle(
                                  fontFamily: 'monospace',
                                  fontSize: 12,
                                  color: Color(0xFF374151),
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
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

                      // Reason codes (if any)
                      if (_hasReasonCodes) ...[
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
                                backgroundColor: const Color(0xFF6D28D9),
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

  _StatusTheme _statusTheme(String status) {
    switch (status) {
      case 'approved':
        return _StatusTheme(
          title: 'Verification Approved',
          subtitle: 'Identity and active liveness checks passed successfully.',
          color: const Color(0xFF047857),
          bgColor: const Color(0xFFECFDF5),
          borderColor: const Color(0xFFA7F3D0),
          iconBgColor: const Color(0xFFD1FAE5),
          icon: Icons.check_circle_outline,
        );
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
