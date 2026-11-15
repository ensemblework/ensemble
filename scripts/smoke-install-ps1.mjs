#!/usr/bin/env node
/**
 * Runs apps/landing/public/install.ps1 in Windows PowerShell against one CLI archive served on 127.0.0.1, then
 * the command it installed. The installer must choose the build for this computer's processor. On Windows on
 * Arm it runs a second time against a release that lists only an x64 build, which it must fall back to.
 *
 * Usage (Windows): node scripts/smoke-install-ps1.mjs dist/cli/ensemble-cli-<version>-<windows-x64|windows-arm64>.zip
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const archive = resolve(process.argv[2] ?? "");
const match = basename(archive).match(/^ensemble-cli-(\d+\.\d+\.\d+)-(windows-(?:x64|arm64))\.zip$/);
if (process.platform !== "win32" || !match) {
  console.error("Usage (Windows): node scripts/smoke-install-ps1.mjs dist/cli/ensemble-cli-<version>-<windows-x64|windows-arm64>.zip");
  process.exit(1);
}
const [, version, target] = match;
if (target !== `windows-${process.arch}`) throw new Error(`${basename(archive)} is not the build for this computer (windows-${process.arch}).`);
const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");

const cases = [{ served: basename(archive), expect: target }];
// The same bytes under the x64 name stand in for a release published before Windows on Arm builds.
if (target === "windows-arm64") cases.push({ served: `ensemble-cli-${version}-windows-x64.zip`, expect: "windows-x64" });

// install.ps1 adds its bin folder to the user PATH; put the PATH back afterwards.
const userPath = powershell("[Environment]::GetEnvironmentVariable('Path', 'User')").trim();
const temp = mkdtempSync(join(tmpdir(), "ensemble-install-smoke-"));
try {
  for (const [index, { served, expect }] of cases.entries()) {
    const installDir = join(temp, `install-${index}`);
    const output = await install(served, installDir);
    if (!output.includes(`for ${expect}...`) || !output.includes(`Ensemble CLI ${version} installed at`)) {
      throw new Error(`install.ps1 did not install ${expect} from ${served}:\n${output}`);
    }
    const command = join(installDir, "current", "bin", "ensemble.exe");
    const result = spawnSync(command, ["--version"], { encoding: "utf8" });
    if (result.status !== 0 || !`${result.stdout}${result.stderr}`.includes(version)) {
      throw new Error(`${command} --version failed (${result.error?.message ?? result.status}):\n${result.stdout}\n${result.stderr}`);
    }
    console.error(`install.ps1 OK: ${served} offered, ${expect} installed, ensemble --version ${version}.`);
  }
} finally {
  powershell("[Environment]::SetEnvironmentVariable('Path', $env:ENSEMBLE_SMOKE_USER_PATH, 'User')", { ENSEMBLE_SMOKE_USER_PATH: userPath });
  rmSync(temp, { recursive: true, force: true });
}

/** Serves `served` (the archive's bytes) and a SHA256SUMS.txt listing it, then runs install.ps1 against them. */
async function install(served, installDir) {
  const server = createServer((req, res) => {
    if (req.url === "/SHA256SUMS.txt") return void res.end(`${sha256}  ${served}\n`);
    if (req.url === `/${served}`) return void createReadStream(archive).pipe(res);
    res.writeHead(404).end();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    const env = {
      ...process.env,
      ENSEMBLE_VERSION: version,
      ENSEMBLE_DOWNLOAD_BASE: `http://127.0.0.1:${server.address().port}`,
      ENSEMBLE_INSTALL_DIR: installDir,
    };
    // Windows PowerShell's download progress bar slows a large download many times over; it is off here only.
    // A Fail in the script exits 1 ($? false); a junction that falls back to a copy leaves a non-zero $LASTEXITCODE.
    const run = "$ProgressPreference = 'SilentlyContinue'; & $env:ENSEMBLE_SMOKE_INSTALLER; if (-not $?) { exit 1 }; exit 0";
    env.ENSEMBLE_SMOKE_INSTALLER = join(root, "apps", "landing", "public", "install.ps1");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", run], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const status = await new Promise((done) => child.on("close", done));
    if (status !== 0) throw new Error(`install.ps1 exited with ${status}:\n${output}`);
    return output;
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

function powershell(command, env = {}) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`powershell.exe failed: ${result.stderr}`);
  return result.stdout;
}
