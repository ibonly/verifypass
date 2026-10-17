import { FLASH, nextVideoFrame, grabSquareFrame, flashCropRect } from "@verifypass/sdk-core";

/**
 * Run the screen-flash sequence: dark baseline, then FLASH.count random
 * colours over the whole viewport; after each switch wait for the display +
 * camera to settle and grab the face crop (from the same 320-px square frame
 * the detector analyses, so `box` is in its coordinates) into one horizontal
 * mosaic: [baseline | c1 | c2 | c3 | c4]. Resolves {base64, sequence, tile}
 * or null when the camera is not ready.
 */
export async function runScreenFlash(video, box, setColor, sequence, signal) {
  if (!video || !video.videoWidth) return null;
  if (!Array.isArray(sequence) || sequence.length !== FLASH.count) return null;
  const tile = FLASH.tile;
  const steps = [FLASH.baseline, ...sequence];
  const mosaic = document.createElement("canvas");
  mosaic.width = tile * steps.length;
  mosaic.height = tile;
  const mctx = mosaic.getContext("2d");
  const src = document.createElement("canvas");
  src.width = 320; src.height = 320;
  const sctx = src.getContext("2d");
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < steps.length; i++) {
    if (signal?.aborted || document.hidden) throw new Error("Capture interrupted");
    setColor(steps[i]);
    await wait(FLASH.sampleDelayMs);
    await nextVideoFrame(video, { signal });
    const frame = grabSquareFrame(video, 320, 320);
    if (!frame) return null;
    sctx.putImageData(frame, 0, 0);
    const rect = flashCropRect(box, 320, 320);
    if (!rect) return null;
    mctx.drawImage(src, rect.x, rect.y, rect.size, rect.size, i * tile, 0, tile, tile);
    await wait(Math.max(0, FLASH.holdMs - FLASH.sampleDelayMs));
  }
  setColor(null);
  const dataUrl = mosaic.toDataURL("image/jpeg", 0.92);
  return { base64: dataUrl, sequence, tile };
}
