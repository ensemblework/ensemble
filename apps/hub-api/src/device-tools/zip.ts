/**
 * Zip archives for what a node shares (device-tools/share.ts), with no dependency: deflate from
 * node:zlib and the ZIP format written here. A folder becomes one `.zip`, file by file under the same
 * floor as a single shared file (`readEvidenceFile`: no link, one name, no key, `.env`, history or
 * saved secret value, not Ensemble's data or another account's), text redacted as a shared text file
 * is, and dependency and cache folders left out. An archive already on disk (a `.zip`, an Office file,
 * a `.tar` or `.tar.gz`) is read for its entry names, which meet the same name rules, and for saved
 * secret values in what it holds, as far as `ARCHIVE_SCAN_BYTES`. No ZIP64: a share is at most
 * 100 MB and `MAX_ZIP_ENTRIES` files.
 */
import { lstat, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { readEvidenceFile } from "../evidence/files.js";
import { credentialPathReason, evidenceName, isTextMime } from "../evidence/limits.js";
import { redactText } from "../lib/redact.js";
import { refusedPath } from "../workspace/folder-read.js";
import { GuardError } from "../workspace/guard.js";

/** The most files one zipped folder holds. */
export const MAX_ZIP_ENTRIES = 10_000;
/** The most a folder's files may add up to before they are zipped: a brake on zipping a disk for nothing. */
export const MAX_ZIP_INPUT_BYTES = 1024 * 1024 * 1024;
/** How much of an archive's contents is read for saved secret values. */
export const ARCHIVE_SCAN_BYTES = 256 * 1024 * 1024;

/** Folders of dependencies, builds' caches and editors' state: left out of a zipped folder. */
const LEFT_OUT_FOLDERS = new Set(["node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".next", ".turbo", ".cache", ".parcel-cache", ".gradle", ".idea"]);
const LEFT_OUT_FILES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 as ZIP uses it: node:zlib's where this Node has it (22.2 and 20.15 on), else a table. */
export function crc32(bytes: Uint8Array): number {
  const native = (zlib as { crc32?: (data: Uint8Array) => number }).crc32;
  if (typeof native === "function") return native(bytes) >>> 0;
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) crc = TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time, as ZIP keeps them (local time, two-second steps, from 1980). */
function dosTime(date: Date): { time: number; date: number } {
  const year = date.getFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: (Math.min(year - 1980, 127) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

type Central = { name: Buffer; crc: number; compressed: number; size: number; method: number; time: number; date: number; offset: number };

export class ZipTooLarge extends GuardError {}

/** A ZIP file written entry by entry: each entry deflated (or stored, when deflate does not help), the directory at the end. */
export class ZipWriter {
  private offset = 0;
  /** The central directory's length so far. */
  private directory = 0;
  private readonly entries: Central[] = [];

  private constructor(
    private readonly handle: Awaited<ReturnType<typeof open>>,
    private readonly maxBytes: number,
  ) {}

  /** A new ZIP at `path` (never over an existing file), at most `maxBytes` long. */
  static async create(path: string, maxBytes: number): Promise<ZipWriter> {
    return new ZipWriter(await open(path, "wx", 0o600), maxBytes);
  }

  get count(): number {
    return this.entries.length;
  }

  get bytes(): number {
    return this.offset;
  }

  private async write(buffer: Uint8Array): Promise<void> {
    await this.handle.write(buffer, 0, buffer.length, this.offset);
    this.offset += buffer.length;
  }

  /** Adds one file; `name` is its path in the archive, with forward slashes. */
  async add(name: string, bytes: Uint8Array, modified: Date): Promise<void> {
    if (this.entries.length >= 0xffff) throw new ZipTooLarge("Too many files for one zip.");
    const deflated = zlib.deflateRawSync(bytes, { level: 6 });
    const method = deflated.length < bytes.length ? 8 : 0;
    const data = method === 8 ? deflated : bytes;
    const encoded = Buffer.from(name, "utf8");
    // What is written so far, this entry, its directory record and the directory's end must fit.
    if (this.offset + 30 + encoded.length + data.length + this.directory + 46 + encoded.length + 22 > this.maxBytes) throw new ZipTooLarge(`It zips to more than ${Math.round(this.maxBytes / 1024 / 1024)} MB.`);
    const { time, date } = dosTime(modified);
    const crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    // Bit 11: the name is UTF-8.
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(encoded.length, 26);
    header.writeUInt16LE(0, 28);
    const offset = this.offset;
    await this.write(header);
    await this.write(encoded);
    await this.write(data);
    this.entries.push({ name: encoded, crc, compressed: data.length, size: bytes.length, method, time, date, offset });
    this.directory += 46 + encoded.length;
  }

  /** Writes the directory and closes the file. */
  async finish(): Promise<void> {
    try {
      const start = this.offset;
      for (const entry of this.entries) {
        const record = Buffer.alloc(46);
        record.writeUInt32LE(0x02014b50, 0);
        // Made by: Unix, ZIP 2.0; so unzip gives the files ordinary permissions.
        record.writeUInt16LE((3 << 8) | 20, 4);
        record.writeUInt16LE(20, 6);
        record.writeUInt16LE(0x0800, 8);
        record.writeUInt16LE(entry.method, 10);
        record.writeUInt16LE(entry.time, 12);
        record.writeUInt16LE(entry.date, 14);
        record.writeUInt32LE(entry.crc, 16);
        record.writeUInt32LE(entry.compressed, 20);
        record.writeUInt32LE(entry.size, 24);
        record.writeUInt16LE(entry.name.length, 28);
        record.writeUInt32LE((0o100644 << 16) >>> 0, 38);
        record.writeUInt32LE(entry.offset, 42);
        await this.write(record);
        await this.write(entry.name);
      }
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(this.entries.length, 8);
      end.writeUInt16LE(this.entries.length, 10);
      end.writeUInt32LE(this.offset - start, 12);
      end.writeUInt32LE(start, 16);
      await this.write(end);
    } finally {
      await this.handle.close();
    }
  }

  /** Gives up: closes the file (the caller removes it). */
  async abandon(): Promise<void> {
    await this.handle.close().catch(() => undefined);
  }
}

export type LeftOut = { path: string; reason: string };
export type ZippedFolder = { files: number; size: number; leftOut: LeftOut[] };

const plainName = (name: string) => name.toLowerCase().replace(/[. ]+$/, "");

/**
 * Zips the folder `root` into a new file `out`: every file in it, as `<prefix>/<path>`, checked as a
 * shared file is (`readEvidenceFile`) and text redacted. Links, other special files, dependency and
 * cache folders and whatever the floor refuses are left out, with why. Refused as a whole when nothing
 * is left, or when it would pass `maxBytes`, `MAX_ZIP_ENTRIES` files or `MAX_ZIP_INPUT_BYTES`.
 */
export async function zipFolder(root: string, out: string, options: { prefix: string; secrets: readonly string[]; maxBytes: number; home?: string }): Promise<ZippedFolder> {
  const zip = await ZipWriter.create(out, options.maxBytes);
  const leftOut: LeftOut[] = [];
  let read = 0;
  try {
    const walk = async (dir: string, rel: string): Promise<void> => {
      const names = (await readdir(dir)).sort((a, b) => a.localeCompare(b));
      for (const name of names) {
        const path = rel ? `${rel}/${name}` : name;
        const full = join(dir, name);
        const info = await lstat(full).catch(() => null);
        if (!info) continue;
        const refused = refusedPath(path) ?? credentialPathReason(path);
        if (refused) {
          leftOut.push({ path, reason: refused });
          continue;
        }
        if (info.isSymbolicLink()) {
          leftOut.push({ path, reason: "a link (only the files themselves are zipped)" });
          continue;
        }
        if (info.isDirectory()) {
          if (LEFT_OUT_FOLDERS.has(plainName(name))) {
            leftOut.push({ path, reason: "dependencies or caches" });
            continue;
          }
          await walk(full, path);
          continue;
        }
        if (!info.isFile()) {
          leftOut.push({ path, reason: "not a regular file" });
          continue;
        }
        if (LEFT_OUT_FILES.has(plainName(name))) continue;
        if (zip.count >= MAX_ZIP_ENTRIES) throw new ZipTooLarge(`It holds more than ${MAX_ZIP_ENTRIES.toLocaleString("en")} files.`);
        read += info.size;
        if (read > MAX_ZIP_INPUT_BYTES) throw new ZipTooLarge(`Its files add up to more than ${MAX_ZIP_INPUT_BYTES / 1024 / 1024 / 1024} GB.`);
        let checked;
        try {
          checked = await readEvidenceFile(full, { kind: "file", secrets: options.secrets, home: options.home, limit: options.maxBytes });
        } catch (error) {
          if (!(error instanceof GuardError)) throw error;
          leftOut.push({ path, reason: error.message.replace(full, path) });
          continue;
        }
        const bytes = isTextMime(checked.mime) ? Buffer.from(redactText(checked.bytes.toString("utf8")), "utf8") : checked.bytes;
        await zip.add(`${options.prefix}/${path}`, bytes, info.mtime);
      }
    };
    await walk(root, "");
    if (!zip.count) throw new GuardError(`Nothing in it could be shared${leftOut.length ? `: ${describeLeftOut(leftOut)}` : " (it is empty)"}.`);
    await zip.finish();
    return { files: zip.count, size: zip.bytes, leftOut };
  } catch (error) {
    await zip.abandon();
    await rm(out, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** "node_modules (dependencies or caches); .env (Key, … are never attached.)": at most `max`, then how many more. */
export function describeLeftOut(items: readonly LeftOut[], max = 8): string {
  const shown = items.slice(0, max).map((item) => `${item.path} (${item.reason.replace(/\.$/, "")})`);
  return items.length > max ? `${shown.join("; ")}; and ${items.length - max} more` : shown.join("; ");
}

/** The name a zipped folder gets: its own name and `.zip`. */
export function zipNameFor(folderName: string): string {
  const name = evidenceName(folderName).replace(/\.zip$/i, "");
  return `${name === "evidence" ? "folder" : name}.zip`;
}

// ── archives already on disk ────────────────────────────────────────────────

type ZipEntry = { name: string; method: number; flags: number; compressed: number; size: number; offset: number };

/** The entries of a ZIP file (its central directory), or null when it cannot be read that way. */
export function zipEntries(bytes: Uint8Array): ZipEntry[] | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const from = Math.max(0, buffer.length - 22 - 0xffff);
  let end = -1;
  for (let index = buffer.length - 22; index >= from; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      end = index;
      break;
    }
  }
  if (end < 0) return null;
  const count = buffer.readUInt16LE(end + 10);
  const start = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || start === 0xffffffff || start >= buffer.length) return null;
  const entries: ZipEntry[] = [];
  let at = start;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) return null;
    const nameLength = buffer.readUInt16LE(at + 28);
    const extra = buffer.readUInt16LE(at + 30);
    const comment = buffer.readUInt16LE(at + 32);
    if (at + 46 + nameLength > buffer.length) return null;
    entries.push({
      name: buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8"),
      flags: buffer.readUInt16LE(at + 8),
      method: buffer.readUInt16LE(at + 10),
      compressed: buffer.readUInt32LE(at + 20),
      size: buffer.readUInt32LE(at + 24),
      offset: buffer.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + extra + comment;
  }
  return entries;
}

/** One entry's bytes, when it is stored or deflated, not encrypted, and fits what is left to read. */
function zipEntryBytes(buffer: Buffer, entry: ZipEntry, budget: number): Buffer | null {
  if (entry.flags & 1 || (entry.method !== 0 && entry.method !== 8) || entry.size > budget) return null;
  const at = entry.offset;
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== 0x04034b50) return null;
  const start = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28);
  const data = buffer.subarray(start, start + entry.compressed);
  try {
    return entry.method === 0 ? data : zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) });
  } catch {
    return null;
  }
}

