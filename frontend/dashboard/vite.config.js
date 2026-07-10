import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: {
    __VP_API_BASE__: JSON.stringify(
      process.env.VP_API_BASE || (command === "serve" ? "http://localhost:3000" : "https://api.verifypass.com")
    )
  }
}));
