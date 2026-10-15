// ESM entry of @verifypass/sdk-js: the hosted embed (iframe / QR handoff) plus
// the headless building blocks for custom UIs. Everything is bundled.
import globalApi from "./global.js";

export const init = globalApi.init;
export {
  createVerificationController, VerifyPassClient, VerifyPassError, VerifyPassApiError, toVerifyPassError,
  startCamera, stopCamera, captureFrame, captureGuideFrame, assessFrame, nextVideoFrame, collectCaptureSignals,
  TERMINAL_STATUSES, LIVENESS_FRAME_BUDGET
} from "@verifypass/sdk-core";
// Framework-free modules of the React package, imported by path so React
// itself stays out of this bundle.
export { createFaceDetector } from "../../react/src/faceDetector.js";
export { runCaptureLoop } from "../../react/src/captureLoop.js";
export { DEFAULT_COPY, mergeCopy, CONSENT_COPY_VERSION } from "../../react/src/copy.js";
