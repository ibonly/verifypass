"use strict";

// Device signal collection (Phase 2: device fingerprinting).
// Deliberately lightweight and transparent: stable browser/environment
// attributes only — no canvas/audio probing, no third-party trackers.
// The SERVER computes the fingerprint hash from these signals; the client
// value is advisory input, never trusted.

function collectDeviceSignals() {
  // Gate on window, not navigator: Node 21+ ships a global navigator object
  if (typeof window === "undefined" || typeof navigator === "undefined") return null;
  let timezone = null;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch (_) { /* unsupported */ }
  const scr = typeof screen !== "undefined" ? screen : null;
  return {
    userAgent: navigator.userAgent || null,
    language: navigator.language || null,
    languages: Array.isArray(navigator.languages) ? navigator.languages.slice(0, 5) : null,
    platform: navigator.platform || null,
    timezone,
    screen: scr ? `${scr.width}x${scr.height}` : null,
    pixelRatio: typeof devicePixelRatio !== "undefined" ? devicePixelRatio : null,
    touch: typeof window !== "undefined" ? "ontouchstart" in window : null,
    cores: navigator.hardwareConcurrency ?? null,
    memoryGb: navigator.deviceMemory ?? null
  };
}

module.exports = { collectDeviceSignals };
