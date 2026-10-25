/**
 * Images in pages: the one size limit, the formats a page shows, the node's attributes, and a
 * header reader that needs no image library. The editor checks a file with it before sending,
 * and hub-api checks every page-image upload with it again (`files/page-image.ts`).
 * Docs: docs/32_FILES.md §6.
 */
import { fileExtension } from "./files.js";

/** Largest image a page takes: 2 MiB (2,097,152 bytes). Larger images are refused, never compressed. */
export const PAGE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** How messages write the limit. */
export const PAGE_IMAGE_MAX_LABEL = "2 MB";
/** A small file can still describe an enormous picture, which a browser would have to decode. */
export const PAGE_IMAGE_MAX_SIDE = 16_384;
export const PAGE_IMAGE_MAX_PIXELS = 40_000_000;
/** Width on the page, as a percentage of the page column. */
export const PAGE_IMAGE_MIN_WIDTH = 10;
export const PAGE_IMAGE_MAX_WIDTH = 100;

export type PageImageFormat = "png" | "jpeg" | "gif" | "webp";
export type PageImageAlign = "left" | "center" | "right";

export const PAGE_IMAGE_TYPES: Readonly<Record<PageImageFormat, { mime: string; exts: readonly string[]; label: string }>> = {
  png: { mime: "image/png", exts: ["png"], label: "PNG" },
  jpeg: { mime: "image/jpeg", exts: ["jpg", "jpeg"], label: "JPEG" },
  gif: { mime: "image/gif", exts: ["gif"], label: "GIF" },
  webp: { mime: "image/webp", exts: ["webp"], label: "WebP" },
};

/** For a file input's `accept`. */
export const PAGE_IMAGE_ACCEPT = Object.values(PAGE_IMAGE_TYPES)
  .map((type) => type.mime)
  .join(",");

const PAGE_IMAGE_MIMES = new Set(Object.values(PAGE_IMAGE_TYPES).map((type) => type.mime));
const MIME_ALIASES: Record<string, string> = { "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg", "image/x-png": "image/png" };

/** Whether a media type is one a page shows as an image. */
export function isPageImageType(mediaType: string | null | undefined): boolean {
  const type = (mediaType ?? "").split(";")[0]!.trim().toLowerCase();
  return PAGE_IMAGE_MIMES.has(MIME_ALIASES[type] ?? type);
}

/** A stored width: a whole percentage from 10 to 100, or null for the image's own size (capped to the column). */
export function pageImageWidth(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value.trim().replace(/%$/, "")) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number <= 0) return null;
  return Math.round(Math.min(PAGE_IMAGE_MAX_WIDTH, Math.max(PAGE_IMAGE_MIN_WIDTH, number)));
}

export function pageImageAlign(value: unknown): PageImageAlign {
  return value === "left" || value === "right" ? value : "center";
}

/** A stored pixel size (`naturalWidth`, `naturalHeight`), or null. */
export function pageImageSide(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) && number > 0 && number <= PAGE_IMAGE_MAX_SIDE ? number : null;
}

const ATTACH = "attach it as a file with /file";

function sizeText(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 2.05) return "just over 2 MB";
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** The refusal for an image over the limit, on the client and the server alike. */
export function pageImageTooLarge(name: string, bytes: number): string {
  return `${name} is ${sizeText(bytes)}. Images in pages can be up to ${PAGE_IMAGE_MAX_LABEL}: make it smaller, or ${ATTACH}.`;
}

export function pageImageSvg(name: string): string {
  return `${name} is an SVG. SVG files can carry scripts, so pages don't show them as images: export it as PNG, or ${ATTACH}.`;
}

export function pageImageUnsupported(name: string): string {
  return `${name} isn't a PNG, JPEG, GIF or WebP image. Export it as one of those, or ${ATTACH}.`;
}

export function pageImageDamaged(name: string): string {
  return `${name} looks damaged: its image data can't be read. Export or save it again, then add it.`;
}

/** Kinds the sniffer recognises. Only PageImageFormat goes into pages. */
export type SniffedImage = PageImageFormat | "svg" | "avif" | "heic" | "bmp" | "tiff" | "ico";

