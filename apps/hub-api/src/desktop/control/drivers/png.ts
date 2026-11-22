/**
 * Just enough PNG for the macOS driver's screenshots (8-bit grey, RGB, palette or RGBA, not interlaced): decode
 * to RGBA, crop, shrink by averaging, encode, and a hash of the pixels to tell whether the screen changed.
 */
import { deflateSync, inflateSync } from "node:zlib";

export type Pixels = { width: number; height: number; data: Buffer };

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(SIGNATURE) || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(bytes: Buffer): Pixels {
  const size = pngSize(bytes);
  if (!size) throw new Error("Not a PNG image.");
  const { width, height } = size;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  const parts: Buffer[] = [];
  for (let offset = 8; offset + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      bitDepth = body[8]!;
      colorType = body[9]!;
      interlace = body[12]!;
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") transparency = body;
    else if (type === "IDAT") parts.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const channels = CHANNELS[colorType];
  if (bitDepth !== 8 || interlace !== 0 || !channels || (colorType === 3 && !palette)) throw new Error(`This PNG is not supported (bit depth ${bitDepth}, colour type ${colorType}).`);
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error("The PNG image is cut short.");
  const out = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const filter = raw[start]!;
    const line = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? line[i - channels]! : 0;
      const up = previous[i]!;
      const corner = i >= channels ? previous[i - channels]! : 0;
      const add = filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : filter === 4 ? paeth(left, up, corner) : 0;
      line[i] = (line[i]! + add) & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const from = x * channels;
      if (colorType === 6) line.copy(out, at, from, from + 4);
      else if (colorType === 2) {
        out[at] = line[from]!;
        out[at + 1] = line[from + 1]!;
        out[at + 2] = line[from + 2]!;
        out[at + 3] = 255;
      } else if (colorType === 3) {
        const index = line[from]!;
        out[at] = palette![index * 3] ?? 0;
        out[at + 1] = palette![index * 3 + 1] ?? 0;
        out[at + 2] = palette![index * 3 + 2] ?? 0;
        out[at + 3] = transparency?.[index] ?? 255;
      } else {
        const grey = line[from]!;
        out[at] = grey;
        out[at + 1] = grey;
        out[at + 2] = grey;
        out[at + 3] = colorType === 4 ? line[from + 1]! : 255;
      }
    }
    previous = line;
  }
  return { width, height, data: out };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(parts: Buffer[]): number {
  let crc = 0xffffffff;
  for (const part of parts) for (const byte of part) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32([head.subarray(4), body]), 0);
  return Buffer.concat([head, body, tail]);
}

/** RGB when every pixel is opaque, else RGBA; each row with the Sub filter. */
export function encodePng(image: Pixels): Buffer {
  const { width, height, data } = image;
  let opaque = true;
  for (let i = 3; i < data.length && opaque; i += 4) if (data[i] !== 255) opaque = false;
  const channels = opaque ? 3 : 4;
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  const line = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = (y * width + x) * 4;
      const to = x * channels;
      line[to] = data[from]!;
      line[to + 1] = data[from + 1]!;
      line[to + 2] = data[from + 2]!;
      if (!opaque) line[to + 3] = data[from + 3]!;
    }
    const start = y * (stride + 1);
    raw[start] = 1;
    for (let i = 0; i < stride; i += 1) raw[start + 1 + i] = (line[i]! - (i >= channels ? line[i - channels]! : 0)) & 0xff;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = opaque ? 2 : 6;
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

/** The part of `image` inside the rectangle, clamped to the image (at least one pixel). */
export function cropPixels(image: Pixels, rect: { x: number; y: number; width: number; height: number }): Pixels {
  const x = Math.min(Math.max(0, Math.floor(rect.x)), image.width - 1);
  const y = Math.min(Math.max(0, Math.floor(rect.y)), image.height - 1);
  const width = Math.max(1, Math.min(image.width - x, Math.round(rect.width)));
  const height = Math.max(1, Math.min(image.height - y, Math.round(rect.height)));
  const data = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row += 1) image.data.copy(data, row * width * 4, ((y + row) * image.width + x) * 4, ((y + row) * image.width + x + width) * 4);
  return { width, height, data };
}

/** `image` at `width` × `height`, each pixel the average of the ones it covers (only ever smaller). */
export function shrinkPixels(image: Pixels, width: number, height: number): Pixels {
  if (width >= image.width && height >= image.height) return image;
  const data = Buffer.alloc(width * height * 4);
  for (let ty = 0; ty < height; ty += 1) {
    const y0 = Math.floor((ty * image.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * image.height) / height));
    for (let tx = 0; tx < width; tx += 1) {
      const x0 = Math.floor((tx * image.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * image.width) / width));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const at = (y * image.width + x) * 4;
          r += image.data[at]!;
          g += image.data[at + 1]!;
          b += image.data[at + 2]!;
          a += image.data[at + 3]!;
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const at = (ty * width + tx) * 4;
      data[at] = Math.round(r / count);
      data[at + 1] = Math.round(g / count);
      data[at + 2] = Math.round(b / count);
      data[at + 3] = Math.round(a / count);
    }
  }
  return { width, height, data };
}

/** FNV-1a over the bytes: equal images, equal hashes. */
export function hashBytes(bytes: Buffer): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash >>> 0;
}
