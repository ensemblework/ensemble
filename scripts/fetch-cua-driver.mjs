#!/usr/bin/env node
/**
 * Fetch Cua Driver (cua-driver, MIT, https://github.com/trycua/cua), the desktop driver Ensemble starts, at the
 * version pinned for each system; the release archive is checked against the pinned SHA-256 before anything is
 * unpacked, and only the driver is taken from it, unchanged, with its licence and notices:
 *
 * - macOS (drivers/macos-cua.ts, apps/hub-api/desktop-helper/macos/cua-driver.json): the universal (arm64 and
 *   x86_64) archive's `CuaDriver.app`, signed and notarized by its publisher, whose signature is checked on a Mac;
 * - Windows (drivers/windows-cua.ts, apps/hub-api/desktop-helper/windows/cua-driver.json): the x64 or arm64 zip's
 *   `cua-driver.exe`, checked against its own pinned SHA-256 and, on Windows, its Authenticode signature (valid,
 *   the pinned publisher's).
 *
 *   node scripts/fetch-cua-driver.mjs --out <dir> [--windows x64|arm64]
 *
 * Writes `<dir>/CuaDriver.app` (macOS) or `<dir>/cua-driver.exe` (Windows), `<dir>/CuaDriver.LICENSE` and
 * `<dir>/CuaDriver.THIRD_PARTY_NOTICES.md`. ENSEMBLE_CUA_DRIVER_ARCHIVE names an archive downloaded already (an
 * offline build); it is checked the same way. Downloads are kept in node_modules/.cache/ensemble-cua-driver.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CUA_DRIVER_PIN = JSON.parse(readFileSync(join(root, "apps/hub-api/desktop-helper/macos/cua-driver.json"), "utf8"));
export const WINDOWS_CUA_DRIVER_PIN = JSON.parse(readFileSync(join(root, "apps/hub-api/desktop-helper/windows/cua-driver.json"), "utf8"));

const license = (pin, url) => `Cua Driver (cua-driver) ${pin.version} (${url}), source commit ${pin.sourceCommit}.

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
libs/cua-driver/rust/Cargo.lock at the source commit above; CuaDriver.THIRD_PARTY_NOTICES.md beside this file is
the notice file of the release archive.
`;

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

async function download(url, path) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Downloading ${url} failed (HTTP ${response.status}).`);
  writeFileSync(`${path}.part`, Buffer.from(await response.arrayBuffer()));
  renameSync(`${path}.part`, path);
}

/** Puts the pinned CuaDriver.app into the folder `out`, with its licence and notices beside it. */
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
  const prefix = dirname(pin.member);
  const notices = `${prefix}/THIRD_PARTY_NOTICES.md`;
  const work = mkdtempSync(join(cache, "unpack-"));
  try {
    const tar = spawnSync("tar", ["-xzf", archive, "-C", work, pin.member, notices], { stdio: "inherit" });
    if (tar.status !== 0) throw new Error(`Unpacking ${pin.member} from ${archive} failed.`);
    if (!existsSync(join(work, pin.member, "Contents", "MacOS", "cua-driver"))) throw new Error(`${pin.member} in ${archive} has no Contents/MacOS/cua-driver.`);
    const app = join(target, "CuaDriver.app");
    mkdirSync(target, { recursive: true });
    rmSync(app, { recursive: true, force: true });
    // Copied byte for byte with its modes: the publisher's signature covers every file of the bundle.
    cpSync(join(work, pin.member), app, { recursive: true, verbatimSymlinks: true });
    copyFileSync(join(work, notices), join(target, "CuaDriver.THIRD_PARTY_NOTICES.md"));
    writeFileSync(join(target, "CuaDriver.LICENSE"), license(pin, pin.url));
    if (process.platform === "darwin") verifySignature(app, pin.teamId);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`Cua Driver ${pin.version} (sha256 ${pin.sha256} of ${pin.asset}) at ${join(target, "CuaDriver.app")}`);
}

/** One file of a zip archive, by its name: read from the central directory, stored or deflated (no ZIP64). */
export function zipMember(zip, name) {
  const floor = Math.max(0, zip.length - 65_557);
  let end = -1;
  for (let at = zip.length - 22; at >= floor; at -= 1) {
    if (zip.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip archive");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  for (let n = 0; n < count; n += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("the zip archive's directory is damaged");
    const method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extra = zip.readUInt16LE(at + 30);
    const comment = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    if (zip.toString("utf8", at + 46, at + 46 + nameLength) === name) {
      if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name}'s entry in the zip archive is damaged`);
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const body = zip.subarray(start, start + packed);
      const data = method === 0 ? Buffer.from(body) : method === 8 ? inflateRawSync(body) : null;
      if (!data) throw new Error(`${name} is packed in a way this reader does not know (method ${method})`);
      if (data.length !== size) throw new Error(`${name} unpacked to ${data.length} bytes; the archive says ${size}`);
      return data;
    }
    at += 46 + nameLength + extra + comment;
  }
  throw new Error(`${name} is not in the zip archive`);
}

