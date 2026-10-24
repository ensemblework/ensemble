#!/usr/bin/env node
import { chmod, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { releaseVersion, checkReleaseVersion } = await import("../../../scripts/release-version.mjs");
checkReleaseVersion();
const testing = process.argv.includes("--testing");
const version = testing ? process.env.ENSEMBLE_TEST_CLI_VERSION || `${releaseVersion}-testing.0` : releaseVersion;
if (testing && !new RegExp(`^${releaseVersion.replaceAll(".", "\\.")}-testing\\.\\d+$`).test(version)) throw new Error("Testing CLI version must match release.json with a -testing.<build> suffix.");
const outfile = join(root, "dist", testing ? "ensemble-test.mjs" : "ensemble.mjs");
const { testingInstallers } = await import("../../../scripts/testing-cli.mjs");
const installers = testing ? testingInstallers() : {
  sh: await readFile(join(root, "../landing/public/install.sh"), "utf8"),
  ps1: await readFile(join(root, "../landing/public/install.ps1"), "utf8"),
};

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
    __ENSEMBLE_VERSION__: JSON.stringify(version),
    __ENSEMBLE_CLI_CHANNEL__: JSON.stringify(testing ? "testing" : "production"),
    __ENSEMBLE_INSTALL_SH__: JSON.stringify(installers.sh),
    __ENSEMBLE_INSTALL_PS1__: JSON.stringify(installers.ps1),
    // React's production build: smaller, and no development warnings in the terminal.
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});

await chmod(outfile, 0o755);
