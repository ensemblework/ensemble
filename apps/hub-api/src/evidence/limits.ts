/**
 * The rules every attached file meets, on the computer and again on the server (docs/32 §7): which
 * names are never attached (keys, certificates, `.env` files, shell histories), how large a file may
 * be, and what a file really is, sniffed from its bytes rather than taken from its name. Active formats
 * (HTML, SVG, XML, JavaScript) are served only as downloads, inside a sandbox.
 */
import { createHash } from "node:crypto";
import type { EvidenceKind } from "../remote/contract.js";

const MB = 1024 * 1024;

/** The largest file of any kind: what a node shares (a zipped folder too) and what a run attaches. */
export const EVIDENCE_MAX_BYTES = 100 * MB;

/** One cap for every kind: a picture, a report, a video, an archive. */
export function evidenceLimit(_kind: EvidenceKind): number {
  return EVIDENCE_MAX_BYTES;
}

/** The most files one run attaches: a brake on a looping agent, not on real work. */
export const MAX_EVIDENCE_PER_JOB = 100;

/** A node's own tool operation lasts as long as the node: the same brake counts only what it made in the last day. */
export const NODE_EVIDENCE_WINDOW_MS = 86_400_000;

/** Folders of keys and sign-ins, and git's own: nothing under them is attached. */
const CREDENTIAL_FOLDERS = new Set([".git", ".ssh", ".aws", ".kube", ".gnupg", ".docker", ".azure", ".gcloud", ".password-store", ".terraform.d"]);

/** Keys, certificates, `.env` files and credential stores, by name. */
const CREDENTIAL_NAME =
  /^(?:\.env.*|.+\.env|\.envrc|.+\.(?:pem|key|crt|cer|der|p8|p12|pfx|keystore|jks|kdbx|ovpn|tfvars|tfstate|tfstate\.backup|gpg)|id_(?:rsa|dsa|ecdsa|ed25519).*|.+_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.npmrc|\.netrc|\.pypirc|\.pgpass|\.htpasswd|\.dev\.vars|\.git-credentials|kubeconfig|credentials(?:\.json)?|secrets?\.(?:ya?ml|json|toml)|authorized_keys|known_hosts)$/i;

/** Shell and tool histories: they hold what was typed, passwords included. */
const HISTORY_NAME = /^(?:\.[\w.-]*history|[\w.-]*_history|fish_history|\.lesshst|consolehost_history\.txt)$/i;

/** A name as a case-insensitive disk matches it, without the trailing dots and spaces Windows drops. */
function plain(part: string): string {
  return part.replace(/[. ]+$/, (tail) => (tail === part ? tail : "")).toLowerCase();
}

/**
 * Why a file at this path is never attached, judged by its names alone: its own name and every
 * folder on its way (`.ssh/notes.txt` is refused like `id_ed25519`). Null when the names are fine.
 */
export function credentialPathReason(path: string): string | null {
  const parts = path.split(/[\\/]+/).filter(Boolean).map(plain);
  const name = parts[parts.length - 1] ?? "";
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (CREDENTIAL_FOLDERS.has(parts[index]!) || (parts[index] === ".config" && ["gh", "gcloud", "hub"].includes(parts[index + 1] ?? ""))) {
      return "Files in folders of keys, sign-ins or git's own files are never attached.";
    }
  }
  if (CREDENTIAL_NAME.test(name)) return "Key, certificate, credential and .env files are never attached.";
  if (HISTORY_NAME.test(name)) return "Shell histories are never attached: they hold what was typed.";
  return null;
}

