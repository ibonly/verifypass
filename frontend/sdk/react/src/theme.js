// Theme tokens as CSS custom properties. Styles reference var(--vp-*, default),
// so a host can theme the widget either with the `theme` prop or with plain
// CSS on any ancestor (custom properties inherit, including into the
// <verifypass-liveness> shadow root).

export const T = {
  primary: "var(--vp-primary, #6D28D9)",
  onPrimary: "var(--vp-on-primary, #fff)",
  surface: "var(--vp-surface, #fff)",
  text: "var(--vp-text, #374151)",
  muted: "var(--vp-muted, #6B7280)",
  subtle: "var(--vp-subtle, #9CA3AF)",
  border: "var(--vp-border, #E5E7EB)",
  success: "var(--vp-success, #059669)",
  successBright: "var(--vp-success-bright, #10B981)",
  warning: "var(--vp-warning, #B45309)",
  danger: "var(--vp-danger, #DC2626)",
  pill: "var(--vp-pill-bg, #111827)",
  font: "var(--vp-font, system-ui, sans-serif)",
  radius: "var(--vp-radius, 8px)"
};

const THEME_VARS = {
  primaryColor: "--vp-primary",
  onPrimaryColor: "--vp-on-primary",
  surfaceColor: "--vp-surface",
  textColor: "--vp-text",
  mutedColor: "--vp-muted",
  borderColor: "--vp-border",
  successColor: "--vp-success",
  warningColor: "--vp-warning",
  dangerColor: "--vp-danger",
  fontFamily: "--vp-font",
  borderRadius: "--vp-radius"
};

/** Inline style for the widget root: only the tokens the host set. */
export function themeStyle(theme = {}) {
  const style = {};
  for (const [key, cssVar] of Object.entries(THEME_VARS)) {
    const value = theme[key];
    if (typeof value === "string" && value && !/[;{}<>]/.test(value)) style[cssVar] = value;
  }
  if (typeof theme.backgroundColor === "string" && theme.backgroundColor) style.background = theme.backgroundColor;
  return style;
}
