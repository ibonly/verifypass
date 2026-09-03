"use strict";

// P0 capture-integrity signals (injection resistance, basic tier).
// Collected from the ACTIVE getUserMedia track after the camera starts, and
// reported to the server at submit. Everything here is advisory: labels are
// spoofable and a miss proves nothing, so the server treats a hit as a soft
// risk signal (manual review), never an auto-reject — and re-checks the
// label server-side so a doctored client can't simply clear the flag.

// Known virtual-camera / injection tool label patterns.
const VIRTUAL_CAMERA_RE = /virtual|obs|manycam|snap camera|xsplit|camtwist|droidcam|iriun|epoccam|\bndi\b|vcam|screen capture|dummy|fake|emulat/i;

/**
 * Collect capture metadata from a live camera stream.
 * @param {MediaStream} stream the stream returned by getUserMedia
 * @returns {Promise<object|null>} whitelisted signals, or null outside browsers
 */
async function collectCaptureSignals(stream) {
  try {
    const track = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
    if (!track) return null;
    const settings = typeof track.getSettings === "function" ? track.getSettings() : {};

    // Post-permission, enumerateDevices exposes real labels — count inputs
    // and scan every label, not just the active one (an attacker may capture
    // with a real camera while a virtual one is installed for later frames).
    let inputs = [];
    try {
      if (typeof navigator !== "undefined" && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        inputs = devices.filter((d) => d.kind === "videoinput");
      }
    } catch (_) { /* enumeration unsupported — labels stay advisory */ }

    const label = track.label || "";
    const allLabels = [label, ...inputs.map((d) => d.label || "")];
    const virtualCameraSuspected = allLabels.some((l) => l && VIRTUAL_CAMERA_RE.test(l));

    return {
      cameraLabel: label ? label.slice(0, 120) : null,
      facingMode: settings.facingMode || null,
      frameRate: typeof settings.frameRate === "number" ? settings.frameRate : null,
      resolution: settings.width && settings.height ? `${settings.width}x${settings.height}` : null,
      videoInputCount: inputs.length || null,
      // Real hardware tracks expose getCapabilities; some injection shims don't.
      hasCapabilities: typeof track.getCapabilities === "function",
      virtualCameraSuspected
    };
  } catch (_) {
    return null;
  }
}

module.exports = { collectCaptureSignals, VIRTUAL_CAMERA_RE };
