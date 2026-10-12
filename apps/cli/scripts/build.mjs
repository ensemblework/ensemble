#!/usr/bin/env node
import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(join(root, "package.json"), "utf8")));
const outfile = join(root, "dist", "ensemble.mjs");

/**
 * Ink loads react-devtools-core only when DEV=true; a single-file bundle would otherwise turn
 * that into an import at start-up. It resolves to an empty module instead.
 */
const noDevtools = {
  name: "no-react-devtools",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "ensemble-stub" }));
    build.onLoad({ filter: /.*/, namespace: "ensemble-stub" }, () => ({ contents: "export default { connectToDevTools() {} };", loader: "js" }));
  },
};

await esbuild.build({
  entryPoints: [join(root, "src", "main.ts")],
  plugins: [noDevtools],
  jsx: "automatic",
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  mainFields: ["module", "main"],
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __ensembleCreateRequire } from 'node:module';\nconst require = __ensembleCreateRequire(import.meta.url);",
  },
  define: {
    __ENSEMBLE_VERSION__: JSON.stringify(packageJson.version),
    // React's production build: smaller, and no development warnings in the terminal.
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});

await chmod(outfile, 0o755);
