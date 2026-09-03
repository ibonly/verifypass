import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@verifypass/sdk-core": path.resolve(__dirname, "../sdk/core/src/index.js"),
      "@verifypass/react": path.resolve(__dirname, "../sdk/react/src/index.js")
    }
  },
  optimizeDeps: {
    include: ["@verifypass/sdk-core"]
  },
  build: {
    commonjsOptions: {
      include: [/node_modules/, /sdk[\/]core/]
    }
  },
  define: {
    // API base for the hosted page; override at build time
    __VP_API_BASE__: JSON.stringify(process.env.VP_API_BASE || "https://api.verifypass.com")
  }
});
