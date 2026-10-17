// <verifypass-liveness>: the full VerifyPass widget as a framework-free
// custom element. React, the capture engine, ONNX Runtime and the QR encoder
// are bundled; the face models and WASM come from the hosted VerifyPass
// origin. The host page installs and configures nothing else.
//
//   <verifypass-liveness session-id="vps_…" sdk-token="sdk_v1_…"></verifypass-liveness>
//   el.addEventListener("vp-complete", (e) => …e.detail)
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { VerificationWidget } from "@verifypass/react";

const ATTRIBUTES = [
  "session-id", "sdk-token", "public-key", "base-url", "mobile-handoff", "screen-flash",
  "primary-color", "logo-url", "consent-copy", "face-model-url", "landmark-model-url", "ort-wasm-url", "theme", "copy"
];
const HOST_STYLE = ":host { display: block; } :host([hidden]) { display: none; }";

const triState = (value) => (value === null ? undefined : value !== "false");
const urlOrOff = (value) => (value === null ? undefined : value === "off" ? null : value);
function parseJson(value) {
  if (!value) return undefined;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" ? parsed : undefined; } catch (_) { return undefined; }
}

export class VerifyPassLivenessElement extends HTMLElement {
  static get observedAttributes() { return ATTRIBUTES; }

  constructor() {
    super();
    this._root = null;
    this._props = {};
  }

  // Object-valued settings are also accepted as properties.
  get theme() { return this._props.theme; }
  set theme(value) { this._props.theme = value; this._render(); }
  get copy() { return this._props.copy; }
  set copy(value) { this._props.copy = value; this._render(); }
  get sessionId() { return this._props.sessionId ?? this.getAttribute("session-id"); }
  set sessionId(value) { this._props.sessionId = value; this._render(); }
  get sdkToken() { return this._props.sdkToken ?? this.getAttribute("sdk-token"); }
  set sdkToken(value) { this._props.sdkToken = value; this._render(); }

  connectedCallback() {
    if (!this._root) {
      const shadow = this.shadowRoot || this.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = HOST_STYLE;
      const mount = document.createElement("div");
      shadow.replaceChildren(style, mount);
      this._root = createRoot(mount);
    }
    this._render();
  }

  disconnectedCallback() {
    // Unmount releases the camera, ONNX sessions and polling.
    const root = this._root;
    this._root = null;
    if (root) root.unmount();
  }

  attributeChangedCallback() { this._render(); }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  _render() {
    if (!this._root) return;
    const sessionId = this.sessionId;
    const sdkToken = this.sdkToken;
    if (!sessionId || !sdkToken) { this._root.render(null); return; }
    const attr = (name) => this.getAttribute(name);
    const theme = {
      ...parseJson(attr("theme")),
      ...(attr("primary-color") ? { primaryColor: attr("primary-color") } : {}),
      ...(attr("logo-url") ? { logoUrl: attr("logo-url") } : {}),
      ...this._props.theme
    };
    this._root.render(createElement(VerificationWidget, {
      sessionId,
      sdkToken,
      publicKey: attr("public-key") ?? undefined,
      baseUrl: attr("base-url") ?? undefined,
      faceModelUrl: urlOrOff(attr("face-model-url")),
      landmarkModelUrl: urlOrOff(attr("landmark-model-url")),
      ortWasmUrl: attr("ort-wasm-url") ?? undefined,
      mobileHandoff: triState(attr("mobile-handoff")),
      screenFlash: attr("screen-flash") !== "false",
      consentCopy: attr("consent-copy") ?? undefined,
      copy: this._props.copy ?? parseJson(attr("copy")),
      theme,
      onComplete: (result) => this._emit("vp-complete", result),
      onError: (error) => this._emit("vp-error", error),
      onStepChange: (step) => this._emit("vp-step-change", { step }),
      onTelemetry: (event) => this._emit("vp-telemetry", event)
    }));
  }
}

/** Register the element (idempotent). Called on import with the default tag. */
export function defineVerifyPassLiveness(tagName = "verifypass-liveness") {
  if (typeof customElements !== "undefined" && !customElements.get(tagName)) {
    customElements.define(tagName, class extends VerifyPassLivenessElement {});
  }
}

defineVerifyPassLiveness();
