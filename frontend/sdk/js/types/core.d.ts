// Type declarations for @verifypass/sdk-core. The integration surface
// (client, errors, flow, config) is typed precisely; capture/math helpers used
// by the UI layers are typed loosely and may change between minor versions.

export type VerificationType = "ID_AND_FACE" | "ID_ONLY" | "FACE_ONLY";
export type VerificationStatus = "created" | "started" | "submitted" | TerminalStatus;
export type TerminalStatus = "approved" | "rejected" | "manual_review" | "expired" | "failed" | "abandoned";
export type FlowStep = "document" | "document_back" | "liveness" | "face" | "mobile" | "processing" | "complete";

/** Response of GET /status. `decision` and `liveness` are present only on terminal statuses. */
export interface VerificationResult {
  success: true;
  sessionId: string;
  status: VerificationStatus;
  attemptId: string | null;
  release?: unknown;
  /** User-actionable reason codes only; fraud signals are withheld from the browser. */
  decision?: { status: TerminalStatus; reasonCodes: string[] };
  liveness?: { score: number | null; selfieScore: number | null };
}

export type VerifyPassErrorCode =
  | "CAMERA_PERMISSION_DENIED"
  | "CAMERA_NOT_FOUND"
  | "CAMERA_IN_USE"
  | "CAMERA_UNSUPPORTED"
  | "CAMERA_ERROR"
  | "NETWORK_ERROR"
  | "REQUEST_TIMEOUT"
  | "POLLING_TIMEOUT"
  | "INVALID_RESPONSE"
  | "INIT_FAILED"
  | "UNSUPPORTED_WORKFLOW"
  | "CAPTURE_FAILED"
  | "UNKNOWN_ERROR"
  // Server error codes (SESSION_EXPIRED, SESSION_NOT_FOUND, INVALID_API_KEY, ...)
  | (string & {});

/** Every SDK `onError` callback receives one of these. */
export class VerifyPassError extends Error {
  constructor(code: VerifyPassErrorCode, message: string, opts?: { cause?: unknown; http?: number });
  code: VerifyPassErrorCode;
  /** HTTP status for API errors. */
  http?: number;
  /** Original error (DOMException, TypeError, ...). */
  cause?: unknown;
}

/** Error returned by the VerifyPass API. */
export class VerifyPassApiError extends VerifyPassError {
  constructor(code: string, message: string, http?: number);
  http: number;
  correlationId?: string | null;
}

export function toVerifyPassError(err: unknown, fallbackCode?: VerifyPassErrorCode, opts?: { camera?: boolean }): VerifyPassError;
export const CAMERA_ERROR_CODES: Readonly<Record<string, VerifyPassErrorCode>>;

export interface VerifyPassClientOptions {
  /** vps_... */
  sessionId: string;
  /** sdk_v1_... (embeds the API origin, so baseUrl is usually unnecessary). */
  sdkToken: string;
  /** vp_pub_... — never a secret key. */
  publicKey?: string | null;
  /** Override for dev proxies or legacy tokens; must match the token's origin. */
  baseUrl?: string | null;
  fetchImpl?: typeof fetch;
}

export interface Challenge {
  success: true;
  verificationType?: VerificationType;
  livenessActions?: string[];
  documentTypes?: string[];
  attemptId?: string;
  flashSequence?: unknown;
  hostedBaseUrl?: string | null;
  handoffToken?: string | null;
  handoffExpiresAt?: string | null;
  expiresAt?: string | null;
  attempts?: number;
  maxAttempts?: number;
  manualUploadSuggested?: boolean;
  [key: string]: unknown;
}

export class VerifyPassClient {
  constructor(opts: VerifyPassClientOptions);
  readonly baseUrl: string;
  readonly sessionId: string;
  readonly controller: AbortController;
  dispose(): void;
  getChallenge(opts?: { mobileHandoff?: boolean }): Promise<Challenge>;
  getHostedUrl(hostedBaseUrl?: string | null, handoffToken?: string | null): string;
  beginChallenge(): Promise<{ challengeExpiresAt?: string; firstFrameDeadline?: string; sessionExpiresAt?: string; [key: string]: unknown }>;
  recordConsent(copyVersion?: string | null): Promise<unknown>;
  uploadDocument(imageBase64: string, side?: "front" | "back"): Promise<unknown>;
  uploadFace(imageBase64: string, side?: string): Promise<unknown>;
  uploadLivenessFrame(action: string, imageBase64: string, captureMode?: "auto" | "manual" | "fallback" | "unknown"): Promise<unknown>;
  uploadFlash(imageBase64: string, sequence: unknown, tile: unknown): Promise<unknown>;
  retrySession(): Promise<{ attempts: number; maxAttempts: number; manualUploadSuggested: boolean; livenessChallenge: { actions: string[] } | null; [key: string]: unknown }>;
  reissueChallenge(excludeActions?: string[]): Promise<unknown>;
  setCaptureSignals(signals: unknown): void;
  setCaptureTelemetry(telemetry: unknown): void;
  submit(): Promise<unknown>;
  getStatus(opts?: { timeoutMs?: number }): Promise<VerificationResult>;
  /** Resolves on a terminal status; transient failures are retried until timeoutMs. */
  waitForResult(opts?: { intervalMs?: number; timeoutMs?: number; onTick?: (status: VerificationResult) => void; signal?: AbortSignal }): Promise<VerificationResult>;
}

