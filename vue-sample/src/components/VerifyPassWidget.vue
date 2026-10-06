<script setup>
// Vue wrapper around the VerifyPass React SDK. React is an implementation
// detail of the widget: this component owns a private React root, re-renders
// it when props change and unmounts it (releasing the camera and ONNX models)
// when the Vue component is destroyed.
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { VerifyPassProvider, VerificationWidget } from "@verifypass/react";

const props = defineProps({
  sessionId: { type: String, required: true },
  sdkToken: { type: String, required: true },
  // undefined → the SDK's own default, null → explicitly disabled.
  publicKey: { type: [String, null], default: undefined },
  baseUrl: { type: [String, null], default: undefined },
  faceModelUrl: { type: [String, null], default: undefined },
  landmarkModelUrl: { type: [String, null], default: undefined },
  theme: { type: Object, default: undefined },
  consentCopy: { type: String, default: undefined },
  screenFlash: { type: Boolean, default: true }
});

const emit = defineEmits(["complete", "error", "step-change"]);

const container = ref(null);
let root = null;

// Stable callbacks so React does not see new handler identities per render.
const handlers = {
  onComplete: (result) => emit("complete", result),
  onError: (error) => emit("error", error),
  onStepChange: (step) => emit("step-change", step)
};

function withoutUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function render() {
  if (!root) return;
  const providerProps = withoutUndefined({
    publicKey: props.publicKey,
    baseUrl: props.baseUrl,
    faceModelUrl: props.faceModelUrl,
    landmarkModelUrl: props.landmarkModelUrl,
    env: import.meta.env
  });
  const widgetProps = withoutUndefined({
    sessionId: props.sessionId,
    sdkToken: props.sdkToken,
    theme: props.theme,
    consentCopy: props.consentCopy,
    screenFlash: props.screenFlash,
    ...handlers
  });
  root.render(
    createElement(VerifyPassProvider, providerProps,
      createElement(VerificationWidget, widgetProps))
  );
}

onMounted(() => {
  root = createRoot(container.value);
  render();
});

watch(() => ({ ...props }), render, { deep: true });

onBeforeUnmount(() => {
  const r = root;
  root = null;
  r?.unmount();
});
</script>

<template>
  <div ref="container" class="verifypass-widget" />
</template>
