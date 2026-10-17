import { createContext, useContext, useMemo } from "react";
import { readPublicConfig } from "@verifypass/sdk-core";

const VerifyPassContext = createContext(null);

/** @deprecated Test environment constants for the sample apps; never used as SDK defaults. */
export const LIVE_TEST_API_BASE = "https://uybb6wv27prwyijtkcteovvvke0hfkqw.lambda-url.us-east-2.on.aws";
/** @deprecated Test environment constants for the sample apps; never used as SDK defaults. */
export const LIVE_TEST_PUBLIC_KEY = "vp_pub_test_g0CAzW80fTNG5GJYV2wA1XUFFXov7VU9";
export const DEFAULT_FACE_MODEL_URL = "/models/fr_detect.onnx";
export { VerifyPassContext };

// Everything is optional. The provider itself is optional too: without it the
// widget runs token-only with zero-config assets.
// baseUrl: v1 SDK tokens embed their API origin; pass it only for dev proxies
//   or legacy tokens.
// publicKey: omitted → VITE_VP_PUBLIC_KEY if set, else token-only auth.
// faceModelUrl: omitted → served by the hosted VerifyPass origin; null → off.
// landmarkModelUrl: undefined → sibling of faceModelUrl; null → geometry only.
// ortWasmUrl: omitted → bundler asset (Vite) or the hosted VerifyPass origin.
export function VerifyPassProvider({
  publicKey,
  baseUrl,
  faceModelUrl,
  landmarkModelUrl,
  ortWasmUrl,
  env = (typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {}),
  children
}) {
  const value = useMemo(() => {
    const configured = readPublicConfig(env);
    return {
      publicKey: publicKey === undefined ? configured.publicKey : publicKey,
      baseUrl: baseUrl === undefined ? configured.baseUrl : baseUrl,
      faceModelUrl: faceModelUrl === undefined ? (configured.faceModelUrl || undefined) : faceModelUrl,
      landmarkModelUrl: landmarkModelUrl === undefined ? configured.landmarkModelUrl : landmarkModelUrl,
      ortWasmUrl: ortWasmUrl === undefined ? configured.ortWasmUrl : ortWasmUrl
    };
  }, [publicKey, baseUrl, faceModelUrl, landmarkModelUrl, ortWasmUrl, env]);
  return <VerifyPassContext.Provider value={value}>{children}</VerifyPassContext.Provider>;
}

const NO_PROVIDER = Object.freeze({ publicKey: null, baseUrl: null, faceModelUrl: undefined, landmarkModelUrl: undefined, ortWasmUrl: undefined });

/** Provider config, or zero-config defaults when no provider is mounted. */
export function useVerifyPassConfig() {
  return useContext(VerifyPassContext) || NO_PROVIDER;
}

export function useVerifyPass() {
  const ctx = useContext(VerifyPassContext);
  if (!ctx) throw new Error("useVerifyPass must be used inside <VerifyPassProvider>");
  return ctx;
}
