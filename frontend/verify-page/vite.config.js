import path from "path";
import { fileURLToPath } from "url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, ["VITE_VP_", "VP_API_BASE"]);
  return {
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
    __VP_API_BASE__: JSON.stringify(env.VITE_VP_API_BASE || env.VP_API_BASE || "")
  }
  };
});
