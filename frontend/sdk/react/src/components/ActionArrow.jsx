// Directional arrow overlay per head action, shown over the (mirrored)
// preview while the user performs the movement. A selfie preview behaves like
// a MIRROR — lateral movement keeps its screen direction — so a screen-left
// arrow correctly means "YOUR left"; no flipping needed.
// rotate: degrees applied to a right-pointing arrow. pos: placement inside
// the circular frame. Expression actions (smile) have no direction.
const ACTION_ARROWS = {
  turn_left: { rotate: 180, pos: { left: 6, top: "50%", transform: "translateY(-50%)" } },
  turn_right: { rotate: 0, pos: { right: 6, top: "50%", transform: "translateY(-50%)" } },
  look_up: { rotate: -90, pos: { top: 6, left: "50%", transform: "translateX(-50%)" } },
  look_down: { rotate: 90, pos: { bottom: 6, left: "50%", transform: "translateX(-50%)" } }
};

/** Pulsing directional arrow rendered over the camera preview. */
export function ActionArrow({ action, copy }) {
  const spec = ACTION_ARROWS[action];
  if (!spec) return null;
  return (
    <div
      role="img"
      aria-label={copy.arrows[action]}
      style={{ position: "absolute", zIndex: 2, pointerEvents: "none", ...spec.pos }}
    >
      <div style={{ transform: `rotate(${spec.rotate}deg)` }}>
        {/* right-pointing arrow; rotation + the nudge animation (translateX
            AFTER rotation) make it point and pulse toward the direction */}
        <svg width="52" height="52" viewBox="0 0 52 52" style={{ animation: "vp-arrow-nudge 0.9s ease-in-out infinite", display: "block", filter: "drop-shadow(0 1px 4px rgba(0,0,0,0.6))" }}>
          <path
            d="M6 26 H34 M24 12 L40 26 L24 40"
            fill="none"
            stroke="#FFFFFF"
            strokeWidth="7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <style>{"@keyframes vp-arrow-nudge { 0%,100% { transform: translateX(0) } 50% { transform: translateX(10px) } }"}</style>
    </div>
  );
}
