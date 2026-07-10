"use strict";

// Thin camera wrapper (browser-only; kept minimal so everything above it is
// testable in Node). UI layers own the <video> element.

async function startCamera(videoEl, { facingMode = "user", width = 1280, height = 720 } = {}) {
  if (!navigator?.mediaDevices?.getUserMedia) {
    const err = new Error("Camera not supported in this browser");
    err.code = "CAMERA_UNSUPPORTED";
    throw err;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: width }, height: { ideal: height } },
      audio: false
    });
  } catch (err) {
    // A requested facingMode may not exist (e.g. "environment" on a
    // front-camera-only laptop). Retry once without the facing constraint so the
    // flow still works with whatever camera is available.
    if (err && (err.name === "OverconstrainedError" || err.name === "NotFoundError")) {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: width }, height: { ideal: height } },
        audio: false
      });
    } else {
      throw err;
    }
  }
  videoEl.srcObject = stream;
  await videoEl.play();
  // Wait until the stream has real dimensions — videoWidth/Height are 0 until
  // metadata loads, and capturing before then throws "source width is 0".
  try {
    await waitForVideoReady(videoEl);
  } catch (err) {
    // Ready wait failed: release the stream so we don't leak the camera.
    stream.getTracks().forEach((t) => t.stop());
    videoEl.srcObject = null;
    throw err;
  }
  return stream;
}

/** Resolve once the video reports non-zero dimensions; reject if it never does. */
function waitForVideoReady(videoEl, timeoutMs = 8000) {
  if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      videoEl.removeEventListener("loadedmetadata", check);
      videoEl.removeEventListener("loadeddata", check);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const err = new Error("Camera did not start — no video signal. Please try again.");
      err.code = "CAMERA_NOT_READY";
      reject(err);
    };
    const check = () => { if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) finish(); };
    videoEl.addEventListener("loadedmetadata", check);
    videoEl.addEventListener("loadeddata", check);
    // poll as a fallback for browsers that fire events inconsistently
    const started = Date.now();
    const poll = () => {
      if (settled) return;
      if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) return finish();
      if (Date.now() - started > timeoutMs) return fail();
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
}

function stopCamera(videoEl) {
  const stream = videoEl?.srcObject;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    videoEl.srcObject = null;
  }
}

/** Grab current frame → {imageData, base64} (jpeg, quality 0.9). */
function captureFrame(videoEl, canvasEl) {
  const w = videoEl.videoWidth;
  const h = videoEl.videoHeight;
  if (!w || !h) {
    const err = new Error("Camera is still starting — please try again in a moment.");
    err.code = "CAMERA_NOT_READY";
    throw err;
  }
  const canvas = canvasEl || document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(videoEl, 0, 0);
  const imageData = ctx.getImageData(0, 0, w, h);
  const base64 = canvas.toDataURL("image/jpeg", 0.9);
  return { imageData, base64 };
}

// Reused offscreen canvas for cheap, downscaled live analysis (quality/motion).
let analysisCanvas = null;

/** Downscaled ImageData for real-time analysis (auto-capture), or null if not ready. */
function grabAnalysisFrame(videoEl, maxWidth = 160) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) return null;
  const scale = Math.min(1, maxWidth / vw);
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));
  if (!analysisCanvas) analysisCanvas = document.createElement("canvas");
  analysisCanvas.width = w;
  analysisCanvas.height = h;
  const ctx = analysisCanvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(videoEl, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

let fixedCanvas = null;

/** ImageData of exactly w×h (video stretched to fit), for fixed-input models. */
function grabFixedFrame(videoEl, w, h) {
  if (!videoEl.videoWidth || !videoEl.videoHeight) return null;
  if (!fixedCanvas) fixedCanvas = document.createElement("canvas");
  fixedCanvas.width = w;
  fixedCanvas.height = h;
  const ctx = fixedCanvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(videoEl, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/**
 * ImageData of exactly w×h from the CENTER SQUARE of the video (object-fit
 * "cover" on a square), then stretched to w×h. This matches what a circular
 * preview shows, so face-framing analysis agrees with what the user sees.
 */
function grabSquareFrame(videoEl, w, h) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) return null;
  const side = Math.min(vw, vh);
  const sx = (vw - side) / 2;
  const sy = (vh - side) / 2;
  if (!fixedCanvas) fixedCanvas = document.createElement("canvas");
  fixedCanvas.width = w;
  fixedCanvas.height = h;
  const ctx = fixedCanvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(videoEl, sx, sy, side, side, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/**
 * Capture ONLY the region inside a centered guide box, from the
 * FULL-RESOLUTION source. The preview shows the video with object-fit:cover
 * in a container of displayAspect (w/h); the guide is a centered box of
 * widthFrac × container width with its own aspect (ID-1 card = 1.586). The
 * crop makes the document FILL the evidence photo instead of floating in a
 * room-sized frame — better for OCR, face-compare and reviewers.
 */
function captureGuideFrame(videoEl, { displayAspect = 1.6, widthFrac = 0.88, regionAspect = 1.586 } = {}) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) {
    const err = new Error("Camera is still starting — please try again in a moment.");
    err.code = "CAMERA_NOT_READY";
    throw err;
  }
  // Source region actually visible under object-fit:cover
  let visW, visH;
  if (vw / vh > displayAspect) { visH = vh; visW = vh * displayAspect; }
  else { visW = vw; visH = vw / displayAspect; }
  // Guide box in source pixels (centered, like the on-screen guide)
  let gw = visW * widthFrac;
  let gh = gw / regionAspect;
  if (gh > visH * 0.96) { gh = visH * 0.96; gw = gh * regionAspect; }
  const sx = (vw - gw) / 2;
  const sy = (vh - gh) / 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(gw);
  canvas.height = Math.round(gh);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(videoEl, sx, sy, gw, gh, 0, 0, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const base64 = canvas.toDataURL("image/jpeg", 0.92);
  return { imageData, base64 };
}

module.exports = { startCamera, stopCamera, captureFrame, captureGuideFrame, grabAnalysisFrame, grabFixedFrame, grabSquareFrame };