const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));
const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u24le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
const u32be = (b: Uint8Array, at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const u32le = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

/** What the first bytes say a file is, whatever its name. */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length >= 8 && ascii(bytes, 0, 8) === "\x89PNG\r\n\x1a\n") return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) return "gif";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  if (bytes.length >= 16 && ascii(bytes, 4, 4) === "ftyp") {
    const size = Math.min(u32be(bytes, 0), bytes.length, 256);
    const brands = new Set<string>([ascii(bytes, 8, 4)]);
    for (let at = 16; at + 4 <= size; at += 4) brands.add(ascii(bytes, at, 4));
    if (brands.has("avif") || brands.has("avis")) return "avif";
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].some((brand) => brands.has(brand))) return "heic";
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";
  if (bytes.length >= 4 && (ascii(bytes, 0, 4) === "II*\0" || ascii(bytes, 0, 4) === "MM\0*")) return "tiff";
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return "ico";
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 4096)).replace(/^\uFEFF/, "").trimStart();
  if (head.startsWith("<") && /<svg[\s>]/i.test(head) && !/<html[\s>]/i.test(head)) return "svg";
  return null;
}

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array, from: number, to: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let at = from; at < to; at += 1) crc = crcTable[(crc ^ bytes[at]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

type Size = { width: number; height: number };

/** IHDR first (with a valid checksum), then chunks that fit the file, at least one IDAT, and IEND. */
function pngSize(b: Uint8Array): Size | null {
  let at = 8;
  let size: Size | null = null;
  let data = false;
  while (at + 12 <= b.length) {
    const length = u32be(b, at);
    const type = ascii(b, at + 4, 4);
    const end = at + 12 + length;
    if (length > 0x7fffffff || end > b.length) return null;
    if (!size) {
      if (type !== "IHDR" || length !== 13 || crc32(b, at + 4, at + 8 + length) !== u32be(b, at + 8 + length)) return null;
      size = { width: u32be(b, at + 8), height: u32be(b, at + 12) };
    } else if (type === "IDAT") data = true;
    else if (type === "IEND") return data ? size : null;
    at = end;
  }
  return null;
}

/** EXIF orientation 5 to 8 turns the picture a quarter, so it shows with width and height swapped. */
function exifTurned(b: Uint8Array, start: number, end: number): boolean {
  if (end - start < 8) return false;
  const little = ascii(b, start, 2) === "II";
  if (!little && ascii(b, start, 2) !== "MM") return false;
  const u16 = (at: number) => (little ? u16le(b, at) : u16be(b, at));
  const u32 = (at: number) => (little ? u32le(b, at) : u32be(b, at));
  const ifd = start + u32(start + 4);
  if (ifd + 2 > end) return false;
  const count = u16(ifd);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > end) return false;
    if (u16(entry) === 0x0112) {
      const orientation = u16(entry + 8);
      return orientation >= 5 && orientation <= 8;
    }
  }
  return false;
}

/** Segments that fit the file up to a frame header and the scan, and an end-of-image marker after it. */
function jpegSize(b: Uint8Array): Size | null {
  let at = 2;
  let size: Size | null = null;
  let turned = false;
  while (at < b.length) {
    if (b[at] !== 0xff) return null;
    while (at < b.length && b[at] === 0xff) at += 1;
    if (at >= b.length) return null;
    const marker = b[at++]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || at + 2 > b.length) return null;
    const length = u16be(b, at);
    if (length < 2 || at + length > b.length) return null;
    if (marker === 0xe1 && length >= 16 && ascii(b, at + 2, 6) === "Exif\0\0") turned = exifTurned(b, at + 8, at + length);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 8) return null;
      size = { width: u16be(b, at + 5), height: u16be(b, at + 3) };
    }
    if (marker === 0xda) {
      if (!size) return null;
      let end = -1;
      for (let index = b.length - 2; index >= at + length; index -= 1) {
        if (b[index] === 0xff && b[index + 1] === 0xd9) {
          end = index;
          break;
        }
      }
      if (end < 0) return null;
      return turned ? { width: size.height, height: size.width } : size;
    }
    at += length;
  }
  return null;
}

