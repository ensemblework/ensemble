#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run as spawnCommand } from "./desktop-spawn.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supportedTargets = new Set(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64"]);

const options = parseArgs(process.argv.slice(2));
if (!options.target) usage("Missing required --target.");
if (!supportedTargets.has(options.target)) usage(`Unsupported --target ${options.target}.`);

const host = hostTarget();
if (host !== options.target) {
  usage(`Target ${options.target} must be built on a matching host. This host is ${host}.`);
}

const cliPackage = JSON.parse(readFileSync(join(root, "apps/cli/package.json"), "utf8"));
const version = cliPackage.version;
if (!version || typeof version !== "string") usage("apps/cli/package.json does not contain a string version.");

const outDir = resolve(root, options.out);
const stageRoot = join(outDir, `.stage-${options.target}`);
const ensembleDir = join(stageRoot, "ensemble");
const binDir = join(ensembleDir, "bin");
const libDir = join(ensembleDir, "lib");
const sidecarDir = join(ensembleDir, "sidecar");
const archiveName =
  options.target === "windows-x64" ? `ensemble-cli-${version}-${options.target}.zip` : `ensemble-cli-${version}-${options.target}.tar.gz`;
const archivePath = join(outDir, archiveName);

mkdirSync(outDir, { recursive: true });

run("pnpm", ["--filter", "ensemblework", "build"], { cwd: root });

const bundle = join(root, "apps/cli/dist/ensemble.mjs");
if (!existsSync(bundle)) {
  throw new Error("CLI build completed, but apps/cli/dist/ensemble.mjs does not exist.");
}

rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(binDir, { recursive: true });
mkdirSync(libDir, { recursive: true });
mkdirSync(sidecarDir, { recursive: true });

if (options.skipSidecar) {
  copyNodeOnly(sidecarDir);
} else {
  run(process.execPath, ["scripts/assemble-desktop-sidecar.mjs", "--dest", sidecarDir], { cwd: root });
}

copyFileSync(bundle, join(libDir, "ensemble.mjs"));
writeFileSync(join(ensembleDir, "VERSION"), `${version}\n`);
copyFileSync(join(root, "LICENSE.md"), join(ensembleDir, "LICENSE.md"));

copyFileSync(join(root, "apps/cli/bin/ensemble"), join(binDir, "ensemble"));
chmodSync(join(binDir, "ensemble"), 0o755);

if (options.target === "windows-x64") {
  buildWindowsLauncher(join(binDir, "ensemble.exe"));
  writeWindowsCmd(join(binDir, "ensemble.cmd"));
}

rmSync(archivePath, { force: true });
if (options.target === "windows-x64") {
  // Zip output needs bsdtar: Windows ships it in System32, macOS as tar. The tar
  // from Git for Windows, often first on PATH, is GNU tar and cannot write zip.
  const bsdtar = process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
  run(bsdtar, ["-a", "-c", "-f", archivePath, "-C", stageRoot, "ensemble"], { cwd: root });
} else {
  run("tar", ["-czf", archivePath, "-C", stageRoot, "ensemble"], { cwd: root });
}

const sha256 = await sha256File(archivePath);
console.log(`${sha256}  ${archiveName}`);
console.log(`Archive: ${archivePath}`);

function parseArgs(args) {
  const parsed = { out: "dist/cli", skipSidecar: false, target: "" };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--target") {
      parsed.target = valueAfter(args, i, arg);
      i += 1;
      continue;
    }
    if (arg.startsWith("--target=")) {
      parsed.target = arg.slice("--target=".length);
      continue;
    }
    if (arg === "--out") {
      parsed.out = valueAfter(args, i, arg);
      i += 1;
      continue;
    }
    if (arg.startsWith("--out=")) {
      parsed.out = arg.slice("--out=".length);
      continue;
    }
    if (arg === "--skip-sidecar") {
      parsed.skipSidecar = true;
      continue;
    }
    usage(`Unknown option ${arg}.`);
  }
  return parsed;
}

function valueAfter(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) usage(`${name} requires a value.`);
  return value;
}

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: node scripts/package-cli.mjs --target <darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64> [--out dist/cli] [--skip-sidecar]");
  process.exit(1);
}

function hostTarget() {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" || process.arch === "arm64" ? process.arch : "";
  if (!arch || !["darwin", "linux", "windows"].includes(platform)) {
    return `${platform}-${process.arch}`;
  }
  return `${platform}-${arch}`;
}

// desktop-spawn resolves Windows `.cmd` shims such as pnpm.cmd, which a plain spawnSync cannot start.
function run(command, args, options = {}) {
  console.error(`$ ${[command, ...args].join(" ")}`);
  const status = spawnCommand(command, args, options);
  if (status !== 0) throw new Error(`${command} exited with status ${status}.`);
}

function copyNodeOnly(dest) {
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const nodeDest = join(dest, nodeName);
  if (process.platform === "win32") {
    copyFileSync(process.execPath, nodeDest);
  } else {
    writeFileSync(nodeDest, `#!/bin/sh\nexec ${shQuote(process.execPath)} "$@"\n`);
    chmodSync(nodeDest, 0o755);
  }
  writeFileSync(
    join(dest, "SKIPPED_FULL_SIDECAR.txt"),
    "Created by scripts/package-cli.mjs --skip-sidecar for fast packaging smoke tests. Full releases assemble sidecar/app.\n",
  );
}

function shQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildWindowsLauncher(exePath) {
  const version = spawnSync("go", ["version"], { encoding: "utf8" });
  if (version.error || version.status !== 0) {
    throw new Error("The windows-x64 package requires Go to build apps/cli/launcher/ensemble.exe. Install Go or run on the configured Windows release runner.");
  }
  run("go", ["build", "-o", exePath, "."], {
    cwd: join(root, "apps/cli/launcher"),
    env: { ...process.env, GOOS: "windows", GOARCH: "amd64" },
  });
}

function writeWindowsCmd(file) {
  writeFileSync(
    file,
    [
      "@echo off",
      "setlocal",
      'set "SCRIPT_DIR=%~dp0"',
      'set "ENSEMBLE_LAUNCHER=%~f0"',
      'set "ENSEMBLE_SIDECAR_DIR=%SCRIPT_DIR%..\\sidecar"',
      '"%SCRIPT_DIR%..\\sidecar\\node.exe" "%SCRIPT_DIR%..\\lib\\ensemble.mjs" %*',
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n"),
  );
}

function sha256File(file) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}
