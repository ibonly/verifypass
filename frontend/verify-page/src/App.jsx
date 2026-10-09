import { useEffect, useMemo, useState } from "react";
import { VerifyPassProvider, VerificationWidget, claimMobileHandoff } from "@verifypass/react";

/**
 * Hosted verification page (PRD Use Case 5).
 * Direct URL: /session/<sessionId>#t=<sdkToken>&r=<redirectUrl>
 * Mobile handoff URL: /session/<sessionId>#h=<oneTimeHandoffToken>
 */
function parseLocation() {
  const m = window.location.pathname.match(/\/session\/(vps_[A-Za-z0-9]+)/);
  const frag = new URLSearchParams(window.location.hash.slice(1));
  return {
    sessionId: m ? m[1] : null,
    sdkToken: frag.get("t"),
    handoffToken: frag.get("h"),
    redirectUrl: frag.get("r")
  };
}

export default function App() {
  const location = useMemo(parseLocation, []);
  const { sessionId, handoffToken, redirectUrl } = location;
  const storageKey = sessionId ? `vp-mobile-token:${sessionId}` : null;
  const [sdkToken, setSdkToken] = useState(() => {
    if (location.sdkToken) return location.sdkToken;
    try { return storageKey ? sessionStorage.getItem(storageKey) : null; } catch (_) { return null; }
  });
  const [fatal, setFatal] = useState(null);
  const [claiming, setClaiming] = useState(!!handoffToken && !sdkToken);

  useEffect(() => {
    if (!sessionId || !handoffToken || sdkToken) return;
    let cancelled = false;
    setClaiming(true);
    claimMobileHandoff({
      sessionId,
      handoffToken,
      baseUrl: __VP_API_BASE__ || undefined
    }).then((result) => {
      if (cancelled) return;
      try { sessionStorage.setItem(storageKey, result.sdkToken); } catch (_) {}
      history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      setSdkToken(result.sdkToken);
    }).catch((error) => {
      if (!cancelled) setFatal(error);
    }).finally(() => {
      if (!cancelled) setClaiming(false);
    });
    return () => { cancelled = true; };
  }, [sessionId, handoffToken, sdkToken, storageKey]);

  if (!sessionId || (!sdkToken && !handoffToken)) {
    return (
      <Center>
        <h2>Invalid verification link</h2>
        <p style={{ color: "#6B7280" }}>
          This link is incomplete or has expired. Please restart verification
          from the app that sent you here.
        </p>
      </Center>
    );
  }

  function handleComplete(result) {
    // Retryable outcomes stay ON the page: the widget's result screen offers
    // "Try again" (+ manual ID upload after 3 attempts). Auto-redirecting
    // 1.5s after a rejection yanked users away before they could retry.
    const retryable = ["rejected", "manual_review", "failed"].includes(result.status);
    if (redirectUrl && !retryable) {
      try {
        const u = new URL(redirectUrl);
        // M3 fix: block javascript:/data: and require https (http allowed in dev only)
        const allowedSchemes = ["https:"];
        if (typeof __VP_DEV__ !== "undefined" && __VP_DEV__) allowedSchemes.push("http:");
        if (!allowedSchemes.includes(u.protocol)) return; // stay on page
        u.searchParams.set("sessionId", sessionId);
        u.searchParams.set("status", result.status);
        setTimeout(() => { window.location.href = u.toString(); }, 1500);
        return;
      } catch (_) { /* bad redirect — stay on page, result is shown */ }
    }
  }

  function handleError(err) {
    if (["SESSION_EXPIRED", "SESSION_NOT_FOUND"].includes(err.code)) setFatal(err);
  }

  if (fatal) {
    return (
      <Center>
        <h2>Session unavailable</h2>
        <p style={{ color: "#6B7280" }}>
          {fatal.code === "SESSION_EXPIRED"
            ? "This verification session has expired. Please restart from the app that sent you here."
            : fatal.code === "INVALID_API_KEY"
              ? "This mobile handoff link is invalid, expired, or has already been used."
              : "We couldn't find this verification session."}
        </p>
      </Center>
    );
  }

  if (claiming || !sdkToken) {
    return <Center><p role="status">Opening secure mobile verification…</p></Center>;
  }

  return (
    // faceModelUrl: the hosted page previously shipped WITHOUT the face model,
    // which made the liveness step auto-capture on motion-settle (any action
    // "completed" when the user held still). The widget now fails closed
    // without a detector, and the models are served from /models/.
    <VerifyPassProvider publicKey={null} baseUrl={__VP_API_BASE__ || undefined} faceModelUrl={import.meta.env.VITE_VP_FACE_MODEL_URL || "/models/fr_detect.onnx"}>
      <VerificationWidget
        sessionId={sessionId}
        sdkToken={sdkToken}
        onComplete={handleComplete}
        onError={handleError}
      />
    </VerifyPassProvider>
  );
}

function Center({ children }) {
  return (
    <div style={{ maxWidth: 420, margin: "10vh auto 0", textAlign: "center", fontFamily: "system-ui, sans-serif" }}>
      {children}
    </div>
  );
}
