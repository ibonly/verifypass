// Builds dist/index.mjs: plain ESM (no JSX, no Vite-only imports) so webpack,
// Next.js, Angular CLI, Rollup and Vite can all consume @verifypass/react.
// `node build.mjs --check` fails when the committed dist is stale.
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(root, "dist", "index.mjs");
const check = process.argv.includes("--check");

// `?url` asset imports only resolve under Vite. In the dist they become
// undefined; hosts pass `ortWasmUrl` to VerifyPassProvider instead.
const viteUrlImports = {
  name: "vite-url-imports",
  setup(b) {
    b.onResolve({ filter: /\?url$/ }, (args) => ({ path: args.path, namespace: "vite-url" }));
    b.onLoad({ filter: /.*/, namespace: "vite-url" }, () => ({ contents: "export default undefined;", loader: "js" }));
  }
};

const result = await build({
  entryPoints: [path.join(root, "src", "index.js")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  jsx: "automatic",
  loader: { ".js": "jsx" },
  external: ["react", "react/*", "react-dom", "react-dom/*", "@verifypass/sdk-core", "onnxruntime-web", "onnxruntime-web/*", "qrcode"],
  plugins: [viteUrlImports],
  legalComments: "none",
  write: !check,
  logLevel: "warning"
});

if (check) {
  const built = result.outputFiles[0].text;
  const current = await readFile(outfile, "utf8").catch(() => "");
  if (built !== current) {
    console.error("@verifypass/react dist is stale: run `npm run build --prefix frontend/sdk/react` and commit dist/");
    process.exit(1);
  }
  console.log("@verifypass/react dist is up to date");
}
