#!/usr/bin/env node
/**
 * Build landrun, the Landlock helper the Linux sandbox falls back to
 * (MIT, https://github.com/zouuup/landrun), at a pinned version.
 *
 * Its own release binaries link glibc 2.38, which Ubuntu 22.04, Debian 12 and
 * RHEL 9 do not have, so Ensemble builds it from source with CGO off: a fully
 * static binary that runs on every distribution. Go's checksum database
 * verifies the module source.
 *
 *   node scripts/build-landrun.mjs --out <file> [--arch x64|arm64]
 *
 * Without Go it prints a warning and exits 0 (the sandbox then uses bubblewrap
 * where it can), unless ENSEMBLE_REQUIRE_LANDRUN=1, as release builds set.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LANDRUN_MODULE = "github.com/zouuup/landrun";
export const LANDRUN_VERSION = "v0.1.17";

function go(args, options = {}) {
  return spawnSync("go", args, { encoding: "utf8", stdio: options.capture ? "pipe" : "inherit", ...options });
}

export function buildLandrun({ out, arch = process.arch }) {
  const goarch = arch === "x64" || arch === "amd64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (!goarch) throw new Error(`landrun is built for x64 and arm64, not ${arch}.`);
  const version = go(["version"], { capture: true });
  if (version.error || version.status !== 0) {
    const message = "Go is not installed, so landrun (the Linux Landlock sandbox helper) was not built. Linux installs then use bubblewrap where available.";
    if (process.env.ENSEMBLE_REQUIRE_LANDRUN === "1") throw new Error(message);
    console.warn(message);
    return false;
  }
  const work = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "ensemble-landrun-"));
  const env = { ...process.env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: goarch, GOFLAGS: "-mod=mod", GOTOOLCHAIN: process.env.GOTOOLCHAIN || "auto" };
  try {
    for (const args of [
      ["mod", "init", "ensemble.local/landrun-build"],
      ["get", `${LANDRUN_MODULE}@${LANDRUN_VERSION}`],
      ["build", "-trimpath", "-ldflags", "-s -w", "-o", resolve(out), `${LANDRUN_MODULE}/cmd/landrun`],
    ]) {
      const result = go(args, { cwd: work, env });
      if (result.status !== 0) throw new Error(`go ${args.join(" ")} failed while building landrun.`);
    }
    chmodSync(resolve(out), 0o755);
    const cache = go(["env", "GOMODCACHE"], { capture: true, cwd: work, env }).stdout.trim();
    const license = join(cache, `${LANDRUN_MODULE}@${LANDRUN_VERSION}`, "LICENSE");
    if (existsSync(license)) copyFileSync(license, `${resolve(out)}.LICENSE`);
    console.log(`built landrun ${LANDRUN_VERSION} (linux/${goarch}, static) at ${resolve(out)}`);
    return true;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const out = value("--out");
  if (!out) {
    console.error("usage: node scripts/build-landrun.mjs --out <file> [--arch x64|arm64]");
    process.exit(2);
  }
  mkdirSync(dirname(resolve(out)), { recursive: true });
  buildLandrun({ out, arch: value("--arch") ?? process.arch });
}
