import { createContext, useContext, useMemo } from "react";
import { readPublicConfig } from "@verifypass/sdk-core";

const VerifyPassContext = createContext(null);

// baseUrl is optional: v1 SDK tokens embed their environment's API origin, so
// the widget locates the API from the token alone. Pass baseUrl only for dev
// proxies or legacy tokens.
// landmarkModelUrl: fr_landmark.onnx for head-pose proxies (active liveness).
// undefined → derived from faceModelUrl (sibling file); null → geometry only.
export function VerifyPassProvider({ publicKey, baseUrl, faceModelUrl, landmarkModelUrl, env = import.meta.env, children }) {
  const value = useMemo(() => {
    const configured = readPublicConfig(env);
    return {
      publicKey: publicKey === undefined ? configured.publicKey : publicKey,
      baseUrl: baseUrl === undefined ? configured.baseUrl : baseUrl,
      faceModelUrl: faceModelUrl === undefined ? configured.faceModelUrl : faceModelUrl,
      landmarkModelUrl: landmarkModelUrl === undefined ? configured.landmarkModelUrl : landmarkModelUrl
    };
  }, [publicKey, baseUrl, faceModelUrl, landmarkModelUrl, env]);
  return <VerifyPassContext.Provider value={value}>{children}</VerifyPassContext.Provider>;
}

export function useVerifyPass() {
  const ctx = useContext(VerifyPassContext);
  if (!ctx) throw new Error("useVerifyPass must be used inside <VerifyPassProvider>");
  return ctx;
}
