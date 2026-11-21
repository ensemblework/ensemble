#!/usr/bin/env node
/**
 * Fetch cua-driver (MIT, https://github.com/trycua/cua), the macOS desktop driver the Ensemble app runs
 * (apps/hub-api/src/desktop/control/drivers/macos-cua.ts), at the version pinned in
 * apps/hub-api/desktop-helper/macos/cua-driver.json: the universal (arm64 and x86_64) release archive is
 * checked against the pinned SHA-256 before anything is unpacked, and only the `cua-driver` executable,
 * signed by its publisher, is taken from it.
 *
 *   node scripts/fetch-cua-driver.mjs --out <file>
 *
 * ENSEMBLE_CUA_DRIVER_ARCHIVE names an archive downloaded already (an offline build); it is checked the same
 * way. Downloads are kept in node_modules/.cache/ensemble-cua-driver.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CUA_DRIVER_PIN = JSON.parse(readFileSync(join(root, "apps/hub-api/desktop-helper/macos/cua-driver.json"), "utf8"));

const LICENSE = `cua-driver ${CUA_DRIVER_PIN.version} (${CUA_DRIVER_PIN.url}), source commit ${CUA_DRIVER_PIN.sourceCommit}.

MIT License

Copyright (c) 2025 Cua AI, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

cua-driver includes code derived from these projects, each under the MIT licence above with its own
copyright: trope-cua (Copyright (c) 2026 Victor Vannara), Interface-Agent (Copyright (c) 2024 Francesco
Bonacci), yabai (Copyright (c) 2019 Åsmund Vikane), QuickJS-ng (Copyright (c) 2017-2026 Fabrice Bellard;
(c) 2017-2024 Charlie Gordon; (c) 2023-2026 Ben Noordhuis; (c) 2023-2026 Saúl Ibarra Corretgé), rquickjs
(Copyright (c) 2020 Mees Delzenne; (c) 2025 Rquickjs Contributors) and T3 Code (Copyright (c) 2026 T3 Tools
Inc.). The Rust crates compiled into it keep their own licences; the complete set is pinned by
libs/cua-driver/rust/Cargo.lock at the source commit above.
`;

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

async function download(url, path) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Downloading ${url} failed (HTTP ${response.status}).`);
  writeFileSync(`${path}.part`, Buffer.from(await response.arrayBuffer()));
  renameSync(`${path}.part`, path);
}

/** Puts the pinned cua-driver at `out` (with `<out>.LICENSE` beside it). */
export async function fetchCuaDriver({ out }) {
  const pin = CUA_DRIVER_PIN;
  const target = resolve(out);
  const cache = join(root, "node_modules", ".cache", "ensemble-cua-driver");
  mkdirSync(cache, { recursive: true });
  const given = process.env.ENSEMBLE_CUA_DRIVER_ARCHIVE?.trim();
  const archive = given ? resolve(given) : join(cache, pin.asset);
  if (!given && (!existsSync(archive) || sha256(archive) !== pin.sha256)) {
    console.log(`downloading ${pin.url}`);
    await download(pin.url, archive);
  }
  const actual = existsSync(archive) ? sha256(archive) : "missing";
  if (actual !== pin.sha256) {
    if (!given) rmSync(archive, { force: true });
    throw new Error(`cua-driver ${pin.version}: ${archive} has SHA-256 ${actual}; the pin (apps/hub-api/desktop-helper/macos/cua-driver.json) says ${pin.sha256}.`);
  }
  const work = mkdtempSync(join(cache, "unpack-"));
  try {
    const tar = spawnSync("tar", ["-xzf", archive, "-C", work, pin.member], { stdio: "inherit" });
    if (tar.status !== 0) throw new Error(`Unpacking ${pin.member} from ${archive} failed.`);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(work, pin.member), target);
    chmodSync(target, 0o755);
    writeFileSync(`${target}.LICENSE`, LICENSE);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`cua-driver ${pin.version} (sha256 ${pin.sha256} of ${pin.asset}) at ${target}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--out");
  const out = at > 0 ? process.argv[at + 1] : null;
  if (!out) {
    console.error("Usage: node scripts/fetch-cua-driver.mjs --out <file>");
    process.exit(1);
  }
  await fetchCuaDriver({ out }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
