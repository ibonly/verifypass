// <verifypass-liveness> — self-registering custom element (React bundled).
import type { FlowStep, VerificationCopy, VerificationResult, VerificationTheme, VerifyPassError } from "./types/core";

export interface VerifyPassLivenessEventMap {
  "vp-complete": CustomEvent<VerificationResult>;
  "vp-error": CustomEvent<VerifyPassError>;
  "vp-step-change": CustomEvent<{ step: FlowStep }>;
  "vp-telemetry": CustomEvent<{ type: string; [key: string]: unknown }>;
}

/**
 * Attributes: session-id, sdk-token (required); public-key, base-url,
 * mobile-handoff ("true" | "false" | absent = user chooses), screen-flash ("false" to disable),
 * primary-color, logo-url, consent-copy, theme (JSON), copy (JSON),
 * face-model-url / landmark-model-url ("off" disables), ort-wasm-url.
 */
export class VerifyPassLivenessElement extends HTMLElement {
  sessionId: string | null;
  sdkToken: string | null;
  theme: VerificationTheme | undefined;
  copy: VerificationCopy | undefined;
  addEventListener<K extends keyof VerifyPassLivenessEventMap>(type: K, listener: (this: VerifyPassLivenessElement, ev: VerifyPassLivenessEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
}

/** Register under another tag name (idempotent). The default tag is registered on import. */
export function defineVerifyPassLiveness(tagName?: string): void;

declare global {
  interface HTMLElementTagNameMap {
    "verifypass-liveness": VerifyPassLivenessElement;
  }
}