/** The entry names of a tar archive (ustar, and GNU long names), or null when it cannot be read. */
export function tarEntries(bytes: Uint8Array): string[] | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const names: string[] = [];
  let at = 0;
  let longName: string | null = null;
  const field = (from: number, length: number) => buffer.subarray(from, from + length).toString("utf8").replace(/\0[\s\S]*$/, "");
  while (at + 512 <= buffer.length) {
    const header = buffer.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = parseInt(field(at + 124, 12).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) return null;
    const type = String.fromCharCode(header[156]!);
    const data = at + 512;
    if (type === "L") {
      longName = buffer.subarray(data, data + size).toString("utf8").replace(/\0[\s\S]*$/, "");
    } else if (type !== "x" && type !== "g") {
      // POSIX ustar keeps the start of a long path apart; old GNU tar uses those bytes for other things.
      const prefix = buffer.toString("latin1", at + 257, at + 263) === "ustar\u0000" ? field(at + 345, 155) : "";
      names.push(longName ?? (prefix ? `${prefix}/${field(at, 100)}` : field(at, 100)));
      longName = null;
    }
    at = data + Math.ceil(size / 512) * 512;
  }
  return names;
}

const isTar = (bytes: Uint8Array) => bytes.length >= 512 && Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1", 257, 262) === "ustar";