export function parseSdkToken(token: string): { baseUrl: string | null };
export function parseHandoffToken(token: string): { baseUrl: string | null };
export function claimMobileHandoff(opts: { sessionId: string; handoffToken: string; baseUrl?: string | null; fetchImpl?: typeof fetch }): Promise<{ success: true; sdkToken: string; [key: string]: unknown }>;
export function pollingTimeoutForExpiry(expiresAt: string | number | Date | null | undefined, fallbackMs?: number, graceMs?: number): number;

export interface PublicConfig {
  baseUrl: string | null;
  publicKey: string | null;
  faceModelUrl: string | null;
  landmarkModelUrl: string | undefined;
  ortWasmUrl: string | undefined;
}
/** Reads VITE_VP_API_BASE / VP_API_BASE, VITE_VP_PUBLIC_KEY, VITE_VP_FACE_MODEL_URL, VITE_VP_LANDMARK_MODEL_URL, VITE_VP_ORT_WASM_URL. */
export function readPublicConfig(env?: Record<string, string | undefined>): PublicConfig;

export interface FlowState {
  step: FlowStep;
  error: { code: string; message: string } | null;
  result: VerificationResult | null;
  [key: string]: unknown;
}
export interface Flow {
  state(): FlowState;
  advance(): FlowState;
  fail(err: { code?: string; message?: string } | Error): FlowState;
  finish(result: VerificationResult): FlowState;
  onChange(fn: (state: FlowState) => void): () => void;
  [key: string]: unknown;
}
export function createFlow(verificationType?: VerificationType, opts?: { documentBack?: boolean; mobileHandoff?: boolean }): Flow;
export function needsDocumentBack(documentTypes: string[]): boolean;
export const STEP_SEQUENCES: Readonly<Record<VerificationType, FlowStep[]>>;
export const MOBILE_HANDOFF_SEQUENCES: Readonly<Record<VerificationType, FlowStep[]>>;
export const TERMINAL_STATUSES: TerminalStatus[];

// ── Shared UI types (React widget and <verifypass-liveness>) ─────────
/** Theme tokens, applied as --vp-* CSS custom properties (also settable from host CSS). */
export interface VerificationTheme {
  primaryColor?: string;
  onPrimaryColor?: string;
  surfaceColor?: string;
  backgroundColor?: string;
  textColor?: string;
  mutedColor?: string;
  borderColor?: string;
  successColor?: string;
  warningColor?: string;
  dangerColor?: string;
  fontFamily?: string;
  borderRadius?: string;
  logoUrl?: string;
}
type CopyEntry = string | ((...args: any[]) => string);
/** Partial overrides of DEFAULT_COPY, merged one level per section. */
export type VerificationCopy = { [section: string]: string | { [key: string]: CopyEntry | { [key: string]: string } } };
export interface TelemetryEvent { type: string; [key: string]: unknown }
export interface FaceDetector {
  detect(imageData: ImageData): Promise<Record<string, unknown>>;
  hasLandmarks: boolean;
  dispose(): void;
}

// ── Headless controller ─────────────────────────────────────────────
export interface HandoffState {
  allowsChoice: boolean;
  enabled: boolean;
  /** Hosted URL with the one-time handoff token in its fragment. Sensitive. */
  url: string | null;
  expiresAt: string | null;
  handoffExpiresAt: string | null;
  phase: "waiting" | "verifying" | "finalising";
  polling: boolean;
  error: string | null;
  linkStatus: "copied" | "copy_failed" | null;
}

export interface ControllerState {
  status: "idle" | "loading" | "ready" | "error";
  initError: string | null;
  flow: FlowState | null;
  verificationType: VerificationType | null;
  actions: string[];
  actionIndex: number;
  consented: boolean;
  busy: boolean;
  feedback: string | null;
  attempts: { attempts: number; manualUpload: boolean; exhausted: boolean };
  challengeEpoch: number;
  attemptEpoch: number;
  hostedBaseUrl: string | null;
  handoff: HandoffState;
}

