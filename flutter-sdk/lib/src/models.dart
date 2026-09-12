enum VerificationType {
  idAndFace('ID_AND_FACE', 'ID + Face (document, liveness, selfie)'),
  faceOnly('FACE_ONLY', 'Face only (liveness, selfie)'),
  idOnly('ID_ONLY', 'ID only (document)');

  final String value;
  final String label;

  const VerificationType(this.value, this.label);

  static VerificationType fromValue(String value) {
    return VerificationType.values.firstWhere(
      (t) => t.value == value,
      orElse: () => VerificationType.idAndFace,
    );
  }
}

class VerificationSession {
  final String sessionId;
  final String sdkToken;
  final String? attemptId;
  final String verificationType;
  final String? customerReference;
  final String? hostedBaseUrl;
  final DateTime? expiresAt;
  final Map<String, dynamic> raw;

  VerificationSession({
    required this.sessionId,
    required this.sdkToken,
    this.attemptId,
    required this.verificationType,
    this.customerReference,
    this.hostedBaseUrl,
    this.expiresAt,
    required this.raw,
  });

  factory VerificationSession.fromJson(Map<String, dynamic> json) {
    return VerificationSession(
      sessionId: json['sessionId'] as String,
      sdkToken: json['sdkToken'] as String,
      attemptId: json['attemptId'] as String?,
      verificationType: (json['verificationType'] as String?) ?? 'ID_AND_FACE',
      customerReference: json['customerReference'] as String?,
      hostedBaseUrl: json['hostedBaseUrl'] as String?,
      expiresAt: json['expiresAt'] != null
          ? DateTime.tryParse(json['expiresAt'].toString())
          : null,
      raw: json,
    );
  }

  /// Builds the URL for the hosted verification flow.
  ///
  /// [redirectUrl] can be a custom app URI like `verifypass://complete`
  /// or a standard HTTPS callback.
  Uri buildHostedUri(String baseUrl, {String? redirectUrl}) {
    final cleanBase = baseUrl.replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$cleanBase/session/$sessionId');
    final fragParams = <String, String>{
      't': sdkToken,
      if (redirectUrl != null && redirectUrl.isNotEmpty) 'r': redirectUrl,
    };
    final fragment = fragParams.entries
        .map((e) => '${Uri.encodeComponent(e.key)}=${Uri.encodeComponent(e.value)}')
        .join('&');
    return uri.replace(fragment: fragment);
  }
}

class VerificationStatusResponse {
  final bool success;
  final String sessionId;
  final String status;
  final String? attemptId;
  final List<String> reasonCodes;
  final Map<String, dynamic> raw;

  VerificationStatusResponse({
    required this.success,
    required this.sessionId,
    required this.status,
    this.attemptId,
    required this.reasonCodes,
    required this.raw,
  });

  factory VerificationStatusResponse.fromJson(Map<String, dynamic> json) {
    final decision = json['decision'] as Map<String, dynamic>?;
    final reasonCodesList = decision != null && decision['reasonCodes'] is List
        ? (decision['reasonCodes'] as List).map((e) => e.toString()).toList()
        : <String>[];

    return VerificationStatusResponse(
      success: json['success'] == true,
      sessionId: json['sessionId'] as String? ?? '',
      status: json['status'] as String? ?? 'unknown',
      attemptId: json['attemptId'] as String?,
      reasonCodes: reasonCodesList,
      raw: json,
    );
  }

  bool get isTerminal =>
      ['approved', 'rejected', 'manual_review', 'failed', 'expired', 'cancelled']
          .contains(status);

  bool get isApproved => status == 'approved';
  bool get isManualReview => status == 'manual_review';
  bool get isRejected => status == 'rejected';
  bool get isFailed => status == 'failed';
  bool get isExpired => status == 'expired';
  bool get isCancelled => status == 'cancelled';
}

class VerificationResult {
  final bool success;
  final String sessionId;
  final String status;
  final String? riskLevel;
  final String? customerReference;
  final String? verificationType;
  final List<String> reasonCodes;

  // Document details
  final String? documentStatus;
  final double? ocrConfidence;
  final Map<String, dynamic>? extractedData;

  // Liveness details
  final String? livenessStatus;
  final double? livenessScore;
  final double? selfieScore;
  final String? activeStatus;
  final Map<String, dynamic>? livenessChallenge;

  // Face match
  final String? faceMatchStatus;
  final double? faceMatchScore;

  final DateTime? completedAt;
  final Map<String, dynamic> raw;

  VerificationResult({
    required this.success,
    required this.sessionId,
    required this.status,
    this.riskLevel,
    this.customerReference,
    this.verificationType,
    required this.reasonCodes,
    this.documentStatus,
    this.ocrConfidence,
    this.extractedData,
    this.livenessStatus,
    this.livenessScore,
    this.selfieScore,
    this.activeStatus,
    this.livenessChallenge,
    this.faceMatchStatus,
    this.faceMatchScore,
    this.completedAt,
    required this.raw,
  });

  factory VerificationResult.fromJson(Map<String, dynamic> json) {
    final decision = json['decision'] as Map<String, dynamic>?;
    final codes = decision != null && decision['reasonCodes'] is List
        ? (decision['reasonCodes'] as List).map((e) => e.toString()).toList()
        : <String>[];

    final doc = json['document'] as Map<String, dynamic>?;
    final liveness = json['liveness'] as Map<String, dynamic>?;
    final faceMatch = json['faceMatch'] as Map<String, dynamic>?;
    final lc = json['livenessChallenge'] as Map<String, dynamic>?;

    return VerificationResult(
      success: json['success'] == true,
      sessionId: json['sessionId'] as String? ?? '',
      status: json['status'] as String? ?? 'unknown',
      riskLevel: json['riskLevel'] as String?,
      customerReference: json['customerReference'] as String?,
      verificationType: json['verificationType'] as String?,
      reasonCodes: codes,
      documentStatus: doc?['status'] as String?,
      ocrConfidence: (doc?['ocrConfidence'] as num?)?.toDouble(),
      extractedData: doc?['extractedData'] as Map<String, dynamic>?,
      livenessStatus: liveness?['status'] as String?,
      livenessScore: (liveness?['score'] as num?)?.toDouble(),
      selfieScore: (liveness?['selfieScore'] as num?)?.toDouble(),
      activeStatus: liveness?['activeStatus'] as String?,
      livenessChallenge: lc,
      faceMatchStatus: faceMatch?['status'] as String?,
      faceMatchScore: (faceMatch?['similarityScore'] as num?)?.toDouble(),
      completedAt: json['completedAt'] != null
          ? DateTime.tryParse(json['completedAt'].toString())
          : null,
      raw: json,
    );
  }

  bool get isApproved => status == 'approved';
  bool get isManualReview => status == 'manual_review';
  bool get isRejected => status == 'rejected';
}