/** A file's name as it is kept and shown: no folders, no control characters, at most 200 characters. */
export function evidenceName(input: string): string {
  const parts = input.split(/[\\/]+/).filter(Boolean);
  const name = (parts[parts.length - 1] ?? "")
    .replace(/[\u0000-\u001f\u007f"<>|*?:]/g, "_")
    .trim();
  const cut = name.length > 200 ? `${name.slice(0, 160)}…${name.slice(-39)}` : name;
  return cut && cut !== "." && cut !== ".." ? cut : "evidence";
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const startsWith = (bytes: Uint8Array, ...signature: number[]) => bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
const ascii = (bytes: Uint8Array, from: number, to: number) => Buffer.from(bytes.subarray(from, Math.min(to, bytes.length))).toString("latin1");

/** A head cut in the middle of a multi-byte character, without that last partial character. */
function trimPartial(head: Uint8Array): Uint8Array {
  for (let back = 1; back <= 3 && head.length - back >= 0; back += 1) {
    const byte = head[head.length - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const need = (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : (byte & 0xf8) === 0xf0 ? 4 : 1;
    return need > back ? head.subarray(0, head.length - back) : head;
  }
  return head;
}

/** Bytes that read as UTF-8 text: no NUL in the first 8 KB, and no invalid sequence there. */
function looksLikeText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head.length < bytes.length ? trimPartial(head) : head);
    return true;
  } catch {
    return false;
  }
}

function parsesAsJson(bytes: Uint8Array): boolean {
  if (bytes.length > 20 * MB) return false;
  try {
    JSON.parse(Buffer.from(bytes).toString("utf8"));
    return true;
  } catch {
    return false;
  }
}

const extensionOf = (name: string) => /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() ?? "";

/** Formats that are ZIP files inside: their own type by name, else `application/zip`. */
const ZIPPED_FORMATS: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  epub: "application/epub+zip",
  jar: "application/java-archive",
};

/** The older Office formats (one compound file each), by name. */
const COMPOUND_FORMATS: Record<string, string> = { doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint", msg: "application/vnd.ms-outlook" };

/**
 * What a file is, from its first bytes. Text is told apart by its first markup (HTML, SVG, XML) or by
 * parsing as JSON; a name only chooses among plain text types (a `.js` name makes it active), among
 * the formats that are ZIP files inside (`.docx`, `.xlsx`, `.pptx`, …) and among the older Office ones.
 */
export function sniffMime(bytes: Uint8Array, name = ""): string {
  if (startsWith(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (startsWith(bytes, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (ascii(bytes, 0, 2) === "BM" && bytes.length > 26 && !looksLikeText(bytes)) return "image/bmp";
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12).toLowerCase();
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand === "heic" || brand === "heix" || brand === "mif1") return "image/heic";
    if (brand === "qt  ") return "video/quicktime";
    if (brand === "m4a " || brand === "m4b ") return "audio/mp4";
    return "video/mp4";
  }
  if (startsWith(bytes, 0x1a, 0x45, 0xdf, 0xa3)) return ascii(bytes, 0, 64).includes("webm") ? "video/webm" : "video/x-matroska";
  if (ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";
  if (startsWith(bytes, 0x50, 0x4b, 0x03, 0x04) || startsWith(bytes, 0x50, 0x4b, 0x05, 0x06)) return ZIPPED_FORMATS[extensionOf(name)] ?? "application/zip";
  if (startsWith(bytes, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return COMPOUND_FORMATS[extensionOf(name)] ?? "application/octet-stream";
  if (startsWith(bytes, 0x1f, 0x8b)) return "application/gzip";
  if (startsWith(bytes, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return "application/x-7z-compressed";
  if (ascii(bytes, 0, 6) === "Rar!\x1a\x07") return "application/vnd.rar";
  if (startsWith(bytes, 0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return "application/x-xz";
  if (startsWith(bytes, 0x28, 0xb5, 0x2f, 0xfd)) return "application/zstd";
  if (ascii(bytes, 0, 3) === "BZh" && bytes.length > 4 && bytes[3]! >= 0x31 && bytes[3]! <= 0x39) return "application/x-bzip2";
  if (bytes.length >= 512 && ascii(bytes, 257, 262) === "ustar") return "application/x-tar";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE") return "audio/wav";
  if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(bytes, 0, 4) === "fLaC") return "audio/flac";
  // An MP3 starts with its tags, or (untagged) with a frame's sync bits, which only its name tells from other bytes.
  if (ascii(bytes, 0, 3) === "ID3" || (extensionOf(name) === "mp3" && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return "audio/mpeg";
  if (!looksLikeText(bytes)) return "application/octet-stream";
  const text = Buffer.from(bytes.subarray(0, 4096)).toString("utf8").replace(/^\uFEFF/, "");
  const start = text.trimStart().slice(0, 1024).toLowerCase();
  if (start.startsWith("<!doctype html") || start.startsWith("<html") || /^<(?:head|body|script|iframe|meta|style|link|object|embed)\b/.test(start)) return "text/html";
  if (start.startsWith("<svg") || start.startsWith("<!doctype svg") || (start.startsWith("<?xml") && start.includes("<svg"))) return "image/svg+xml";
  if (start.startsWith("<?xml")) return "application/xml";
  // Markup that runs anywhere in the head of a "text" file: served as active either way.
  if (/<(?:script|iframe|object|embed)\b/i.test(text)) return "text/html";
  const lower = name.toLowerCase();
  if (/\.(?:m?js|cjs|jsx|ts|tsx|html?|svg|xml|xhtml)$/.test(lower)) return /\.(?:html?|xhtml)$/.test(lower) ? "text/html" : /\.svg$/.test(lower) ? "image/svg+xml" : /\.xml$/.test(lower) ? "application/xml" : "text/javascript";
  if ((start.startsWith("{") || start.startsWith("[")) && parsesAsJson(bytes)) return "application/json";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".css")) return "text/css";
  return "text/plain";
}

/** Formats a browser runs: served only as a download, or in a sandbox with nothing allowed. */
const ACTIVE = new Set(["text/html", "image/svg+xml", "application/xml", "text/xml", "application/xhtml+xml", "text/javascript", "application/javascript"]);

export function isActiveMime(mime: string): boolean {
  return ACTIVE.has(mime);
}

/** Text that is redacted before it is kept or sent (lib/redact.ts). */
export function isTextMime(mime: string): boolean {
  return mime.startsWith("text/") || mime === "application/json" || mime === "application/xml" || mime === "image/svg+xml" || mime === "application/javascript";
}

/** Why the bytes do not fit the kind the worker named (a "screenshot" that is a zip), or null. */
export function kindMismatch(kind: EvidenceKind, mime: string): string | null {
  if (kind === "screenshot" || kind === "image") return mime.startsWith("image/") ? null : `A ${kind} must be an image; this is ${mime}. Attach it as a file instead.`;
  if (kind === "video") return mime.startsWith("video/") || mime === "image/gif" ? null : `A video must be MP4, WebM or QuickTime; this is ${mime}. Attach it as a file instead.`;
  return null;
}

/** The kind a file found in the run's evidence folder is attached as, from its type. */
export function kindFor(mime: string): EvidenceKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/zip" || mime === "application/gzip") return "trace";
  if (mime === "text/html" || mime === "application/pdf" || mime === "text/markdown") return "report";
  if (mime.startsWith("text/") || mime === "application/json") return "log";
  return "file";
}
