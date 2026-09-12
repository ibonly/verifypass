import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

const sdkEntry = "/@fs" + fileURLToPath(new URL("../../sdk/react/src/index.js", import.meta.url));
const detectorEntry = "/@fs" + fileURLToPath(new URL("../../sdk/react/src/faceDetector.js", import.meta.url));
const challenge = { success: true, verificationType: "ID_ONLY", documentTypes: ["NATIONAL_ID_CARD"], attempts: 3, manualUploadSuggested: true };

async function mockApi(page) {
  await page.route("**/v1/verification-sessions/**", route => route.fulfill({ json: challenge }));
}

async function consent(page) {
  await page.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}

test("initialization errors remain visible and retry recovers", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/challenge", route => route.fulfill({ status: 503, json: { success: false, error: { code: "UNAVAILABLE", message: "Synthetic API outage" } } }));
  await page.goto("/session/vps_browser#t=sdk_browser");
  await expect(page.getByRole("alert")).toContainText("Synthetic API outage");
  await page.unroute("**/challenge");
  await mockApi(page);
  await page.getByRole("button", { name: "Retry loading verification" }).click();
  await expect(page.getByRole("heading", { name: "Consent required" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("manual ID uploads preserve front and back and submit once", async ({ page }) => {
  await mockApi(page);
  const sides = [];
  let submissions = 0;
  await page.route("**/document", route => { sides.push(route.request().postDataJSON().side); return route.fulfill({ json: { success: true } }); });
  await page.route("**/verify", route => { submissions++; return route.fulfill({ json: { success: true } }); });
  await page.route("**/status", route => route.fulfill({ json: { success: true, status: "approved" } }));
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("Synthetic camera unavailable", "NotAllowedError"); }; });
  await page.goto("/session/vps_browser#t=sdk_browser");
  await consent(page);
  const image = { name: "synthetic.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afo8AAAAASUVORK5CYII=", "base64") };
  await page.locator('input[type="file"]').setInputFiles(image);
  await expect(page.getByRole("heading", { name: /back/i })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles(image);
  await expect(page.getByText("Verification approved.", { exact: true })).toBeVisible();
  expect(sides).toEqual(["front", "back"]);
  expect(submissions).toBe(1);
});

test("manual uploads exceeding the Lambda-safe limit are rejected before transport", async ({ page }) => {
  await mockApi(page);
  let uploads = 0;
  await page.route("**/document", route => { uploads++; return route.fulfill({ json: { success: true } }); });
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("Synthetic camera unavailable", "NotAllowedError"); }; });
  await page.goto("/session/vps_browser#t=sdk_browser");
  await consent(page);
  await page.locator('input[type="file"]').setInputFiles({ name: "large.png", mimeType: "image/png", buffer: Buffer.alloc(3 * 1024 * 1024 + 1) });
  await expect(page.getByText(/Image is larger than 3MB/)).toBeVisible();
  expect(uploads).toBe(0);
});

test("public env config supports explicit overrides and session changes cancel late cameras", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.evaluate(async (entry) => {
    const React = (await import("/node_modules/.vite/deps/react.js")).default;
    const { createRoot } = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
    const { VerifyPassProvider, VerificationWidget } = await import(entry);
    const element = document.createElement("div");
    element.id = "sdk-harness";
    document.body.replaceChildren(element);
    const root = createRoot(element);
    window.cameraCalls = 0;
    window.stoppedTracks = 0;
    navigator.mediaDevices.getUserMedia = () => { window.cameraCalls++; return new Promise(resolve => { window.resolveCamera = () => resolve({ getTracks: () => [{ stop() { window.stoppedTracks++; } }] }); }); };
    window.renderSession = (sessionId) => root.render(React.createElement(VerifyPassProvider, {
      env: { VITE_VP_API_BASE: location.origin, VITE_VP_PUBLIC_KEY: "vp_pub_example" },
      publicKey: null, faceModelUrl: null
    }, React.createElement(VerificationWidget, { sessionId, sdkToken: "sdk_browser" })));
    window.renderSession("vps_first");
  }, sdkEntry);
  await expect(page.getByRole("heading", { name: "Consent required" })).toBeVisible();
  expect(await page.evaluate(() => window.cameraCalls)).toBe(0);
  const request = page.waitForRequest("**/consent");
  await consent(page);
  expect((await request).headers().authorization).toBeUndefined();
  await expect.poll(() => page.evaluate(() => window.cameraCalls)).toBe(1);
  await page.evaluate(() => window.renderSession("vps_second"));
  await expect(page.getByRole("heading", { name: "Consent required" })).toBeVisible();
  await expect(page.getByRole("checkbox").first()).not.toBeChecked();
  await page.evaluate(() => window.resolveCamera());
  await expect.poll(() => page.evaluate(() => window.stoppedTracks)).toBe(1);
  expect(await page.evaluate(() => window.cameraCalls)).toBe(1);
});

test("ONNX runs repeatedly and disposes safely during inference", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async (entry) => {
    const { createFaceDetector } = await import(entry);
    const detector = await createFaceDetector("/models/fr_detect.onnx");
    const image = new ImageData(320, 240);
    const boxes = [];
    for (let index = 0; index < 5; index++) boxes.push((await detector.detect(image)).box);
    const pending = detector.detect(image);
    detector.dispose();
    await pending;
    let disposedError;
    try { await detector.detect(image); } catch (error) { disposedError = error.message; }
    return { hasLandmarks: detector.hasLandmarks, noFace: boxes.every(box => !box), disposedError };
  }, detectorEntry);
  expect(result).toEqual({ hasLandmarks: true, noFace: true, disposedError: "Face detector disposed" });
});