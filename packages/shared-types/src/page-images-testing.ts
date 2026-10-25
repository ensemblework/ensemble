/**
 * Small, structurally whole image files for tests of page images (`page-images.ts`). Pixel data is
 * filler: the header reader checks structure and sizes, not pixels. Not exported from the index.
 */
import { crc32 } from "node:zlib";

const bytes = (...parts: Array<Uint8Array | number[] | string>) => {
  const chunks = parts.map((part) => (typeof part === "string" ? new TextEncoder().encode(part) : part instanceof Uint8Array ? part : Uint8Array.from(part)));
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
};
const be32 = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const le32 = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
const be16 = (value: number) => [(value >>> 8) & 0xff, value & 0xff];
const le16 = (value: number) => [value & 0xff, (value >>> 8) & 0xff];

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = bytes(type, data);
  return bytes(be32(data.length), body, be32(crc32(body) >>> 0));
}

/** A PNG of `width` × `height`; with `total`, padded with a private chunk to exactly that many bytes. */
export function testPng(width = 4, height = 3, total?: number): Uint8Array {
  const head = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = pngChunk("IHDR", bytes(be32(width), be32(height), [8, 6, 0, 0, 0]));
  const idat = pngChunk("IDAT", bytes([0x78, 0x9c, 0x63, 0x60, 0, 0, 0, 2, 0, 1]));
  const iend = pngChunk("IEND", new Uint8Array());
  const fixed = head.length + ihdr.length + idat.length + iend.length;
  const pad = total === undefined ? null : pngChunk("ensP", new Uint8Array(Math.max(0, total - fixed - 12)));
  return bytes(head, ihdr, idat, ...(pad ? [pad] : []), iend);
}

/** A baseline JPEG; `orientation` adds an EXIF block (6 and 8 show the picture turned a quarter). */
export function testJpeg(width = 4, height = 3, orientation?: number): Uint8Array {
  const exif = orientation
    ? (() => {
        const tiff = bytes("MM", be16(42), be32(8), be16(1), be16(0x0112), be16(3), be32(1), be16(orientation), [0, 0], be32(0));
        return bytes([0xff, 0xe1], be16(2 + 6 + tiff.length), "Exif\0\0", tiff);
      })()
    : new Uint8Array();
  const sof = bytes([0xff, 0xc0], be16(17), [8], be16(height), be16(width), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const sos = bytes([0xff, 0xda], be16(12), [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]);
  return bytes([0xff, 0xd8], exif, sof, sos, [0x12, 0x34, 0x56], [0xff, 0xd9]);
}

export function testGif(width = 4, height = 3): Uint8Array {
  return bytes("GIF89a", le16(width), le16(height), [0x80, 0, 0], [0, 0, 0, 255, 255, 255], [0x2c], le16(0), le16(0), le16(width), le16(height), [0], [2, 2, 0x4c, 0x01, 0], [0x3b]);
}

/** A lossless WebP; `extended` wraps it in a VP8X header as editors with alpha or metadata write. */
export function testWebp(width = 4, height = 3, extended = false): Uint8Array {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const vp8l = bytes("VP8L", le32(6), [0x2f], le32(bits), [0]);
  const vp8x = extended ? bytes("VP8X", le32(10), [0x10, 0, 0, 0], [(width - 1) & 0xff, ((width - 1) >> 8) & 0xff, ((width - 1) >> 16) & 0xff], [(height - 1) & 0xff, ((height - 1) >> 8) & 0xff, ((height - 1) >> 16) & 0xff]) : new Uint8Array();
  const body = bytes("WEBP", vp8x, vp8l);
  return bytes("RIFF", le32(body.length), body);
}
