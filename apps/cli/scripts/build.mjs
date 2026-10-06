#!/usr/bin/env node
import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(join(root, "package.json"), "utf8")));
const outfile = join(root, "dist", "ensemble.mjs");

await esbuild.build({
  entryPoints: [join(root, "src", "main.ts")],
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
  },
});

await chmod(outfile, 0o755);