export interface CaptureHelpers {
  document(base64: string): Promise<false | undefined>;
  livenessFrame(base64: string, mode?: "auto" | "manual" | "fallback", advance?: boolean): Promise<true>;
  face(base64: string, opts?: { flash?: (sequence: unknown, signal: AbortSignal) => Promise<{ base64: string; sequence: unknown; tile: unknown } | null> }): Promise<false | undefined>;
}

export interface VerificationControllerOptions extends VerifyPassClientOptions {
  /** true = QR only, false = this device only, undefined = user chooses. */
  mobileHandoff?: boolean;
  onComplete?: (result: VerificationResult) => void;
  onError?: (error: VerifyPassError) => void;
  onStepChange?: (step: FlowStep) => void;
  onTelemetry?: (event: { type: string; [key: string]: unknown }) => void;
}

export interface VerificationController {
  start(): Promise<void>;
  dispose(): void;
  getState(): ControllerState;
  subscribe(listener: (state: ControllerState) => void): () => void;
  update(callbacks: Pick<VerificationControllerOptions, "onComplete" | "onError" | "onStepChange" | "onTelemetry">): void;
  recordConsent(copyVersion?: string | null): Promise<void>;
  selectHandoff(enabled: boolean): void;
  retryHandoff(): void;
  copyHandoffLink(): Promise<void>;
  /** One capture attempt: grab a frame in `fn`, then call a capture helper. Single-flight; errors latch the step. */
  runCapture<T>(fn: (capture: CaptureHelpers) => Promise<T>): Promise<T | false | undefined>;
  uploadDocumentFile(file: File): Promise<void>;
  advanceLiveness(): void;
  livenessBudgetSpent(action?: string): boolean;
  framesUsed(action?: string): number;
  currentAction(): string | null;
  retry(): Promise<void>;
  reissue(): Promise<void>;
  retryStep(): void;
  advanceStep(): void;
  reportCameraError(err: unknown, userMessage?: string): void;
  emitTelemetry(event: { type: string; [key: string]: unknown }): void;
  setFeedback(message: string | null): void;
  getTelemetry(): Record<string, unknown>;
  isCapturing(): boolean;
  readonly client: VerifyPassClient | null;
}

export function createVerificationController(opts: VerificationControllerOptions): VerificationController;
export const LIVENESS_FRAME_BUDGET: number;

export function startCamera(video: HTMLVideoElement, opts?: { facingMode?: "user" | "environment"; width?: number; height?: number; signal?: AbortSignal; timeoutMs?: number }): Promise<MediaStream>;
export function stopCamera(video: HTMLVideoElement): void;
export function collectDeviceSignals(): Record<string, unknown> | null;
export function collectCaptureSignals(stream: MediaStream): Promise<Record<string, unknown> | null>;
export function fetchWithCache(url: string, opts?: { signal?: AbortSignal; [key: string]: unknown }): Promise<ArrayBuffer>;
export function clearModelCache(cacheName?: string): Promise<void>;
export function evictModel(url: string): Promise<void>;
export const DEFAULT_CACHE_NAME: string;

// Capture / math helpers (loosely typed).
type Helper = (...args: any[]) => any;
export const captureFrame: Helper, captureGuideFrame: Helper, grabAnalysisFrame: Helper, grabFixedFrame: Helper, grabSquareFrame: Helper, nextVideoFrame: Helper;
export const toGrayscale: Helper, laplacianVariance: Helper, meanBrightness: Helper, frameMotion: Helper, assessFrame: Helper;
export const poseFromLandmarks: Helper, landmarkInputFromImageData: Helper, poseActionVerdict: Helper, isFrontalPose: Helper, isReferencePose: Helper, frontalRefFromSamples: Helper, createPoseSmoother: Helper, exprFromLandmarks: Helper, eyeAspectRatio: Helper, mouthAspectRatio: Helper;
export const actionGeometry: Helper, bandMotion: Helper, createActionDetector: Helper;
export const createDocumentGate: Helper, assessDocumentShape: Helper, isDominantFace: Helper;
export const createFramingStabilizer: Helper, detectActionTrigger: Helper;
export const bestFaceBox: Helper, assessFraming: Helper;
export const randomFlashSequence: Helper, flashCropRect: Helper, meanRgb: Helper;
export const DEFAULT_RULES: any, POSE_THRESHOLDS: any, LANDMARK_INPUT: any, EXPRESSION: any, ACTION_GEO: any, DOCUMENT_GATE_DEFAULTS: any, DOCUMENT_SHAPE_DEFAULTS: any, STABILIZER_DEFAULTS: any, ACTION_TRIGGER: any, DETECT_CONFIG: any, FLASH: any;
