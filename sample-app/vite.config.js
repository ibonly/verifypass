import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Sample webcam test app. Point it at your running API and paste a secret key
// from the dev stack. Camera capture requires a secure context — localhost is
// treated as secure by browsers, so `vite dev` on http://localhost works.
export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@verifypass/sdk-core": path.resolve(__dirname, "../frontend/sdk/core/src/index.js"),
      "@verifypass/react": path.resolve(__dirname, "../frontend/sdk/react/src/index.js")
    }
  },
  server: {
    proxy: {
      "/v1": {
        target: process.env.VP_API_PROXY_TARGET || "http://localhost:3000",
        changeOrigin: false,
        xfwd: true
      }
    }
  },
  optimizeDeps: {
    // sdk-core is a linked CommonJS workspace package; force pre-bundling so it
    // exposes proper ESM named exports to the dev server.
    include: ["@verifypass/sdk-core"]
  },
  build: {
    commonjsOptions: {
      include: [/node_modules/, /sdk[\/]core/]
    }
  },
  define: {
    __VP_API_BASE__: JSON.stringify(process.env.VP_API_BASE || ""),
    // Optional convenience for local testing only — never ship a secret key to a browser.
    __VP_SECRET_KEY__: JSON.stringify(process.env.VP_SECRET_KEY || "")
  }
});
