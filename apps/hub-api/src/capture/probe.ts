/**
 * Reading the images and videos capture produces, with no native tools: image sizes (PNG, JPEG,
 * WebP, GIF), PNG pixels for the blank-image check, and the frames, timestamps and size of a WebM
 * or MP4 file. Playwright's own ffmpeg has no ffprobe, so the media pipeline reads its output here.
 */
import { open, readFile } from "node:fs/promises";
import { createInflate } from "node:zlib";

export type ImageFormat = "png" | "jpeg" | "webp" | "gif";
export type ImageInfo = { format: ImageFormat; mime: string; width: number; height: number };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPng(buf: Uint8Array): boolean {
  return buf.length >= 8 && Buffer.from(buf.subarray(0, 8)).equals(PNG_SIGNATURE);
}

export function isJpeg(buf: Uint8Array): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/** Width and height of an image from its header; null when the format is not one of ours. */
export function imageInfo(buf: Uint8Array): ImageInfo | null {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (isPng(b) && b.length >= 24 && b.toString("latin1", 12, 16) === "IHDR") {
    return { format: "png", mime: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (isJpeg(b)) {
    const size = jpegSize(b);
    return size ? { format: "jpeg", mime: "image/jpeg", ...size } : null;
  }
  if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const chunk = b.toString("latin1", 12, 16);
    if (chunk === "VP8X") return { format: "webp", mime: "image/webp", width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === "VP8L" && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21);
      return { format: "webp", mime: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 ") return { format: "webp", mime: "image/webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    return null;
  }
  if (b.length >= 10 && (b.toString("latin1", 0, 6) === "GIF87a" || b.toString("latin1", 0, 6) === "GIF89a")) {
    return { format: "gif", mime: "image/gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  return null;
}

function jpegSize(b: Buffer): { width: number; height: number } | null {
  let pos = 2;
  while (pos + 9 < b.length) {
    if (b[pos] !== 0xff) return null;
    const marker = b[pos + 1]!;
    if (marker === 0xff) {
      pos += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      pos += 2;
      continue;
    }
    const length = b.readUInt16BE(pos + 2);
    // Start-of-frame markers, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(pos + 5), width: b.readUInt16BE(pos + 7) };
    }
    pos += 2 + length;
  }
  return null;
}

// ── PNG pixels ──────────────────────────────────────────────────────────────

type PngHeader = { width: number; height: number; bitDepth: number; colorType: number; interlace: number };

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function pngChunks(b: Buffer): { header: PngHeader; palette: Buffer | null; alpha: Buffer | null; data: Buffer[] } {
  if (!isPng(b)) throw new Error("Not a PNG image.");
  let pos = 8;
  let header: PngHeader | null = null;
  let palette: Buffer | null = null;
  let alpha: Buffer | null = null;
  const data: Buffer[] = [];
  while (pos + 8 <= b.length) {
    const length = b.readUInt32BE(pos);
    const type = b.toString("latin1", pos + 4, pos + 8);
    const body = b.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), bitDepth: body[8]!, colorType: body[9]!, interlace: body[12]! };
    else if (type === "PLTE") palette = body;
    else if (type === "tRNS") alpha = body;
    else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    pos += 12 + length;
  }
  if (!header) throw new Error("The PNG has no header.");
  if (!(header.colorType in CHANNELS)) throw new Error(`Unsupported PNG colour type ${header.colorType}.`);
  if (header.interlace !== 0) throw new Error("Interlaced PNG images are not supported.");
  return { header, palette, alpha, data };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Calls `onRow` with each row as 8-bit RGBA, top to bottom. The image is inflated as a stream,
 * so a tall full-page screenshot is never held in memory as raw pixels.
 */
export async function forEachPngRow(buf: Uint8Array, onRow: (rgba: Uint8Array, y: number) => void): Promise<{ width: number; height: number }> {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const { header, palette, alpha, data } = pngChunks(b);
  const { width, height, bitDepth, colorType } = header;
  const channels = CHANNELS[colorType]!;
  const bitsPerPixel = channels * bitDepth;
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  let prev = new Uint8Array(rowBytes);
  let cur = new Uint8Array(rowBytes);
  const rgba = new Uint8Array(width * 4);
  let y = 0;
  let filled = -1;
  let filter = 0;

  const emit = () => {
    switch (filter) {
      case 0:
        break;
      case 1:
        for (let i = bpp; i < rowBytes; i += 1) cur[i] = (cur[i]! + cur[i - bpp]!) & 0xff;
        break;
      case 2:
        for (let i = 0; i < rowBytes; i += 1) cur[i] = (cur[i]! + prev[i]!) & 0xff;
        break;
      case 3:
        for (let i = 0; i < rowBytes; i += 1) cur[i] = (cur[i]! + (((i >= bpp ? cur[i - bpp]! : 0) + prev[i]!) >> 1)) & 0xff;
        break;
      case 4:
        for (let i = 0; i < rowBytes; i += 1) cur[i] = (cur[i]! + paeth(i >= bpp ? cur[i - bpp]! : 0, prev[i]!, i >= bpp ? prev[i - bpp]! : 0)) & 0xff;
        break;
      default:
        throw new Error(`Bad PNG filter ${filter} on row ${y}.`);
    }
    toRgba(cur, rgba, width, bitDepth, colorType, palette, alpha);
    onRow(rgba, y);
    const swap = prev;
    prev = cur;
    cur = swap;
    y += 1;
  };

  await new Promise<void>((resolve, reject) => {
    const inflate = createInflate();
    inflate.on("data", (chunk: Buffer) => {
      try {
        let offset = 0;
        while (offset < chunk.length && y < height) {
          if (filled < 0) {
            filter = chunk[offset]!;
            offset += 1;
            filled = 0;
            continue;
          }
          const take = Math.min(rowBytes - filled, chunk.length - offset);
          cur.set(chunk.subarray(offset, offset + take), filled);
          filled += take;
          offset += take;
          if (filled === rowBytes) {
            emit();
            filled = -1;
          }
        }
      } catch (error) {
        inflate.destroy();
        reject(error);
      }
    });
    inflate.on("error", reject);
    inflate.on("end", () => (y === height ? resolve() : reject(new Error(`The PNG ends after ${y} of ${height} rows.`))));
    for (const part of data) inflate.write(part);
    inflate.end();
  });
  return { width, height };
}

function toRgba(row: Uint8Array, out: Uint8Array, width: number, depth: number, type: number, palette: Buffer | null, trns: Buffer | null): void {
  const sample = (index: number): number => {
    if (depth === 8) return row[index]!;
    if (depth === 16) return row[index * 2]!;
    const perByte = 8 / depth;
    const byte = row[Math.floor(index / perByte)]!;
    const shift = 8 - depth * ((index % perByte) + 1);
    const value = (byte >> shift) & ((1 << depth) - 1);
    return type === 3 ? value : Math.round((value * 255) / ((1 << depth) - 1));
  };
  for (let x = 0; x < width; x += 1) {
    const o = x * 4;
    if (type === 0) {
      const g = sample(x);
      out[o] = out[o + 1] = out[o + 2] = g;
      out[o + 3] = 255;
    } else if (type === 2) {
      out[o] = sample(x * 3);
      out[o + 1] = sample(x * 3 + 1);
      out[o + 2] = sample(x * 3 + 2);
      out[o + 3] = 255;
    } else if (type === 3) {
      const index = sample(x);
      out[o] = palette?.[index * 3] ?? 0;
      out[o + 1] = palette?.[index * 3 + 1] ?? 0;
      out[o + 2] = palette?.[index * 3 + 2] ?? 0;
      out[o + 3] = trns && index < trns.length ? trns[index]! : 255;
    } else if (type === 4) {
      const g = sample(x * 2);
      out[o] = out[o + 1] = out[o + 2] = g;
      out[o + 3] = sample(x * 2 + 1);
    } else {
      out[o] = sample(x * 4);
      out[o + 1] = sample(x * 4 + 1);
      out[o + 2] = sample(x * 4 + 2);
      out[o + 3] = sample(x * 4 + 3);
    }
  }
}

export type DecodedImage = { width: number; height: number; data: Uint8Array };

/** The whole PNG as RGBA. Refused above `maxPixels`, which keeps a decode bounded. */
export async function decodePng(buf: Uint8Array, maxPixels = 40_000_000): Promise<DecodedImage> {
  const info = imageInfo(buf);
  if (!info || info.format !== "png") throw new Error("Not a PNG image.");
  if (info.width * info.height > maxPixels) throw new Error(`The image is too large to decode (${info.width}×${info.height}).`);
  const data = new Uint8Array(info.width * info.height * 4);
  await forEachPngRow(buf, (row, y) => data.set(row, y * info.width * 4));
  return { width: info.width, height: info.height, data };
}

export type ImageStats = {
  width: number;
  height: number;
  /** Mean and standard deviation of luminance, 0–255, over the sampled pixels. */
  mean: number;
  stdDev: number;
  /** The most common colour (quantised to 4 bits a channel) and its share of the image. */
  dominant: { hex: string; share: number };
  /** How many quantised colours cover at least 0.1% of the image. */
  colours: number;
  samples: number;
};

/** Luminance spread and colour mix of a PNG, sampled to at most about two million pixels. */
export async function pngStats(buf: Uint8Array): Promise<ImageStats> {
  const info = imageInfo(buf);
  if (!info || info.format !== "png") throw new Error("Not a PNG image.");
  const stride = Math.max(1, Math.floor(Math.sqrt((info.width * info.height) / 2_000_000)));
  const bins = new Map<number, number>();
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  await forEachPngRow(buf, (row, y) => {
    if (y % stride) return;
    for (let x = 0; x < info.width; x += stride) {
      const o = x * 4;
      const a = row[o + 3]! / 255;
      // Transparent pixels count as white, as the image is shown on a light page.
      const r = Math.round(row[o]! * a + 255 * (1 - a));
      const g = Math.round(row[o + 1]! * a + 255 * (1 - a));
      const bl = Math.round(row[o + 2]! * a + 255 * (1 - a));
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      sum += lum;
      sumSq += lum * lum;
      n += 1;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (bl >> 4);
      bins.set(key, (bins.get(key) ?? 0) + 1);
    }
  });
  let topKey = 0;
  let topCount = 0;
  let colours = 0;
  for (const [key, count] of bins) {
    if (count > topCount) {
      topCount = count;
      topKey = key;
    }
    if (count / n >= 0.001) colours += 1;
  }
  const mean = n ? sum / n : 0;
  const channel = (value: number) => ((value << 4) | value).toString(16).padStart(2, "0");
  return {
    width: info.width,
    height: info.height,
    mean,
    stdDev: n ? Math.sqrt(Math.max(0, sumSq / n - mean * mean)) : 0,
    dominant: { hex: `#${channel((topKey >> 8) & 15)}${channel((topKey >> 4) & 15)}${channel(topKey & 15)}`, share: n ? topCount / n : 1 },
    colours,
    samples: n,
  };
}

// ── Video files ─────────────────────────────────────────────────────────────

export type VideoProbe = {
  container: "webm" | "mp4";
  codec: string | null;
  width: number;
  height: number;
  durationMs: number;
  frames: number;
  /** Presentation time of each video frame, in milliseconds, in file order. */
  timestampsMs: number[];
};

type Vint = { value: number; length: number; unknown: boolean };

function readVint(b: Buffer, pos: number, keepMarker: boolean): Vint | null {
  const first = b[pos];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length += 1;
  if (length > 8 || pos + length > b.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i += 1) {
    value = value * 256 + b[pos + i]!;
    if (b[pos + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

const EBML = {
  segment: 0x18538067,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  codecId: 0x86,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  cluster: 0x1f43b675,
  timecode: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
};
const CONTAINERS = new Set([EBML.segment, EBML.info, EBML.tracks, EBML.trackEntry, EBML.video, EBML.cluster, EBML.blockGroup]);

function readUint(b: Buffer, pos: number, size: number): number {
  let value = 0;
  for (let i = 0; i < size; i += 1) value = value * 256 + b[pos + i]!;
  return value;
}

/** Frames, timestamps, size and codec of a WebM (Matroska) file's first video track. */
export function probeWebm(buf: Uint8Array): VideoProbe {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let scale = 1_000_000;
  let duration: number | null = null;
  type Track = { number: number; type: number; codec: string | null; width: number; height: number };
  const tracks: Track[] = [];
  let track: Track | null = null;
  let clusterTime = 0;
  const blocks: Array<{ track: number; time: number }> = [];

  const walk = (start: number, end: number): void => {
    let pos = start;
    while (pos < end) {
      const id = readVint(b, pos, true);
      if (!id) return;
      const size = readVint(b, pos + id.length, false);
      if (!size) return;
      const body = pos + id.length + size.length;
      const bodyEnd = size.unknown ? end : Math.min(end, body + size.value);
      const length = bodyEnd - body;
      if (id.value === EBML.trackEntry) {
        track = { number: 0, type: 0, codec: null, width: 0, height: 0 };
        tracks.push(track);
      }
      if (CONTAINERS.has(id.value)) walk(body, bodyEnd);
      else if (id.value === EBML.timecodeScale) scale = readUint(b, body, length);
      else if (id.value === EBML.duration) duration = length === 4 ? b.readFloatBE(body) : b.readDoubleBE(body);
      else if (id.value === EBML.timecode) clusterTime = readUint(b, body, length);
      else if (id.value === EBML.simpleBlock || id.value === EBML.block) {
        const number = readVint(b, body, false);
        if (number) blocks.push({ track: number.value, time: clusterTime + b.readInt16BE(body + number.length) });
      } else if (track) {
        const current: Track = track;
        if (id.value === EBML.trackNumber) current.number = readUint(b, body, length);
        else if (id.value === EBML.trackType) current.type = readUint(b, body, length);
        else if (id.value === EBML.codecId) current.codec = b.toString("latin1", body, bodyEnd).replace(/\0+$/, "");
        else if (id.value === EBML.pixelWidth) current.width = readUint(b, body, length);
        else if (id.value === EBML.pixelHeight) current.height = readUint(b, body, length);
      }
      pos = bodyEnd;
    }
  };
  walk(0, b.length);
  const video = tracks.find((entry) => entry.type === 1) ?? tracks[0];
  if (!video) throw new Error("The WebM file has no tracks.");
  const timestampsMs = blocks.filter((block) => block.track === video.number).map((block) => (block.time * scale) / 1_000_000);
  const step = timestampsMs.length > 1 ? (timestampsMs[timestampsMs.length - 1]! - timestampsMs[0]!) / (timestampsMs.length - 1) : 0;
  const durationMs = duration !== null ? (duration * scale) / 1_000_000 : timestampsMs.length ? timestampsMs[timestampsMs.length - 1]! + step : 0;
  return { container: "webm", codec: video.codec, width: video.width, height: video.height, durationMs, frames: timestampsMs.length, timestampsMs };
}

type Mp4Box = { type: string; body: number; end: number };

function mp4Boxes(b: Buffer, start: number, end: number): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = b.readUInt32BE(pos);
    const type = b.toString("latin1", pos + 4, pos + 8);
    let body = pos + 8;
    if (size === 1) {
      size = Number(b.readBigUInt64BE(pos + 8));
      body = pos + 16;
    } else if (size === 0) size = end - pos;
    if (size < 8 || pos + size > end) break;
    boxes.push({ type, body, end: pos + size });
    pos += size;
  }
  return boxes;
}

/** Frames, timestamps, size and codec of an MP4 file's first video track. */
export function probeMp4(buf: Uint8Array): VideoProbe {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const moov = mp4Boxes(b, 0, b.length).find((box) => box.type === "moov");
  if (!moov) throw new Error("The MP4 file has no movie header.");
  const child = (box: Mp4Box | undefined, type: string) => (box ? mp4Boxes(b, box.body, box.end).find((item) => item.type === type) : undefined);
  for (const trak of mp4Boxes(b, moov.body, moov.end).filter((box) => box.type === "trak")) {
    const mdia = child(trak, "mdia");
    const hdlr = child(mdia, "hdlr");
    if (!mdia || !hdlr || b.toString("latin1", hdlr.body + 8, hdlr.body + 12) !== "vide") continue;
    const mdhd = child(mdia, "mdhd");
    const tkhd = child(trak, "tkhd");
    const stbl = child(child(mdia, "minf"), "stbl");
    const stts = child(stbl, "stts");
    if (!mdhd || !tkhd || !stbl || !stts) throw new Error("The MP4 video track is incomplete.");
    const v1 = b[mdhd.body] === 1;
    const timescale = b.readUInt32BE(mdhd.body + (v1 ? 20 : 12));
    const mediaDuration = v1 ? Number(b.readBigUInt64BE(mdhd.body + 24)) : b.readUInt32BE(mdhd.body + 16);
    const width = Math.round(b.readUInt32BE(tkhd.end - 8) / 65536);
    const height = Math.round(b.readUInt32BE(tkhd.end - 4) / 65536);
    const stsd = child(stbl, "stsd");
    const codec = stsd ? b.toString("latin1", stsd.body + 12, stsd.body + 16) : null;
    const entries = b.readUInt32BE(stts.body + 4);
    const timestampsMs: number[] = [];
    let ticks = 0;
    for (let i = 0; i < entries; i += 1) {
      const count = b.readUInt32BE(stts.body + 8 + i * 8);
      const delta = b.readUInt32BE(stts.body + 12 + i * 8);
      for (let k = 0; k < count; k += 1) {
        timestampsMs.push((ticks * 1000) / timescale);
        ticks += delta;
      }
    }
    return { container: "mp4", codec, width, height, durationMs: (mediaDuration * 1000) / timescale, frames: timestampsMs.length, timestampsMs };
  }
  throw new Error("The MP4 file has no video track.");
}

/** Probes a video file by its signature: WebM (EBML) or MP4 (an ftyp box). */
export async function probeVideo(path: string): Promise<VideoProbe> {
  const handle = await open(path, "r");
  const head = Buffer.alloc(12);
  try {
    await handle.read(head, 0, 12, 0);
  } finally {
    await handle.close();
  }
  if (head.readUInt32BE(0) === 0x1a45dfa3) return probeWebm(await readFile(path));
  if (head.toString("latin1", 4, 8) === "ftyp") return probeMp4(await readFile(path));
  throw new Error("Not a WebM or MP4 file.");
}
