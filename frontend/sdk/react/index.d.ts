// Type declarations for @verifypass/react.
import type { ReactElement, ReactNode, RefObject } from "react";
import type { ControllerState, FaceDetector, FlowStep, TelemetryEvent, VerificationController, VerificationCopy, VerificationResult, VerificationTheme, VerifyPassError } from "@verifypass/sdk-core";

export type { ControllerState, FaceDetector, FlowStep, TelemetryEvent, VerificationController, VerificationCopy, VerificationResult, VerificationTheme, VerifyPassErrorCode, TerminalStatus, VerificationStatus } from "@verifypass/sdk-core";
export { claimMobileHandoff, createVerificationController, VerifyPassError } from "@verifypass/sdk-core";

/** Shared configuration. Everything is optional; so is the provider itself. */
export interface VerifyPassConfig {
  /** vp_pub_... public key; null/omitted = token-only auth. Defaults to VITE_VP_PUBLIC_KEY. */
  publicKey?: string | null;
  /** API origin override; normally derived from the self-locating sdkToken. */
  baseUrl?: string | null;
  /** fr_detect.onnx URL. Omitted = served by the hosted VerifyPass origin; null disables the detector. */
  faceModelUrl?: string | null;
  /** fr_landmark.onnx URL. undefined = sibling of faceModelUrl; null = geometry only. */
  landmarkModelUrl?: string | null;
  /** onnxruntime-web WASM URL. Omitted = bundler asset (Vite) or the hosted VerifyPass origin. */
  ortWasmUrl?: string;
}

export interface VerifyPassProviderProps extends VerifyPassConfig {
  /** Public env (VITE_VP_*) for non-Vite apps; defaults to import.meta.env. */
  env?: Record<string, string | undefined>;
  children?: ReactNode;
}

export interface VerificationOptions extends VerifyPassConfig {
  sessionId: string;
  sdkToken: string;
  /** true = QR handoff only; false = this device only; undefined = user chooses on the consent screen. */
  mobileHandoff?: boolean;
  /** Screen-flash liveness step. Default true. */
  screenFlash?: boolean;
  copy?: VerificationCopy;
  /** Overriding the consent wording makes you responsible for its audit trail. */
  consentCopy?: string;
  /** UI hint only — confirm the outcome on your backend or via webhook. */
  onComplete?: (result: VerificationResult) => void;
  onError?: (error: VerifyPassError) => void;
  onStepChange?: (step: FlowStep) => void;
  onTelemetry?: (event: TelemetryEvent) => void;
}

export interface VerificationWidgetProps extends VerificationOptions {
  theme?: VerificationTheme;
  className?: string;
}

/** Headless state + actions; bind videoRef to a <video> and render your own UI. */
export interface UseVerificationResult {
  state: ControllerState | null;
  step: FlowStep | null;
  copy: Record<string, any>;
  currentAction: string | null;
  videoRef: RefObject<HTMLVideoElement>;
  overlayRef: RefObject<HTMLCanvasElement>;
  cameraReady: boolean;
  cameraPaused: boolean;
  detectorStatus: "loading" | "ready" | "failed" | "disabled";
  hasLandmarks: boolean;
  /** Subject is in position (auto-capture about to fire). */
  green: boolean;
  framingGuide: string;
  livePhase: { phase: "align" | "await" | "capturing"; startedAt: number; total: number; hint?: string | false };
  docSeen: boolean;
  docShapeOk: boolean;
  docFaceBlocked: boolean;
  canReissue: boolean;
  debugInfo: Record<string, unknown> | null;
  /** [r,g,b] while the screen-flash sequence runs: paint the viewport with it. */
  flashColor: [number, number, number] | null;
  qrDataUrl: string | null;
  qrError: "encode" | "load" | null;
  capture(opts?: { livenessAdvance?: boolean; mode?: "auto" | "manual" | "fallback"; advanceOnly?: boolean }): Promise<unknown>;
  retryInit(): void;
  recordConsent(copyVersion?: string): void;
  selectHandoff(enabled: boolean): void;
  retryHandoff(): void;
  copyHandoffLink(): void;
  retryQr(): void;
  uploadDocumentFile(file: File): void;
  retry(): void;
  reissue(): void;
  retryStep(): void;
  resumeCamera(): void;
  controller: VerificationController | null;
}

export function VerifyPassProvider(props: VerifyPassProviderProps): ReactElement;
export function useVerifyPass(): Required<VerifyPassConfig>;
export function useVerifyPassConfig(): VerifyPassConfig;
export function useVerification(opts: VerificationOptions): UseVerificationResult;
export function VerificationWidget(props: VerificationWidgetProps): ReactElement;

export function createFaceDetector(modelUrl: string | ArrayBuffer, opts?: { landmarkUrl?: string | ArrayBuffer | null; framing?: Record<string, number>; ortWasmUrl?: string; assetBaseUrl?: string | null; signal?: AbortSignal }): Promise<FaceDetector>;
/** Framework-free auto-capture loop used by useVerification. Returns a stop function. */
export function runCaptureLoop(ctx: Record<string, unknown>): () => void;

export const DEFAULT_COPY: Record<string, any>;
export function mergeCopy(overrides?: VerificationCopy, consentCopy?: string): Record<string, any>;
export const CONSENT_COPY_VERSION: string;
export const ORT_VERSION: string;
export const DEFAULT_FACE_MODEL_URL: string;
/** @deprecated Sample-app test constants; never used as SDK defaults. */
export const LIVE_TEST_API_BASE: string;
/** @deprecated Sample-app test constants; never used as SDK defaults. */
export const LIVE_TEST_PUBLIC_KEY: string;
