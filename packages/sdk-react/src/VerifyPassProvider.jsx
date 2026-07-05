import { createContext, useContext, useMemo } from "react";

const VerifyPassContext = createContext(null);

export function VerifyPassProvider({ publicKey, baseUrl = "https://api.verifypass.com", faceModelUrl = null, children }) {
  const value = useMemo(() => ({ publicKey, baseUrl, faceModelUrl }), [publicKey, baseUrl, faceModelUrl]);
  return <VerifyPassContext.Provider value={value}>{children}</VerifyPassContext.Provider>;
}

export function useVerifyPass() {
  const ctx = useContext(VerifyPassContext);
  if (!ctx) throw new Error("useVerifyPass must be used inside <VerifyPassProvider>");
  return ctx;
}
