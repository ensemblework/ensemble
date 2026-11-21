#!/usr/bin/env node
/**
 * Build ensemble-disclaim (apps/hub-api/desktop-helper/macos/disclaim.c), the launcher that starts Cua Driver
 * as its own responsible process, so macOS asks about and checks Cua Driver's grants and never the Ensemble
 * app's. A universal (arm64 and x86_64) binary for macOS 13 and later, signed ad hoc, and run once beside a
 * stand-in Cua Driver to prove it starts that and refuses anything else.
 *
 *   node scripts/build-disclaim.mjs --out <file>
 *
 * Needs a Mac with the Xcode command line tools (clang, codesign).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DISCLAIM_SOURCE = join(root, "apps/hub-api/desktop-helper/macos/disclaim.c");

function must(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}.`);
}

export function buildDisclaim({ out }) {
  if (process.platform !== "darwin") throw new Error("ensemble-disclaim is built on a Mac.");
  const target = resolve(out);
  mkdirSync(dirname(target), { recursive: true });
  must("clang", ["-O2", "-std=gnu11", "-Wall", "-Wextra", "-Werror", "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=13.0", "-o", target, DISCLAIM_SOURCE]);
  chmodSync(target, 0o755);
  must("codesign", ["--force", "--sign", "-", target]);
  const work = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "ensemble-disclaim-"));
  try {
    const launcher = join(work, "ensemble-disclaim");
    const driver = join(work, "CuaDriver.app", "Contents", "MacOS", "cua-driver");
    copyFileSync(target, launcher);
    chmodSync(launcher, 0o755);
    mkdirSync(dirname(driver), { recursive: true });
    writeFileSync(driver, '#!/bin/sh\necho "disclaimed $*"\n', { mode: 0o755 });
    const started = spawnSync(launcher, [driver, "mcp", "--direct"], { encoding: "utf8" });
    if (started.status !== 0 || started.stdout.trim() !== "disclaimed mcp --direct") throw new Error(`ensemble-disclaim did not start the Cua Driver beside it: ${(started.stderr || started.error?.message || "").trim()}`);
    const refused = spawnSync(launcher, ["/bin/echo", "mcp", "--direct"], { encoding: "utf8" });
    if (refused.status !== 64 || refused.stdout) throw new Error("ensemble-disclaim started a program other than the Cua Driver beside it.");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`ensemble-disclaim at ${target}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--out");
  const out = at > 0 ? process.argv[at + 1] : null;
  if (!out) {
    console.error("Usage: node scripts/build-disclaim.mjs --out <file>");
    process.exit(1);
  }
  try {
    buildDisclaim({ out });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
