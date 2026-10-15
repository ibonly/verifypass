import { T } from "../theme";

export function Spinner({ margin = "0 auto 12px" }) {
  return (
    <>
      <div style={{
        width: 32, height: 32, margin, borderRadius: "50%",
        border: `3px solid ${T.primary}`, borderTopColor: "transparent",
        animation: "vp-spin 0.8s linear infinite"
      }} />
      <style>{"@keyframes vp-spin { to { transform: rotate(360deg) } }"}</style>
    </>
  );
}

export function ProcessingView({ copy }) {
  return (
    <div data-vp-part="processing" style={{ textAlign: "center", padding: "32px 0", color: T.muted }}>
      <Spinner />
      {copy.processing.message}
    </div>
  );
}
