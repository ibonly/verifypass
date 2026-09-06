import { createContext, useContext, useMemo } from "react";

const VerifyPassContext = createContext(null);

// baseUrl is optional: v1 SDK tokens embed their environment's API origin, so
// the widget locates the API from the token alone. Pass baseUrl only for dev
// proxies or legacy tokens.
// landmarkModelUrl: fr_landmark.onnx for head-pose proxies (active liveness).
// undefined → derived from faceModelUrl (sibling file); null → geometry only.
export function VerifyPassProvider({ publicKey = null, baseUrl = null, faceModelUrl = null, landmarkModelUrl, children }) {
  const value = useMemo(() => ({ publicKey, baseUrl, faceModelUrl, landmarkModelUrl }), [publicKey, baseUrl, faceModelUrl, landmarkModelUrl]);
  return <VerifyPassContext.Provider value={value}>{children}</VerifyPassContext.Provider>;
}

export function useVerifyPass() {
  const ctx = useContext(VerifyPassContext);
  if (!ctx) throw new Error("useVerifyPass must be used inside <VerifyPassProvider>");
  return ctx;
}
