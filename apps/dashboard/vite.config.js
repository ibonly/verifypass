import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    __VP_API_BASE__: JSON.stringify(process.env.VP_API_BASE || "https://api.verifypass.com")
  }
});
