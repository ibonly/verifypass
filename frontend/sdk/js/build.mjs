// Builds the self-contained browser bundles (no runtime dependencies):
//   dist/verifypass.js           IIFE  window.VerifyPass.init — hosted iframe / QR embed
//   dist/verifypass-liveness.js  IIFE  registers <verifypass-liveness> (React bundled)
//   dist/index.mjs               ESM   init + headless controller / detector / capture loop
//   dist/element.mjs             ESM   registers <verifypass-liveness>
// `node build.mjs --check` fails when the committed dist is stale.
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const check = process.argv.includes("--check");

// `?url` imports only resolve under Vite; bundles load the WASM from the
// hosted VerifyPass origin instead (see react/src/assets.js).
const viteUrlImports = {
  name: "vite-url-imports",
  setup(b) {
    b.onResolve({ filter: /\?url$/ }, (args) => ({ path: args.path, namespace: "vite-url" }));
    b.onLoad({ filter: /.*/, namespace: "vite-url" }, () => ({ contents: "export default undefined;", loader: "js" }));
  }
};

const common = {
  bundle: true,
  minify: true,
  platform: "browser",
  target: "es2020",
  jsx: "automatic",
  loader: { ".js": "jsx" },
  // React, ORT and qrcode resolve from this package even for ../react/src files.
  nodePaths: [path.join(root, "node_modules")],
  alias: {
    // One React for every module, including ../react/src (whose own
    // node_modules may hold an auto-installed peer copy).
    "react": path.join(root, "node_modules", "react"),
    "react-dom": path.join(root, "node_modules", "react-dom"),
    "@verifypass/sdk-core": path.join(root, "..", "core", "src", "index.js"),
    "@verifypass/react": path.join(root, "..", "react", "src", "index.js")
  },
  define: { "process.env.NODE_ENV": "\"production\"", "import.meta.env": "undefined" },
  logOverride: { "empty-import-meta": "silent" },
  plugins: [viteUrlImports],
  legalComments: "none",
  write: !check,
  logLevel: "warning"
};

const targets = [
  { entryPoints: [path.join(root, "src", "global.js")], outfile: path.join(root, "dist", "verifypass.js"), format: "iife", globalName: "VerifyPass" },
  { entryPoints: [path.join(root, "src", "element.jsx")], outfile: path.join(root, "dist", "verifypass-liveness.js"), format: "iife", globalName: "VerifyPassLiveness" },
  { entryPoints: [path.join(root, "src", "index.mjs")], outfile: path.join(root, "dist", "index.mjs"), format: "esm" },
  { entryPoints: [path.join(root, "src", "element.jsx")], outfile: path.join(root, "dist", "element.mjs"), format: "esm" }
];

let stale = false;
for (const target of targets) {
  const result = await build({ ...common, ...target });
  if (check) {
    const current = await readFile(target.outfile, "utf8").catch(() => "");
    if (result.outputFiles[0].text !== current) {
      stale = true;
      console.error(`${path.relative(root, target.outfile)} is stale`);
    }
  }
}
// Types ship self-contained: a copy of the core declarations.
const coreTypes = await readFile(path.join(root, "..", "core", "index.d.ts"), "utf8");
const typesFile = path.join(root, "types", "core.d.ts");
if (check) {
  if ((await readFile(typesFile, "utf8").catch(() => "")) !== coreTypes) { stale = true; console.error("types/core.d.ts is stale"); }
} else {
  await mkdir(path.dirname(typesFile), { recursive: true });
  await writeFile(typesFile, coreTypes);
}
if (stale) {
  console.error("@verifypass/sdk-js dist is stale: run `npm run build --prefix frontend/sdk/js` and commit dist/");
  process.exit(1);
}
if (check) console.log("@verifypass/sdk-js dist is up to date");