/** The logical screen, then blocks that fit the file with at least one whole image. */
function gifSize(b: Uint8Array): Size | null {
  if (b.length < 14) return null;
  const size = { width: u16le(b, 6), height: u16le(b, 8) };
  let at = 13;
  if (b[10]! & 0x80) at += 3 * (1 << ((b[10]! & 7) + 1));
  let images = 0;
  const subBlocks = (): boolean => {
    while (at < b.length) {
      const length = b[at++]!;
      if (length === 0) return true;
      at += length;
    }
    return false;
  };
  while (at < b.length) {
    const block = b[at++]!;
    if (block === 0x3b) break;
    if (block === 0x21) {
      at += 1;
      if (!subBlocks()) return null;
      continue;
    }
    if (block !== 0x2c || at + 9 > b.length) return null;
    const local = b[at + 8]!;
    at += 9;
    if (local & 0x80) at += 3 * (1 << ((local & 7) + 1));
    at += 1;
    if (at > b.length || !subBlocks()) return null;
    images += 1;
  }
  return images ? size : null;
}

/** The RIFF container whole, and the size from its first VP8, VP8L or VP8X chunk. */
function webpSize(b: Uint8Array): Size | null {
  if (b.length < 25) return null;
  const end = u32le(b, 4) + 8;
  if (end > b.length || end < 25) return null;
  const type = ascii(b, 12, 4);
  const length = u32le(b, 16);
  const data = 20;
  if (data + length > end) return null;
  if (type === "VP8 ") {
    if (length < 10 || b[data + 3] !== 0x9d || b[data + 4] !== 0x01 || b[data + 5] !== 0x2a) return null;
    return { width: u16le(b, data + 6) & 0x3fff, height: u16le(b, data + 8) & 0x3fff };
  }
  if (type === "VP8L") {
    if (length < 5 || b[data] !== 0x2f) return null;
    const bits = u32le(b, data + 1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (type !== "VP8X" || length < 10) return null;
  let at = data + length + (length & 1);
  let image = false;
  while (at + 8 <= end) {
    const chunk = ascii(b, at, 4);
    const size = u32le(b, at + 4);
    if (at + 8 + size > end) return null;
    if (chunk === "VP8 " || chunk === "VP8L" || chunk === "ANMF") image = true;
    at += 8 + size + (size & 1);
  }
  return image ? { width: u24le(b, data + 4) + 1, height: u24le(b, data + 7) + 1 } : null;
}

export type ImageHeader = { format: PageImageFormat; width: number; height: number };

/**
 * The format and the size the picture shows at, read from the file's own structure; null when the
 * bytes are not a whole PNG, JPEG, GIF or WebP. Pixel data is not decoded.
 */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  const format = sniffImage(bytes);
  const size =
    format === "png" ? pngSize(bytes) : format === "jpeg" ? jpegSize(bytes) : format === "gif" ? gifSize(bytes) : format === "webp" ? webpSize(bytes) : null;
  return size && format ? { format: format as PageImageFormat, ...size } : null;
}

export type PageImageCheck =
  | { ok: true; format: PageImageFormat; width: number; height: number; mime: string; filename: string }
  | { ok: false; status: 400 | 413 | 415; message: string };

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico", "heic", "heif", "tif", "tiff"]);

/**
 * Everything a page image must be: at most 2 MiB, a whole PNG, JPEG, GIF or WebP by its content,
 * with a real size within the decoding limits. `strict` (the server) refuses a name or media type
 * that says another image format; otherwise (the editor, before sending) the name is corrected.
 * A name without an image extension gets the format's own.
 */
export function checkPageImage(input: { filename: string; bytes: Uint8Array; mediaType?: string | null; strict?: boolean }): PageImageCheck {
  const name = input.filename.trim() || "image";
  const { bytes } = input;
  if (!bytes.length) return { ok: false, status: 400, message: `${name} is empty.` };
  if (bytes.length > PAGE_IMAGE_MAX_BYTES) return { ok: false, status: 413, message: pageImageTooLarge(name, bytes.length) };
  const claimedType = (input.mediaType ?? "").split(";")[0]!.trim().toLowerCase();
  const ext = fileExtension(name);
  const sniffed = sniffImage(bytes);
  if (sniffed === "svg" || (!sniffed && (ext === "svg" || claimedType === "image/svg+xml"))) return { ok: false, status: 415, message: pageImageSvg(name) };
  if (!sniffed) {
    const claimsImage = IMAGE_EXTS.has(ext) || claimedType.startsWith("image/");
    return claimsImage ? { ok: false, status: 400, message: pageImageDamaged(name) } : { ok: false, status: 415, message: pageImageUnsupported(name) };
  }
  if (!(sniffed in PAGE_IMAGE_TYPES)) return { ok: false, status: 415, message: pageImageUnsupported(name) };
  const header = readImageHeader(bytes);
  if (!header) return { ok: false, status: 400, message: pageImageDamaged(name) };
  const { format, width, height } = header;
  if (!width || !height) return { ok: false, status: 400, message: `${name} has no width or height. Export or save it again, then add it.` };
  if (width > PAGE_IMAGE_MAX_SIDE || height > PAGE_IMAGE_MAX_SIDE || width * height > PAGE_IMAGE_MAX_PIXELS) {
    return {
      ok: false,
      status: 413,
      message: `${name} is ${width.toLocaleString("en-US")} × ${height.toLocaleString("en-US")} pixels. Images in pages can be up to ${PAGE_IMAGE_MAX_SIDE.toLocaleString("en-US")} pixels a side and 40 megapixels: make it smaller, or ${ATTACH}.`,
    };
  }
  const type = PAGE_IMAGE_TYPES[format];
  const namedOther = IMAGE_EXTS.has(ext) && !type.exts.includes(ext);
  const typedOther = claimedType.startsWith("image/") && (MIME_ALIASES[claimedType] ?? claimedType) !== type.mime;
  if (input.strict && (namedOther || typedOther)) {
    const said = namedOther ? `is named .${ext}` : `was sent as ${claimedType}`;
    return { ok: false, status: 415, message: `${name} ${said} but holds a ${type.label} image. Rename it to .${type.exts[0]} and add it again.` };
  }
  const base = IMAGE_EXTS.has(ext) ? name.slice(0, -(ext.length + 1)) : name;
  const filename = type.exts.includes(ext) ? name : `${base || "image"}.${type.exts[0]}`;
  return { ok: true, format, width, height, mime: type.mime, filename };
}

/** Before reading a file: its size and what its name and type say. Null when it may be a page image. */
export function pageImageFileProblem(file: { name: string; size: number; type?: string }): string | null {
  const name = file.name.trim() || "image";
  if (file.size > PAGE_IMAGE_MAX_BYTES) return pageImageTooLarge(name, file.size);
  if (!file.size) return `${name} is empty.`;
  const ext = fileExtension(name);
  const type = (file.type ?? "").toLowerCase();
  if (ext === "svg" || type === "image/svg+xml") return pageImageSvg(name);
  if (isPageImageType(type) || ["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return null;
  return pageImageUnsupported(name);
}

/** Whether a dropped or pasted file should become an image in the page rather than a file card. */
export function looksLikePageImage(file: { name: string; type?: string }): boolean {
  const type = (file.type ?? "").toLowerCase();
  return isPageImageType(type) || (!type && ["png", "jpg", "jpeg", "gif", "webp"].includes(fileExtension(file.name)));
}

/** The decoded size of a `data:` URL, without decoding it; null when `src` is not one. */
export function dataUrlBytes(src: string): number | null {
  if (!/^data:/i.test(src)) return null;
  const comma = src.indexOf(",");
  if (comma < 0) return 0;
  const meta = src.slice(5, comma);
  const length = src.length - comma - 1;
  if (/;base64$/i.test(meta)) {
    let padding = 0;
    for (let at = src.length - 1; at > comma && padding < 2 && src[at] === "="; at -= 1) padding += 1;
    return Math.max(0, Math.floor((length * 3) / 4) - padding);
  }
  let escapes = 0;
  for (let at = comma + 1; at < src.length; at += 1) if (src.charCodeAt(at) === 37) escapes += 1;
  return length - escapes * 2;
}
