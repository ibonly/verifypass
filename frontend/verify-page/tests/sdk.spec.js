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

test("mobile handoff claims a one-time token and removes it from the address bar", async ({ page }) => {
  await page.goto("/");
  const apiOrigin = new URL(page.url()).origin;
  const payload = Buffer.from(JSON.stringify({ u: apiOrigin, t: "handoff" })).toString("base64url");
  const handoffToken = `vph_v1_${payload}`;
  let claims = 0;
  await page.route("**/handoff/claim", route => {
    claims++;
    expect(route.request().postDataJSON()).toEqual({ handoffToken });
    return route.fulfill({ json: { success: true, sessionId: "vps_mobile", sdkToken: "sdk_mobile" } });
  });
  await page.route("**/challenge", route => route.fulfill({ json: challenge }));
  await page.goto(`/session/vps_mobile#h=${handoffToken}`);
  await expect(page.getByRole("heading", { name: "Consent required" })).toBeVisible();
  expect(claims).toBe(1);
  expect(new URL(page.url()).hash).toBe("");
  expect(await page.evaluate(() => sessionStorage.getItem("vp-mobile-token:vps_mobile"))).toBe("sdk_mobile");
});

test("mobile handoff offers QR, copy, open, privacy, and expiry controls without desktop consent", async ({ page }) => {
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  await page.route("**/challenge*", route => route.fulfill({ json: {
    ...challenge,
    hostedBaseUrl: page.url().replace(/\/$/, ""),
    handoffToken: "vph_test_handoff",
    handoffExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    expiresAt
  } }));
  await page.route("**/status", route => route.fulfill({ json: { success: true, status: "created" } }));
  await page.goto("/");
  await page.evaluate(async (entry) => {
    const React = (await import("/node_modules/.vite/deps/react.js")).default;
    const { createRoot } = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
    const { VerifyPassProvider, VerificationWidget } = await import(entry);
    const element = document.createElement("div");
    document.body.replaceChildren(element);
    createRoot(element).render(React.createElement(VerifyPassProvider, {
      baseUrl: location.origin,
      publicKey: "vp_pub_example",
      faceModelUrl: null
    }, React.createElement(VerificationWidget, {
      sessionId: "vps_mobile_ui",
      sdkToken: "sdk_browser",
      mobileHandoff: true
    })));
  }, sdkEntry);
  await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy secure link" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open on this device" })).toHaveAttribute("href", /#h=vph_test_handoff$/);
  await expect(page.getByText(/Do not share or screenshot/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Consent required" })).toHaveCount(0);
});

test("QR generation failure exposes recovery and emits token-free telemetry", async ({ page }) => {
  await page.route("**/node_modules/.vite/deps/qrcode*", route => route.abort());
  await page.route("**/challenge*", route => route.fulfill({ json: {
    ...challenge,
    hostedBaseUrl: page.url().replace(/\/$/, ""),
    handoffToken: "vph_secret_not_for_telemetry",
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
  } }));
  await page.route("**/status", route => route.fulfill({ json: { success: true, status: "created" } }));
  await page.goto("/");
  await page.evaluate(async (entry) => {
    const React = (await import("/node_modules/.vite/deps/react.js")).default;
    const { createRoot } = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
    const { VerifyPassProvider, VerificationWidget } = await import(entry);
    window.qrTelemetry = [];
    const element = document.createElement("div");
    document.body.replaceChildren(element);
    createRoot(element).render(React.createElement(VerifyPassProvider, {
      baseUrl: location.origin,
      publicKey: "vp_pub_example",
      faceModelUrl: null
    }, React.createElement(VerificationWidget, {
      sessionId: "vps_qr_failure",
      sdkToken: "sdk_browser",
      mobileHandoff: true,
      onTelemetry: (event) => window.qrTelemetry.push(event)
    })));
  }, sdkEntry);
  await expect(page.getByRole("button", { name: "Retry QR code" })).toBeVisible();
  const telemetry = await page.evaluate(() => window.qrTelemetry);
  expect(telemetry[0]).toMatchObject({ type: "mobile_handoff_qr_failed" });
  expect(JSON.stringify(telemetry)).not.toContain("vph_secret_not_for_telemetry");
});

test("omitting mobileHandoff puts a QR call to action on the consent screen and allows switching back", async ({ page }) => {
  await page.route("**/challenge*", route => route.fulfill({ json: {
    ...challenge,
    hostedBaseUrl: page.url().replace(/\/$/, ""),
    handoffToken: "vph_test_choice",
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
  } }));
  await page.route("**/status", route => route.fulfill({ json: { success: true, status: "created" } }));
  await page.goto("/");
  await page.evaluate(async (entry) => {
    const React = (await import("/node_modules/.vite/deps/react.js")).default;
    const { createRoot } = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
    const { VerifyPassProvider, VerificationWidget } = await import(entry);
    const element = document.createElement("div");
    document.body.replaceChildren(element);
    createRoot(element).render(React.createElement(VerifyPassProvider, {
      baseUrl: location.origin,
      publicKey: "vp_pub_example",
      faceModelUrl: null
    }, React.createElement(VerificationWidget, {
      sessionId: "vps_choice",
      sdkToken: "sdk_browser"
      // mobileHandoff deliberately omitted — the drop-in integration case.
    })));
  }, sdkEntry);
  await expect(page.getByRole("heading", { name: "Consent required" })).toBeVisible();
  // The separate screen-flash opt-in is gone; its disclosure lives in the single consent statement.
  await expect(page.getByRole("checkbox")).toHaveCount(1);
  await expect(page.getByText(/changing screen colours/)).toHaveCount(0);
  await expect(page.getByText(/change my screen colour/)).toBeVisible();

  await page.getByRole("button", { name: "Show QR code" }).click();
  await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Consent required" })).toHaveCount(0);

  await page.getByRole("button", { name: "Use this device instead" }).click();
  await expect(page.getByRole("heading", { name: "Consent required" })).toBeVisible();
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
// ── Zero-dependency integration surface ─────────────────────────────

async function mountElement(page, attrs) {
  await page.goto("/");
  await page.evaluate(async (attributes) => {
    document.body.replaceChildren();
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/sdk/v1/verifypass-liveness.js";
      script.onload = resolve; script.onerror = reject;
      document.head.append(script);
    });
    window.vpEvents = [];
    const el = document.createElement("verifypass-liveness");
    for (const [k, v] of Object.entries(attributes)) el.setAttribute(k, v);
    for (const type of ["vp-complete", "vp-error", "vp-step-change", "vp-telemetry"]) {
      el.addEventListener(type, (e) => window.vpEvents.push({ type, detail: e.detail && { ...e.detail, code: e.detail.code } }));
    }
    document.body.append(el);
  }, attrs);
}

test("custom element runs with no host dependencies and loads models + WASM from the hosted origin", async ({ page }) => {
  const origin = "http://127.0.0.1:5187";
  await page.route("**/challenge*", route => route.fulfill({ json: { success: true, verificationType: "FACE_ONLY", livenessActions: ["blink"], hostedBaseUrl: origin } }));
  const wasm = page.waitForResponse(`${origin}/sdk-assets/ort/1.29.0/ort-wasm-simd-threaded.wasm`);
  const model = page.waitForResponse(`${origin}/models/fr_detect.onnx`);
  await mountElement(page, { "session-id": "vps_element", "sdk-token": "sdk_browser", "base-url": origin, "primary-color": "#ff0000", "mobile-handoff": "false" });
  await expect(page.getByRole("heading", { name: "Consent required" })).toBeVisible();
  expect((await wasm).status()).toBe(200);
  expect((await wasm).headers()["access-control-allow-origin"]).toBe("*");
  expect((await model).status()).toBe(200);
  const primary = await page.evaluate(() => document.querySelector("verifypass-liveness").shadowRoot.querySelector("[data-vp-widget]").style.getPropertyValue("--vp-primary"));
  expect(primary).toBe("#ff0000");
  await expect(page.getByRole("button", { name: "Show QR code" })).toHaveCount(0);
  // copy overrides via property
  await page.evaluate(() => { document.querySelector("verifypass-liveness").copy = { consent: { title: "Zustimmung erforderlich" } }; });
  await expect(page.getByRole("heading", { name: "Zustimmung erforderlich" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.vpEvents.filter(e => e.type === "vp-telemetry" && e.detail.type === "face_model_load_failed").length)).toBe(0);
});

test("custom element reports init failures as vp-error with a stable code", async ({ page }) => {
  await page.route("**/challenge*", route => route.fulfill({ status: 503, json: { success: false, error: { code: "UNAVAILABLE", message: "Synthetic API outage" } } }));
  await mountElement(page, { "session-id": "vps_element", "sdk-token": "sdk_browser", "base-url": "http://127.0.0.1:5187" });
  await expect(page.getByRole("alert")).toContainText("Synthetic API outage");
  const errors = await page.evaluate(() => window.vpEvents.filter(e => e.type === "vp-error"));
  expect(errors[0].detail.code).toBe("UNAVAILABLE");
});

test("widget works without a provider, token-only, and applies theme + copy props", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  const request = page.waitForRequest("**/challenge*");
  await page.evaluate(async (entry) => {
    const React = (await import("/node_modules/.vite/deps/react.js")).default;
    const { createRoot } = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
    const { VerificationWidget } = await import(entry);
    const element = document.createElement("div");
    document.body.replaceChildren(element);
    createRoot(element).render(React.createElement(VerificationWidget, {
      sessionId: "vps_noprovider", sdkToken: "sdk_browser", baseUrl: location.origin, faceModelUrl: null,
      theme: { primaryColor: "#123456", fontFamily: "Georgia, serif" },
      copy: { consent: { continue: "Weiter" } }
    }));
  }, sdkEntry);
  expect((await request).headers().authorization).toBeUndefined();
  await expect(page.getByRole("button", { name: "Weiter", exact: true })).toBeVisible();
  const vars = await page.evaluate(() => { const s = document.querySelector("[data-vp-widget]").style; return [s.getPropertyValue("--vp-primary"), s.getPropertyValue("--vp-font")]; });
  expect(vars).toEqual(["#123456", "Georgia, serif"]);
});

test("selfie capture through the controller submits once with capture telemetry", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/challenge*", route => route.fulfill({ json: { success: true, verificationType: "FACE_ONLY", livenessActions: [] } }));
  await page.route("**/consent", route => route.fulfill({ json: { success: true } }));
  let faces = 0;
  let submitted = null;
  await page.route("**/face", route => { faces++; return route.fulfill({ json: { success: true } }); });
  await page.route("**/verify", route => { submitted = route.request().postDataJSON(); return route.fulfill({ json: { success: true } }); });
  await page.route("**/status", route => route.fulfill({ json: { success: true, status: "approved", decision: { status: "approved", reasonCodes: [] } } }));
  await page.addInitScript(() => {
    // Synthetic camera: mid-grey noise (well lit, sharp) from a canvas stream.
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 640; canvas.height = 480;
      const ctx = canvas.getContext("2d");
      const paint = () => {
        const img = ctx.createImageData(640, 480);
        for (let i = 0; i < img.data.length; i += 4) { const v = 60 + Math.random() * 140; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
        ctx.putImageData(img, 0, 0);
      };
      paint(); setInterval(paint, 100);
      return canvas.captureStream(10);
    };
  });
  await page.goto("/");
  await page.evaluate(async (entry) => {
    const React = (await import("/node_modules/.vite/deps/react.js")).default;
    const { createRoot } = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
    const { VerificationWidget } = await import(entry);
    window.completions = 0;
    const element = document.createElement("div");
    document.body.replaceChildren(element);
    createRoot(element).render(React.createElement(VerificationWidget, {
      sessionId: "vps_selfie", sdkToken: "sdk_browser", baseUrl: location.origin, faceModelUrl: null, mobileHandoff: false,
      onComplete: () => { window.completions++; }
    }));
  }, sdkEntry);
  await consent(page);
  await expect(page.getByRole("heading", { name: "Take a selfie" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Capture manually" })).toBeEnabled();
  await page.getByRole("button", { name: "Capture manually" }).click();
  await expect(page.getByText("Verification approved.", { exact: true })).toBeVisible();
  expect(faces).toBe(1);
  expect(submitted.telemetry).toMatchObject({ actions: [] });
  expect(await page.evaluate(() => window.completions)).toBe(1);
  // The auto-capture loop ran on the live camera without throwing.
  expect(pageErrors).toEqual([]);
});
