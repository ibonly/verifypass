import { useMemo, useState } from "react";
import { VerifyPassProvider, VerificationWidget } from "@verifypass/react";

/**
 * Hosted verification page (PRD Use Case 5).
 * URL shape: /session/<sessionId>#t=<sdkToken>&r=<redirectUrl>
 * The token lives in the fragment — never sent to any server or logged.
 */
function parseLocation() {
  const m = window.location.pathname.match(/\/session\/(vps_[A-Za-z0-9]+)/);
  const frag = new URLSearchParams(window.location.hash.slice(1));
  return {
    sessionId: m ? m[1] : null,
    sdkToken: frag.get("t"),
    redirectUrl: frag.get("r")
  };
}

export default function App() {
  const { sessionId, sdkToken, redirectUrl } = useMemo(parseLocation, []);
  const [fatal, setFatal] = useState(null);

  if (!sessionId || !sdkToken) {
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
            : "We couldn't find this verification session."}
        </p>
      </Center>
    );
  }

  return (
    <VerifyPassProvider publicKey={null} baseUrl={__VP_API_BASE__}>
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
