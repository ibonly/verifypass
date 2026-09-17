import 'dart:io' show Platform;
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:verifypass_flutter/verifypass_flutter.dart';
import 'verification_screen.dart';
import 'result_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final _formKey = GlobalKey<FormState>();

  late final TextEditingController _apiBaseController;
  late final TextEditingController _hostedBaseController;
  late final TextEditingController _secretKeyController;
  late final TextEditingController _customerRefController;
  late final TextEditingController _sessionIdController;
  late final TextEditingController _sdkTokenController;

  VerificationType _verificationType = VerificationType.idAndFace;
  bool _isCreatingSession = false;
  String? _errorMessage;
  int _selectedTab = 0; // 0 = Create via Test Secret Key, 1 = Connect Existing Session

  @override
  void initState() {
    super.initState();

    // Default network endpoints depending on execution platform:
    // Android emulator routes host machine loopback to 10.0.2.2
    final isAndroid = !kIsWeb && Platform.isAndroid;
    final defaultHost = isAndroid ? 'http://10.0.2.2' : 'http://localhost';

    _apiBaseController = TextEditingController(text: '$defaultHost:3000');
    _hostedBaseController = TextEditingController(text: '$defaultHost:5174');
    _secretKeyController = TextEditingController();
    _customerRefController = TextEditingController(
      text: 'SAMPLE-${DateTime.now().millisecondsSinceEpoch % 100000}',
    );
    _sessionIdController = TextEditingController();
    _sdkTokenController = TextEditingController();
  }

  @override
  void dispose() {
    _apiBaseController.dispose();
    _hostedBaseController.dispose();
    _secretKeyController.dispose();
    _customerRefController.dispose();
    _sessionIdController.dispose();
    _sdkTokenController.dispose();
    super.dispose();
  }

  Future<void> _handleStartVerification({bool useModal = true}) async {
    setState(() {
      _errorMessage = null;
    });

    if (!_formKey.currentState!.validate()) return;

    final apiBase = _apiBaseController.text.trim();
    final hostedBase = _hostedBaseController.text.trim();

    if (_selectedTab == 0) {
      // Create session using secret key (Dev Harness mode)
      final secretKey = _secretKeyController.text.trim();
      final customerRef = _customerRefController.text.trim();

      setState(() {
        _isCreatingSession = true;
      });

      try {
        final client = VerifyPassClient(apiBaseUrl: apiBase);
        final session = await client.createSession(
          secretKey: secretKey,
          customerReference: customerRef.isNotEmpty ? customerRef : null,
          verificationType: _verificationType,
        );

        if (!mounted) return;
        await _launchVerification(session, apiBase, hostedBase, secretKey: secretKey, useModal: useModal);
      } catch (err) {
        if (!mounted) return;
        setState(() {
          _errorMessage = err.toString();
        });
      } finally {
        if (mounted) {
          setState(() {
            _isCreatingSession = false;
          });
        }
      }
    } else {
      // Connect existing session (Production architecture simulation)
      final sessionId = _sessionIdController.text.trim();
      final sdkToken = _sdkTokenController.text.trim();

      final session = VerificationSession(
        sessionId: sessionId,
        sdkToken: sdkToken,
        verificationType: _verificationType.value,
        hostedBaseUrl: hostedBase,
        raw: {},
      );

      final secretKey = _secretKeyController.text.trim().isNotEmpty
          ? _secretKeyController.text.trim()
          : null;

      await _launchVerification(session, apiBase, hostedBase, secretKey: secretKey, useModal: useModal);
    }
  }

  Future<void> _launchVerification(
    VerificationSession session,
    String apiBase,
    String hostedBase, {
    String? secretKey,
    required bool useModal,
  }) async {
    if (useModal) {
      final outcome = await VerifyPass.startVerification(
        context,
        session: session,
        hostedBaseUrl: hostedBase,
        apiBaseUrl: apiBase,
        title: 'Identity Verification',
      );

      if (!mounted || outcome == null) return;

      Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => ResultScreen(
            sessionId: session.sessionId,
            sdkToken: session.sdkToken,
            apiBaseUrl: apiBase,
            hostedBaseUrl: hostedBase,
            secretKey: secretKey,
            preliminaryStatus: outcome.status,
          ),
        ),
      );
    } else {
      Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => VerificationScreen(
            session: session,
            apiBaseUrl: apiBase,
            hostedBaseUrl: hostedBase,
            secretKey: secretKey,
          ),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    const primaryColor = Color(0xFF6D28D9);

    return Scaffold(
      backgroundColor: const Color(0xFFF9FAFB),
      appBar: AppBar(
        title: const Row(
          children: [
            Icon(Icons.verified_user_outlined, color: Colors.white),
            SizedBox(width: 8),
            Text(
              'Verix',
              style: TextStyle(fontWeight: FontWeight.bold, color: Colors.white),
            ),
            SizedBox(width: 6),
            Text(
              '· Flutter Demo',
              style: TextStyle(color: Colors.white70, fontSize: 14),
            ),
          ],
        ),
        backgroundColor: const Color(0xFF111827),
        elevation: 0,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: Form(
              key: _formKey,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // Header card
                  Card(
                    elevation: 0,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16),
                      side: const BorderSide(color: Color(0xFFE5E7EB)),
                    ),
                    color: Colors.white,
                    child: Padding(
                      padding: const EdgeInsets.all(20),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                            'Start a Verification',
                            style: TextStyle(
                              fontSize: 20,
                              fontWeight: FontWeight.bold,
                              color: Color(0xFF111827),
                            ),
                          ),
                          const SizedBox(height: 8),
                          const Text(
                            'Test active liveness, face recognition, and document checks directly in your Flutter mobile application.',
                            style: TextStyle(fontSize: 14, color: Color(0xFF6B7280)),
                          ),
                          const SizedBox(height: 16),
                          Container(
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(
                              color: const Color(0xFFFEF3C7),
                              borderRadius: BorderRadius.circular(10),
                              border: Border.all(color: const Color(0xFFFDE68A)),
                            ),
                            child: const Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Icon(
                                  Icons.info_outline,
                                  color: Color(0xFF92400E),
                                  size: 20,
                                ),
                                SizedBox(width: 10),
                                Expanded(
                                  child: Text(
                                    'In production, your backend calls /v1/verification-sessions using your secret key and passes only sessionId and sdkToken to Flutter.',
                                    style: TextStyle(
                                      color: Color(0xFF92400E),
                                      fontSize: 12.5,
                                      height: 1.35,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),

                  // Mode Selector Segment
                  Container(
                    decoration: BoxDecoration(
                      color: const Color(0xFFE5E7EB),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    padding: const EdgeInsets.all(4),
                    child: Row(
                      children: [
                        Expanded(
                          child: GestureDetector(
                            onTap: () => setState(() => _selectedTab = 0),
                            child: Container(
                              padding: const EdgeInsets.symmetric(vertical: 10),
                              decoration: BoxDecoration(
                                color: _selectedTab == 0
                                    ? Colors.white
                                    : Colors.transparent,
                                borderRadius: BorderRadius.circular(9),
                                boxShadow: _selectedTab == 0
                                    ? [
                                        const BoxShadow(
                                          color: Colors.black12,
                                          blurRadius: 4,
                                          offset: Offset(0, 2),
                                        ),
                                      ]
                                    : null,
                              ),
                              alignment: Alignment.center,
                              child: Text(
                                'Test Harness (Secret Key)',
                                style: TextStyle(
                                  fontSize: 13,
                                  fontWeight: _selectedTab == 0
                                      ? FontWeight.w600
                                      : FontWeight.normal,
                                  color: _selectedTab == 0
                                      ? const Color(0xFF111827)
                                      : const Color(0xFF4B5563),
                                ),
                              ),
                            ),
                          ),
                        ),
                        Expanded(
                          child: GestureDetector(
                            onTap: () => setState(() => _selectedTab = 1),
                            child: Container(
                              padding: const EdgeInsets.symmetric(vertical: 10),
                              decoration: BoxDecoration(
                                color: _selectedTab == 1
                                    ? Colors.white
                                    : Colors.transparent,
                                borderRadius: BorderRadius.circular(9),
                                boxShadow: _selectedTab == 1
                                    ? [
                                        const BoxShadow(
                                          color: Colors.black12,
                                          blurRadius: 4,
                                          offset: Offset(0, 2),
                                        ),
                                      ]
                                    : null,
                              ),
                              alignment: Alignment.center,
                              child: Text(
                                'Existing Session (SDK Token)',
                                style: TextStyle(
                                  fontSize: 13,
                                  fontWeight: _selectedTab == 1
                                      ? FontWeight.w600
                                      : FontWeight.normal,
                                  color: _selectedTab == 1
                                      ? const Color(0xFF111827)
                                      : const Color(0xFF4B5563),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),

                  // Main Configuration Card
                  Card(
                    elevation: 0,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16),
                      side: const BorderSide(color: Color(0xFFE5E7EB)),
                    ),
                    color: Colors.white,
                    child: Padding(
                      padding: const EdgeInsets.all(20),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          if (_selectedTab == 0) ...[
                            _buildLabel('Secret Key'),
                            TextFormField(
                              controller: _secretKeyController,
                              decoration: _inputDecoration(
                                hintText: 'vp_sec_test_...',
                                icon: Icons.key_outlined,
                              ),
                              validator: (v) {
                                if (_selectedTab == 0 && (v == null || v.trim().isEmpty)) {
                                  return 'Secret key is required in test harness mode';
                                }
                                return null;
                              },
                            ),
                            const SizedBox(height: 14),
                            _buildLabel('Customer Reference (Optional)'),
                            TextFormField(
                              controller: _customerRefController,
                              decoration: _inputDecoration(
                                hintText: 'e.g. user_10293',
                                icon: Icons.person_outline,
                              ),
                            ),
                            const SizedBox(height: 14),
                            _buildLabel('Verification Type'),
                            DropdownButtonFormField<VerificationType>(
                              initialValue: _verificationType,
                              isExpanded: true,
                              decoration: _inputDecoration(
                                icon: Icons.badge_outlined,
                              ),
                              items: VerificationType.values.map((t) {
                                return DropdownMenuItem(
                                  value: t,
                                  child: Text(
                                    t.label,
                                    style: const TextStyle(fontSize: 13.5),
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                );
                              }).toList(),
                              onChanged: (val) {
                                if (val != null) {
                                  setState(() => _verificationType = val);
                                }
                              },
                            ),
                          ] else ...[
                            _buildLabel('Session ID'),
                            TextFormField(
                              controller: _sessionIdController,
                              decoration: _inputDecoration(
                                hintText: 'vps_...',
                                icon: Icons.fingerprint,
                              ),
                              validator: (v) {
                                if (_selectedTab == 1 && (v == null || v.trim().isEmpty)) {
                                  return 'Session ID is required';
                                }
                                return null;
                              },
                            ),
                            const SizedBox(height: 14),
                            _buildLabel('SDK Token'),
                            TextFormField(
                              controller: _sdkTokenController,
                              decoration: _inputDecoration(
                                hintText: 'vp_tok_...',
                                icon: Icons.lock_outline,
                              ),
                              validator: (v) {
                                if (_selectedTab == 1 && (v == null || v.trim().isEmpty)) {
                                  return 'SDK token is required';
                                }
                                return null;
                              },
                            ),
                          ],

                          const SizedBox(height: 18),
                          const Divider(color: Color(0xFFE5E7EB)),
                          const SizedBox(height: 12),

                          // Advanced Endpoint Settings
                          Theme(
                            data: Theme.of(context).copyWith(
                              dividerColor: Colors.transparent,
                            ),
                            child: ExpansionTile(
                              tilePadding: EdgeInsets.zero,
                              title: const Text(
                                'Advanced: Server Endpoints',
                                style: TextStyle(
                                  fontSize: 13,
                                  fontWeight: FontWeight.w600,
                                  color: Color(0xFF4B5563),
                                ),
                              ),
                              children: [
                                const SizedBox(height: 8),
                                _buildLabel('API Base URL'),
                                TextFormField(
                                  controller: _apiBaseController,
                                  decoration: _inputDecoration(
                                    hintText: 'http://localhost:3000',
                                    icon: Icons.dns_outlined,
                                  ),
                                  validator: (v) =>
                                      v == null || v.isEmpty ? 'Required' : null,
                                ),
                                const SizedBox(height: 12),
                                _buildLabel('Hosted Web Verification URL'),
                                TextFormField(
                                  controller: _hostedBaseController,
                                  decoration: _inputDecoration(
                                    hintText: 'http://localhost:5174',
                                    icon: Icons.language_outlined,
                                  ),
                                  validator: (v) =>
                                      v == null || v.isEmpty ? 'Required' : null,
                                ),
                              ],
                            ),
                          ),

                          if (_errorMessage != null) ...[
                            const SizedBox(height: 16),
                            Container(
                              padding: const EdgeInsets.all(12),
                              decoration: BoxDecoration(
                                color: const Color(0xFFFEE2E2),
                                borderRadius: BorderRadius.circular(8),
                              ),
                              child: Row(
                                children: [
                                  const Icon(
                                    Icons.error_outline,
                                    color: Color(0xFFDC2626),
                                    size: 20,
                                  ),
                                  const SizedBox(width: 8),
                                  Expanded(
                                    child: Text(
                                      _errorMessage!,
                                      style: const TextStyle(
                                        color: Color(0xFFDC2626),
                                        fontSize: 13,
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],

                          const SizedBox(height: 20),
                          SizedBox(
                            width: double.infinity,
                            height: 48,
                            child: ElevatedButton(
                              onPressed: _isCreatingSession
                                  ? null
                                  : () => _handleStartVerification(useModal: true),
                              style: ElevatedButton.styleFrom(
                                backgroundColor: primaryColor,
                                foregroundColor: Colors.white,
                                shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(10),
                                ),
                                elevation: 0,
                              ),
                              child: _isCreatingSession
                                  ? const SizedBox(
                                      height: 20,
                                      width: 20,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2.5,
                                        valueColor:
                                            AlwaysStoppedAnimation<Color>(Colors.white),
                                      ),
                                    )
                                  : const Row(
                                      mainAxisAlignment: MainAxisAlignment.center,
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        Icon(Icons.launch, size: 18),
                                        SizedBox(width: 8),
                                        Flexible(
                                          child: Text(
                                            'Start Verification (SDK Modal)',
                                            overflow: TextOverflow.ellipsis,
                                            style: TextStyle(
                                              fontSize: 15,
                                              fontWeight: FontWeight.w600,
                                            ),
                                          ),
                                        ),
                                      ],
                                    ),
                            ),
                          ),
                          const SizedBox(height: 10),
                          SizedBox(
                            width: double.infinity,
                            height: 44,
                            child: OutlinedButton(
                              onPressed: _isCreatingSession
                                  ? null
                                  : () => _handleStartVerification(useModal: false),
                              style: OutlinedButton.styleFrom(
                                foregroundColor: primaryColor,
                                side: const BorderSide(color: Color(0xFF6D28D9)),
                                shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(10),
                                ),
                              ),
                              child: const Text(
                                'Open in Embedded View (VerifyPassView)',
                                style: TextStyle(
                                  fontSize: 14,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildLabel(String text) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Text(
        text,
        style: const TextStyle(
          fontSize: 13,
          fontWeight: FontWeight.w600,
          color: Color(0xFF374151),
        ),
      ),
    );
  }

  InputDecoration _inputDecoration({String? hintText, IconData? icon}) {
    return InputDecoration(
      hintText: hintText,
      hintStyle: const TextStyle(color: Color(0xFF9CA3AF), fontSize: 13.5),
      prefixIcon: icon != null
          ? Icon(icon, size: 20, color: const Color(0xFF6B7280))
          : null,
      filled: true,
      fillColor: const Color(0xFFF9FAFB),
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: Color(0xFFD1D5DB)),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: Color(0xFFD1D5DB)),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: Color(0xFF6D28D9), width: 1.5),
      ),
    );
  }
}
