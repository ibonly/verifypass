import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import { createVerifyPassApi } from "./server/verifypassApi.mjs";

// Mounts the server-side session API (server/verifypassApi.mjs) on the Vite
// dev and preview servers, so `npm run dev` runs the full integration on one
// origin. VERIFYPASS_* values are read server-side only; Vite exposes only
// VITE_* variables to browser code.
function verifyPassServerApi(env) {
  const api = createVerifyPassApi(env);
  return {
    name: "verifypass-server-api",
    configureServer(server) { server.middlewares.use(api); },
    configurePreviewServer(server) { server.middlewares.use(api); }
  };
}

export default defineConfig(({ mode }) => {
  const serverEnv = { ...loadEnv(mode, process.cwd(), "VERIFYPASS_"), ...pickVerifyPassEnv(process.env) };

  return {
    plugins: [
      vue({ template: { compilerOptions: { isCustomElement: (tag) => tag.startsWith("verifypass-") } } }),
      verifyPassServerApi(serverEnv)
    ],
    server: {
      port: 5176,
      strictPort: true
    },
    preview: {
      port: 4176
    }
  };
});

function pickVerifyPassEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("VERIFYPASS_")));
}
