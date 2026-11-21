/**
 * What a finished MP4 holds, read from its `moov` box without decoding: length, picture size, frame count and
 * codec, to check a recording before it is saved (the macOS driver's `media.check`).
 */
import { open } from "node:fs/promises";

export type Mp4Facts = { durationMs: number; width: number; height: number; frames: number; codec: string; size: number };

type Box = { type: string; start: number; body: number; end: number };

function boxes(data: Buffer, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = data.readUInt32BE(at);
    const type = data.toString("latin1", at + 4, at + 8);
    let body = at + 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = Number(data.readBigUInt64BE(at + 8));
      body = at + 16;
    } else if (size === 0) size = to - at;
    if (size < body - at || at + size > to) break;
    out.push({ type, start: at, body, end: at + size });
    at += size;
  }
  return out;
}

const child = (data: Buffer, parent: Box, type: string) => boxes(data, parent.body, parent.end).find((box) => box.type === type) ?? null;

/** The `moov` box of the file at `path`: the file is walked by its top-level box headers, so a large `mdat` is never read. */
async function readMoov(path: string): Promise<{ moov: Buffer; size: number }> {
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    const head = Buffer.alloc(16);
    for (let at = 0; at + 8 <= size; ) {
      const { bytesRead } = await handle.read(head, 0, 16, at);
      if (bytesRead < 8) break;
      let length = head.readUInt32BE(0);
      const type = head.toString("latin1", 4, 8);
      if (length === 1 && bytesRead >= 16) length = Number(head.readBigUInt64BE(8));
      else if (length === 0) length = size - at;
      if (length < 8 || at + length > size) break;
      if (type === "moov") {
        if (length > 64 * 1024 * 1024) throw new Error("The video's index is too large.");
        const moov = Buffer.alloc(length);
        await handle.read(moov, 0, length, at);
        return { moov, size };
      }
      at += length;
    }
    throw new Error("The video has no index (moov): it was not finished.");
  } finally {
    await handle.close();
  }
}

export async function mp4Facts(path: string): Promise<Mp4Facts> {
  const { moov, size } = await readMoov(path);
  const root = boxes(moov, 0, moov.length)[0]!;
  const mvhd = child(moov, root, "mvhd");
  let durationMs = 0;
  if (mvhd) {
    const version = moov[mvhd.body]!;
    const timescale = moov.readUInt32BE(mvhd.body + (version === 1 ? 20 : 12));
    const duration = version === 1 ? Number(moov.readBigUInt64BE(mvhd.body + 24)) : moov.readUInt32BE(mvhd.body + 16);
    if (timescale > 0) durationMs = Math.round((duration * 1000) / timescale);
  }
  for (const trak of boxes(moov, root.body, root.end).filter((box) => box.type === "trak")) {
    const mdia = child(moov, trak, "mdia");
    const hdlr = mdia ? child(moov, mdia, "hdlr") : null;
    if (!mdia || !hdlr || moov.toString("latin1", hdlr.body + 8, hdlr.body + 12) !== "vide") continue;
    const tkhd = child(moov, trak, "tkhd");
    const width = tkhd ? Math.round(moov.readUInt32BE(tkhd.end - 8) / 65536) : 0;
    const height = tkhd ? Math.round(moov.readUInt32BE(tkhd.end - 4) / 65536) : 0;
    const minf = child(moov, mdia, "minf");
    const stbl = minf ? child(moov, minf, "stbl") : null;
    const stsd = stbl ? child(moov, stbl, "stsd") : null;
    const stsz = stbl ? child(moov, stbl, "stsz") ?? child(moov, stbl, "stz2") : null;
    const entry = stsd ? moov.toString("latin1", stsd.body + 12, stsd.body + 16) : "";
    const codec = entry === "avc1" || entry === "avc3" ? "h264" : entry === "hvc1" || entry === "hev1" ? "hevc" : entry || "unknown";
    const frames = stsz ? moov.readUInt32BE(stsz.body + 8) : 0;
    return { durationMs, width, height, frames, codec, size };
  }
  throw new Error("The video has no picture track.");
}
