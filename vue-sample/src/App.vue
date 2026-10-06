<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import VerifyPassWidget from "./components/VerifyPassWidget.vue";
import { createVerificationSession, getServerConfig, getVerificationResult } from "./lib/api.js";

// Outcomes the widget can recover from itself (its result screen offers
// "Try again" and manual ID upload), so keep it mounted for these.
const RETRYABLE_STATUSES = ["rejected", "manual_review", "failed"];

const widgetConfig = {
  // Token-only auth by default: the sdkToken from our server is the credential.
  publicKey: import.meta.env.VITE_VP_PUBLIC_KEY || null,
  // Route the widget's API calls through this app's own origin (relayed by
  // server/sdkProxy.mjs), so VerifyPass does not need to allowlist our origin
  // for CORS. Set VITE_VP_API_BASE to call the API directly instead (that
  // origin must then be on VerifyPass's CORS allowlist).
  baseUrl: import.meta.env.VITE_VP_API_BASE || window.location.origin,
  faceModelUrl: import.meta.env.VITE_VP_FACE_MODEL_URL || "/models/fr_detect.onnx",
  landmarkModelUrl: import.meta.env.VITE_VP_LANDMARK_MODEL_URL || undefined,
  theme: { primaryColor: "#0F766E" }
};

const serverConfig = ref(null);
const customerReference = ref("");
const verificationType = ref("FACE_ONLY");
const session = ref(null);
const widgetResult = ref(null);
const verifiedResult = ref(null);
const error = ref(null);
const busy = ref(false);
const cameraState = ref("pending");
const lastStep = ref(null);

const showWidget = computed(() =>
  session.value && (!widgetResult.value || RETRYABLE_STATUSES.includes(widgetResult.value.status)));
const finalResult = computed(() =>
  widgetResult.value && !RETRYABLE_STATUSES.includes(widgetResult.value.status) ? widgetResult.value : null);

let cancelled = false;
onBeforeUnmount(() => { cancelled = true; });

onMounted(async () => {
  getServerConfig()
    .then((config) => { if (!cancelled) serverConfig.value = config; })
    .catch((err) => { if (!cancelled) error.value = err.message; });

  // Ask for camera permission up front so the widget starts without a prompt.
  const media = navigator.mediaDevices;
  if (!media?.getUserMedia) {
    cameraState.value = "unsupported";
    return;
  }
  try {
    const stream = await media.getUserMedia({ video: { facingMode: "user" } });
    stream.getTracks().forEach((track) => track.stop());
    if (!cancelled) cameraState.value = "granted";
  } catch {
    if (!cancelled) cameraState.value = "denied";
  }
});