/** Puts the pinned `cua-driver.exe` for `arch` (x64 or arm64) into the folder `out`, with its licence and notices. */
export async function fetchWindowsCuaDriver({ out, arch = process.arch }) {
  const pin = WINDOWS_CUA_DRIVER_PIN;
  const asset = pin.assets[arch];
  if (!asset) throw new Error(`cua-driver ${pin.version} has no Windows build for ${arch} in the pin (apps/hub-api/desktop-helper/windows/cua-driver.json).`);
  const target = resolve(out);
  const cache = join(root, "node_modules", ".cache", "ensemble-cua-driver");
  mkdirSync(cache, { recursive: true });
  const given = process.env.ENSEMBLE_CUA_DRIVER_ARCHIVE?.trim();
  const archive = given ? resolve(given) : join(cache, asset.asset);
  if (!given && (!existsSync(archive) || sha256(archive) !== asset.sha256)) {
    console.log(`downloading ${asset.url}`);
    await download(asset.url, archive);
  }
  const actual = existsSync(archive) ? sha256(archive) : "missing";
  if (actual !== asset.sha256) {
    if (!given) rmSync(archive, { force: true });
    throw new Error(`cua-driver ${pin.version}: ${archive} has SHA-256 ${actual}; the pin (apps/hub-api/desktop-helper/windows/cua-driver.json) says ${asset.sha256}.`);
  }
  const zip = readFileSync(archive);
  const exe = zipMember(zip, asset.member);
  const exeSha = createHash("sha256").update(exe).digest("hex");
  if (exeSha !== asset.exeSha256 || exe.length !== asset.exeBytes) throw new Error(`cua-driver.exe in ${asset.asset} has SHA-256 ${exeSha} (${exe.length} bytes); the pin says ${asset.exeSha256} (${asset.exeBytes} bytes).`);
  const notices = zipMember(zip, `${dirname(asset.member)}/THIRD_PARTY_NOTICES.md`);
  mkdirSync(target, { recursive: true });
  const path = join(target, "cua-driver.exe");
  writeFileSync(`${path}.part`, exe);
  renameSync(`${path}.part`, path);
  writeFileSync(join(target, "CuaDriver.THIRD_PARTY_NOTICES.md"), notices);
  writeFileSync(join(target, "CuaDriver.LICENSE"), license(pin, asset.url));
  if (process.platform === "win32") verifyAuthenticode(path, pin.publisher);
  console.log(`Cua Driver ${pin.version} (sha256 ${asset.sha256} of ${asset.asset}) at ${path}`);
}

/** On Windows: the program's Authenticode signature is valid and its publisher's (the pinned organisation). */
function verifyAuthenticode(path, publisher) {
  const script = "$s = Get-AuthenticodeSignature -LiteralPath $env:ENSEMBLE_SIGNED_FILE; Write-Output $s.Status; Write-Output $s.SignerCertificate.Subject";
  // PowerShell 7's module path (inherited from a pwsh step) breaks Windows PowerShell 5.1's own modules.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"));
  const shown = spawnSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", env: { ...env, ENSEMBLE_SIGNED_FILE: path } });
  const [status, subject] = `${shown.stdout ?? ""}`.trim().split(/\r?\n/);
  if (shown.status !== 0 || status?.trim() !== "Valid") throw new Error(`cua-driver.exe's Authenticode signature does not verify (${status?.trim() || shown.stderr?.trim() || "no answer"}).`);
  if (!subject?.includes(`O=${publisher}`) && !subject?.includes(`CN=${publisher}`)) throw new Error(`cua-driver.exe is signed by ${subject?.trim() || "nobody"}; the pin says ${publisher}.`);
}

/** On a Mac: the bundle's signature holds and is its publisher's (the pinned team). */
function verifySignature(app, teamId) {
  const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", app], { encoding: "utf8" });
  if (verify.status !== 0) throw new Error(`CuaDriver.app's signature does not verify: ${(verify.stderr || "").trim()}`);
  const shown = spawnSync("codesign", ["-dv", app], { encoding: "utf8" });
  const team = /TeamIdentifier=(\S+)/.exec(`${shown.stdout}\n${shown.stderr}`)?.[1] ?? null;
  if (teamId && team !== teamId) throw new Error(`CuaDriver.app is signed by team ${team ?? "none"}; the pin says ${teamId}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--out");
  const out = at > 0 ? process.argv[at + 1] : null;
  const windows = process.argv.indexOf("--windows");
  const arch = windows > 0 ? process.argv[windows + 1] : null;
  if (!out || (windows > 0 && !arch)) {
    console.error("Usage: node scripts/fetch-cua-driver.mjs --out <dir> [--windows x64|arm64]");
    process.exit(1);
  }
  await (arch ? fetchWindowsCuaDriver({ out, arch }) : fetchCuaDriver({ out })).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
