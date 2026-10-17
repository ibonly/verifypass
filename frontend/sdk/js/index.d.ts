// Type declarations for @verifypass/sdk-js. The CDN bundle dist/verifypass.js
// exposes `init` as the `VerifyPass` global; dist/verifypass-liveness.js and
// "@verifypass/sdk-js/element" register <verifypass-liveness> (see element.d.ts).
import type { FaceDetector, VerificationResult, VerifyPassError } from "./types/core";

export {
  createVerificationController, VerifyPassClient, VerifyPassError, VerifyPassApiError, toVerifyPassError,
  startCamera, stopCamera, captureFrame, captureGuideFrame, assessFrame, nextVideoFrame, collectCaptureSignals,
  TERMINAL_STATUSES, LIVENESS_FRAME_BUDGET
} from "./types/core";
export type { ControllerState, VerificationController, VerificationResult, VerifyPassErrorCode, FlowStep, VerificationTheme, VerificationCopy, FaceDetector } from "./types/core";

export function createFaceDetector(modelUrl: string | ArrayBuffer, opts?: { landmarkUrl?: string | ArrayBuffer | null; framing?: Record<string, number>; ortWasmUrl?: string; assetBaseUrl?: string | null; signal?: AbortSignal }): Promise<FaceDetector>;
/** Framework-free auto-capture loop. Returns a stop function. */
export function runCaptureLoop(ctx: Record<string, unknown>): () => void;
export const DEFAULT_COPY: Record<string, any>;
export function mergeCopy(overrides?: Record<string, unknown>, consentCopy?: string): Record<string, any>;
export const CONSENT_COPY_VERSION: string;

export interface VerifyPassInitOptions {
  /** Element or CSS selector to render into. */
  container: string | HTMLElement;
  sessionId: string;
  sdkToken: string;
  publicKey?: string | null;
  baseUrl?: string | null;
  /** Show a QR code instead of the embedded iframe. Default false. */
  mobileHandoff?: boolean;
  /** UI hint only — confirm the outcome on your backend or via webhook. */
  onComplete?: (result: VerificationResult) => void;
  onError?: (error: VerifyPassError) => void;
  onTelemetry?: (event: { type: string; [key: string]: unknown }) => void;
}

export interface VerifyPassInstance {
  destroy(): void;
  /** Settles on a terminal outcome, an init failure, or destroy(). */
  ready: Promise<void>;
}

/** Hosted embed: iframe of the hosted page, or a QR handoff. */
export function init(opts: VerifyPassInitOptions): VerifyPassInstance;

declare global {
  interface Window {
    VerifyPass: { init: typeof init };
  }
}
