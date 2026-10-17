<script setup>
// Thin Vue wrapper around the framework-free <verifypass-liveness> custom
// element. The element bundles its own runtime and loads the face models and
// WASM from the VerifyPass hosted origin, so this app installs nothing else.
import "@verifypass/sdk-js/element";

defineProps({
  sessionId: { type: String, required: true },
  sdkToken: { type: String, required: true },
  // Omitted → token-only auth (the sdkToken is the credential).
  publicKey: { type: String, default: undefined },
  // Omitted → the API origin embedded in the sdkToken.
  baseUrl: { type: String, default: undefined },
  // Tri-state: true = QR only, false = this device only, undefined = user
  // chooses. Explicit default keeps Vue from casting an absent prop to false.
  mobileHandoff: { type: Boolean, default: undefined },
  screenFlash: { type: Boolean, default: true },
  theme: { type: Object, default: undefined },
  copy: { type: Object, default: undefined },
  consentCopy: { type: String, default: undefined }
});

const emit = defineEmits(["complete", "error", "step-change", "telemetry"]);
</script>

<template>
  <verifypass-liveness
    :session-id="sessionId"
    :sdk-token="sdkToken"
    :public-key="publicKey ?? null"
    :base-url="baseUrl ?? null"
    :mobile-handoff="mobileHandoff === undefined ? null : String(mobileHandoff)"
    :screen-flash="String(screenFlash)"
    :consent-copy="consentCopy ?? null"
    .theme="theme"
    .copy="copy"
    @vp-complete="emit('complete', $event.detail)"
    @vp-error="emit('error', $event.detail)"
    @vp-step-change="emit('step-change', $event.detail.step)"
    @vp-telemetry="emit('telemetry', $event.detail)"
  />
</template>
