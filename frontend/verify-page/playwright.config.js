import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30000,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:5187", browserName: "chromium" },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } }
  ],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 5187 --strictPort",
    url: "http://127.0.0.1:5187",
    env: {
      VITE_VP_API_BASE: "http://127.0.0.1:5187",
      VITE_VP_PUBLIC_KEY: "",
      VITE_VP_FACE_MODEL_URL: "/models/fr_detect.onnx",
      VITE_VP_LANDMARK_MODEL_URL: "/models/fr_landmark.onnx"
    }
  }
});