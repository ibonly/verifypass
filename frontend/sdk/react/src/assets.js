// Zero-config assets: the hosted verification origin (challenge.hostedBaseUrl)
// serves the face models and the onnxruntime-web WASM, so integrating apps
// copy, configure and bundle nothing. Explicit URLs still win.

// Must equal the exact onnxruntime-web version the SDK depends on (pinned in
// package.json; enforced by tests). The hosted page serves the matching WASM.
export const ORT_VERSION = "1.29.0";
export const ORT_WASM_SHA256 = "ec8580a9d7b9476ceee52e10a7f94124e4dc71a019d666ed6d4726697c109a4d";

/** Validated asset base from the server-issued hosted URL, or null. */
export function hostedAssetBase(hostedBaseUrl) {
  if (typeof hostedBaseUrl !== "string" || !hostedBaseUrl) return null;
  try {
    const url = new URL(hostedBaseUrl);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch (_) {
    return null;
  }
}

export const hostedModelUrl = (base, file) => (base ? `${base}/models/${file}` : null);
export const hostedOrtWasmUrl = (base) => (base ? `${base}/sdk-assets/ort/${ORT_VERSION}/ort-wasm-simd-threaded.wasm` : null);
