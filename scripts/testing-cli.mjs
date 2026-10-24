import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TEST_CLI_RELEASE = "https://github.com/ensemblework/ensemble/releases/download/cli-testing-latest";
export function testingInstallers() {
  let sh = readFileSync(join(root, "apps/landing/public/install.sh"), "utf8");
  const selection = sh.indexOf("version_from_env=");
  const end = sh.indexOf("target=$(detect_target)", selection);
  if (selection < 0 || end < 0) throw new Error("Production shell installer selection changed; review the testing renderer.");
  sh = sh.slice(0, selection) + `version=\${ENSEMBLE_TEST_VERSION:-}
base=${TEST_CLI_RELEASE}
if [ -z "$version" ]; then
  version=$(fetch_stdout "$base/channel.json" | sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' | head -1)
fi
case "$version" in *-testing.*) ;; *) fail "Expected a testing CLI version, not a production release" ;; esac
tag=cli-testing-latest
` + sh.slice(end);
  sh = sh.replaceAll("ensemble-cli", "ensemble-test-cli")
    .replaceAll("ENSEMBLE_INSTALL_DIR", "ENSEMBLE_TEST_INSTALL_DIR")
    .replaceAll("ENSEMBLE_DOWNLOAD_BASE", "ENSEMBLE_TEST_DOWNLOAD_BASE")
    .replaceAll("ENSEMBLE_VERSION", "ENSEMBLE_TEST_VERSION")
    .replaceAll("$payload/ensemble", "$payload/ensemble-test")
    .replaceAll("$version_dir/ensemble", "$version_dir/ensemble-test")
    .replaceAll("/bin/ensemble", "/bin/ensemble-test")
    .replaceAll("/.ensemble.$$", "/.ensemble-test.$$")
    .replaceAll("ensemble login", "ensemble-test login")
    .replaceAll("Ensemble CLI", "Ensemble Testing CLI");

  let ps1 = readFileSync(join(root, "apps/landing/public/install.ps1"), "utf8");
  const selectStart = ps1.indexOf("$Pinned =");
  const selectEnd = ps1.indexOf("$Version = $Selected.Version", selectStart);
  if (selectStart < 0 || selectEnd < 0) throw new Error("Production Windows installer selection changed; review the testing renderer.");
  ps1 = ps1.slice(0, selectStart) + `$TestBase = "${TEST_CLI_RELEASE}"
$TestVersion = $env:ENSEMBLE_TEST_VERSION
if (-not $TestVersion) { $TestVersion = (Invoke-RestMethod -UseBasicParsing -Uri "$TestBase/channel.json").version }
if ($TestVersion -notmatch '^\\d+\\.\\d+\\.\\d+-testing\\.\\d+$') { Fail "Expected a testing CLI version" }
$Selected = @{ Version = $TestVersion; Tag = "cli-testing-latest" }
` + ps1.slice(selectEnd);
  ps1 = ps1.replaceAll("ensemble-cli", "ensemble-test-cli")
    .replaceAll("ENSEMBLE_INSTALL_DIR", "ENSEMBLE_TEST_INSTALL_DIR")
    .replaceAll("ENSEMBLE_DOWNLOAD_BASE", "ENSEMBLE_TEST_DOWNLOAD_BASE")
    .replaceAll("ENSEMBLE_VERSION", "ENSEMBLE_TEST_VERSION")
    .replaceAll("Programs\\Ensemble", "Programs\\Ensemble Testing")
    .replaceAll('"ensemble"', '"ensemble-test"')
    .replaceAll("bin\\ensemble.exe", "bin\\ensemble-test.exe")
    .replaceAll("ensemble login", "ensemble-test login")
    .replaceAll("Ensemble CLI", "Ensemble Testing CLI");
  return { sh, ps1 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) throw new Error("Usage: node scripts/testing-cli.mjs <output-directory>");
  mkdirSync(out, { recursive: true });
  const { sh, ps1 } = testingInstallers();
  writeFileSync(join(out, "install.sh"), sh, { mode: 0o755 });
  writeFileSync(join(out, "install.ps1"), ps1);
}