/**
 * Why an archive already on disk is not shared, or null: an entry the name rules refuse (a key, `.env`,
 * a shell history, git's or a key folder's files), or a saved secret value in what it holds, as far as
 * `ARCHIVE_SCAN_BYTES` of it. Files of other types, and archives it cannot read, give null.
 */
export function archiveProblem(bytes: Uint8Array, mime: string, secrets: readonly string[]): string | null {
  const values = secrets.filter((secret) => secret.length >= 6).map((secret) => Buffer.from(secret));
  const holds = (data: Uint8Array) => values.some((value) => Buffer.from(data.buffer, data.byteOffset, data.byteLength).includes(value));
  const badName = (names: readonly string[]) => {
    for (const name of names) {
      const reason = credentialPathReason(name) ?? (/(^|\/)\.git(\/|$)/i.test(name) ? "Git's own files are never attached." : null);
      if (reason) return `It holds ${name}: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`;
    }
    return null;
  };
  if (mime === "application/zip" || (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)) {
    const entries = zipEntries(bytes);
    if (!entries) return null;
    const named = badName(entries.map((entry) => entry.name));
    if (named || !values.length) return named;
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let budget = ARCHIVE_SCAN_BYTES;
    for (const entry of entries) {
      const data = zipEntryBytes(buffer, entry, budget);
      if (!data) continue;
      budget -= data.length;
      if (holds(data)) return `It holds the value of a saved secret (in ${entry.name}).`;
    }
    return null;
  }
  let tar: Uint8Array | null = isTar(bytes) ? bytes : null;
  if (!tar && mime === "application/gzip") {
    try {
      const inner = zlib.gunzipSync(bytes, { maxOutputLength: ARCHIVE_SCAN_BYTES });
      if (holds(inner)) return "It holds the value of a saved secret.";
      tar = isTar(inner) ? inner : null;
    } catch {
      return null;
    }
  }
  if (!tar) return null;
  const named = badName(tarEntries(tar) ?? []);
  if (named) return named;
  return holds(tar) ? "It holds the value of a saved secret." : null;
}