async function startVerification() {
  error.value = null;
  widgetResult.value = null;
  verifiedResult.value = null;
  busy.value = true;
  try {
    session.value = await createVerificationSession({
      customerReference: customerReference.value,
      verificationType: verificationType.value
    });
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

function onComplete(result) {
  widgetResult.value = result;
}

function onStepChange(step) {
  lastStep.value = step;
  // A retry restarted the flow inside the widget; drop the stale outcome.
  if (step !== "complete" && step !== "processing") {
    widgetResult.value = null;
    verifiedResult.value = null;
  }
}

function onError(err) {
  error.value = err?.message || String(err);
}

// The widget callback is only a UI hint. Confirm the decision server-side.
watch(widgetResult, async (result) => {
  if (!result || !session.value) return;
  const { sessionId } = session.value;
  try {
    const verified = await getVerificationResult(sessionId);
    if (session.value?.sessionId === sessionId) verifiedResult.value = verified;
  } catch (err) {
    if (session.value?.sessionId === sessionId) error.value = `Could not confirm result: ${err.message}`;
  }
});

function reset() {
  session.value = null;
  widgetResult.value = null;
  verifiedResult.value = null;
  error.value = null;
  lastStep.value = null;
}

const cameraMessages = {
  pending: "Requesting camera access…",
  granted: "Camera access granted ✓",
  denied: "Camera blocked. Allow it in your browser settings to continue.",
  unsupported: "No camera API available. Use HTTPS or localhost."
};

function statusTitle(status) {
  if (status === "approved") return "✅ Identity verified";
  if (status === "manual_review") return "⏳ Under manual review";
  return "❌ Verification not successful";
}
</script>

<template>
  <header class="topbar">
    <strong>Acme Bank</strong>
    <span class="muted">Vue 3 app · VerifyPass React SDK</span>
  </header>

  <main class="container">
    <section v-if="!session" class="card">
      <h1>Verify your identity</h1>
      <p class="muted">
        This Vue application embeds the VerifyPass React widget. Sessions are created by this app's
        server using its secret key; the browser only receives a short-lived SDK token.
      </p>

      <div v-if="serverConfig && !serverConfig.configured" class="notice notice-warn">
        Server is missing <code>VERIFYPASS_SECRET_KEY</code>. Copy <code>.env.example</code> to
        <code>.env</code>, add your test secret key, and restart.
      </div>

      <div class="notice" :class="cameraState === 'granted' ? 'notice-ok' : cameraState === 'pending' ? 'notice-info' : 'notice-error'">
        {{ cameraMessages[cameraState] }}
      </div>

      <form @submit.prevent="startVerification">
        <label for="customer-ref">Customer reference (optional)</label>
        <input id="customer-ref" v-model="customerReference" placeholder="e.g. user-123" autocomplete="off" />

        <label for="verification-type">Verification type</label>
        <select id="verification-type" v-model="verificationType">
          <option value="ID_AND_FACE">ID + Face (document, liveness, selfie)</option>
          <option value="FACE_ONLY">Face only (liveness, selfie)</option>
          <option value="ID_ONLY">ID only (document)</option>
        </select>

        <p v-if="error" class="error">{{ error }}</p>

        <button type="submit" class="primary" :disabled="busy || serverConfig?.configured === false">
          {{ busy ? "Creating session…" : "Start verification" }}
        </button>
      </form>
    </section>

    <section v-if="showWidget" class="card">
      <p class="meta">Session <code>{{ session.sessionId }}</code><span v-if="lastStep"> · step: {{ lastStep }}</span></p>
      <VerifyPassWidget
        :session-id="session.sessionId"
        :sdk-token="session.sdkToken"
        :public-key="widgetConfig.publicKey"
        :base-url="widgetConfig.baseUrl"
        :face-model-url="widgetConfig.faceModelUrl"
        :landmark-model-url="widgetConfig.landmarkModelUrl"
        :theme="widgetConfig.theme"
        @complete="onComplete"
        @step-change="onStepChange"
        @error="onError"
      />
      <p v-if="error" class="error">{{ error }}</p>
      <button type="button" class="link" @click="reset">Cancel</button>
    </section>

    <section v-if="finalResult" class="card">
      <h2>{{ statusTitle(verifiedResult?.status ?? finalResult.status) }}</h2>
      <p class="muted" v-if="!verifiedResult">Confirming the decision with the server…</p>

      <template v-if="verifiedResult">
        <dl class="facts">
          <dt>Status</dt><dd>{{ verifiedResult.status }}</dd>
          <dt>Risk level</dt><dd>{{ verifiedResult.riskLevel || "-" }}</dd>
          <dt>Liveness</dt>
          <dd>{{ verifiedResult.liveness ? `${verifiedResult.liveness.status} (${verifiedResult.liveness.score ?? "-"})` : "n/a" }}</dd>
          <dt>Face match</dt>
          <dd>{{ verifiedResult.faceMatch ? `${verifiedResult.faceMatch.status} (${verifiedResult.faceMatch.similarityScore ?? "-"})` : "n/a" }}</dd>
          <dt>Reason codes</dt>
          <dd>{{ verifiedResult.decision?.reasonCodes?.length ? verifiedResult.decision.reasonCodes.join(", ") : "(none)" }}</dd>
        </dl>
        <details>
          <summary>Server-verified result (JSON)</summary>
          <pre>{{ JSON.stringify(verifiedResult, null, 2) }}</pre>
        </details>
      </template>

      <details>
        <summary>Widget callback payload</summary>
        <pre>{{ JSON.stringify(finalResult, null, 2) }}</pre>
      </details>

      <p v-if="error" class="error">{{ error }}</p>
      <button type="button" class="primary" @click="reset">Run another</button>
    </section>
  </main>
</template>
