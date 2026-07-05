import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ["@verifypass/sdk-core"]
  },
  build: {
    commonjsOptions: {
      include: [/node_modules/, /packages\/sdk-core/]
    }
  },
  define: {
    // API base for the hosted page; override at build time
    __VP_API_BASE__: JSON.stringify(process.env.VP_API_BASE || "https://api.verifypass.com")
  }
});
