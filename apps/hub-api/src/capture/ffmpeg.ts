/**
 * ffmpeg for capture: which copies this computer has, what each can do, and the exact command
 * lines capture runs. The system's ffmpeg (with an H.264 encoder: MP4) is preferred; Playwright's
 * own LGPL build (VP8 or VP9: WebM) works everywhere Playwright does. Every encode reads JPEG
 * frames over a pipe (`image2pipe` + `mjpeg`), which every one of these builds can do.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { browserSearchRoots, listPlaywrightFfmpeg, thisHost, type Host } from "../browser/chromium.js";
import { captureStateDir, ensembleDataHome } from "../browser/paths.js";
import { findOnPath, isExecutable, runCommand, type RunResult } from "./system.js";

export type FfmpegSource = "explicit" | "system" | "ensemble" | "playwright";

export type FfmpegInfo = {
  path: string;
  source: FfmpegSource;
  version: string | null;
  major: number | null;
  /** H.264 encoder: `libx264`, else `libopenh264`. */
  h264: string | null;
  vp9: boolean;
  vp8: boolean;
  /** Reads JPEG frames from a pipe: every encode needs it. */
  jpegFrames: boolean;
  /** Writes a PNG or JPEG still (posters and previews). */
  png: boolean;
  jpeg: boolean;
  scale: boolean;
  /** X11 screen grabbing (`-f x11grab`), for apps on a virtual display. */
  x11grab: boolean;
};

export type VideoCodec = "h264" | "vp9" | "vp8";
export type VideoChoice = { ffmpeg: FfmpegInfo; codec: VideoCodec; container: "mp4" | "webm"; mime: string; extension: string };

/**
 * Names in `ffmpeg -encoders`, `-decoders`, `-demuxers`, `-muxers` and `-devices` listings: the
 * first word after the flag columns (`V....D`, `D`, `DE`, and `d` for a device), after the rule.
 */
export function parseListing(text: string): Set<string> {
  const names = new Set<string>();
  let started = false;
  for (const line of text.split("\n")) {
    if (/^\s*-{2,}\s*$/.test(line)) {
      started = true;
      continue;
    }
    if (!started) continue;
    const words = line.trim().split(/\s+/);
    let index = 0;
    while (index < words.length - 1 && /^(?:[A-Z.]{1,7}|d)$/.test(words[index]!)) index += 1;
    if (index === 0 || !words[index]) continue;
    for (const name of words[index]!.split(",")) names.add(name);
  }
  return names;
}

/** Filter names from `ffmpeg -filters`, whose lines carry an `in->out` column instead of a header rule. */
export function parseFilters(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^\s*[T.][S.][C.]\s+(\S+)\s+\S*->\S*/.exec(line);
    if (match) names.add(match[1]!);
  }
  return names;
}

export function parseVersion(text: string): { version: string | null; major: number | null } {
  const match = /ffmpeg version (\S+)/.exec(text);
  if (!match) return { version: null, major: null };
  const number = /(\d+)\.(\d+)/.exec(match[1]!);
  return { version: match[1]!, major: number ? Number(number[1]) : null };
}

type Runner = (program: string, args: string[]) => Promise<RunResult>;

const defaultRunner: Runner = (program, args) => runCommand(program, args, { timeoutMs: 8_000 });

/** What one ffmpeg binary can do, from its own listings. */
export async function probeFfmpeg(path: string, source: FfmpegSource, run: Runner = defaultRunner): Promise<FfmpegInfo | null> {
  const [version, encoders, decoders, demuxers, muxers, filters, devices] = await Promise.all(
    [["-version"], ["-encoders"], ["-decoders"], ["-demuxers"], ["-muxers"], ["-filters"], ["-devices"]].map((args) => run(path, ["-hide_banner", ...args])),
  );
  if (!version || version.code !== 0) return null;
  const list = (result: RunResult | undefined) => parseListing(result?.stdout ?? "");
  const enc = list(encoders);
  const dec = list(decoders);
  const demux = list(demuxers);
  const mux = list(muxers);
  const filt = parseFilters(filters?.stdout ?? "");
  const dev = list(devices);
  const parsed = parseVersion(version.stdout);
  return {
    path,
    source,
    ...parsed,
    h264: enc.has("libx264") ? "libx264" : enc.has("libopenh264") ? "libopenh264" : null,
    vp9: enc.has("libvpx-vp9"),
    vp8: enc.has("libvpx"),
    jpegFrames: demux.has("image2pipe") && dec.has("mjpeg"),
    png: enc.has("png") && mux.has("image2"),
    jpeg: enc.has("mjpeg") && mux.has("image2"),
    scale: filt.has("scale"),
    x11grab: dev.has("x11grab") || demux.has("x11grab"),
  };
}

/** Where ffmpeg may be: an explicit path, the system's, one in Ensemble's data folder, Playwright's. */
export function ffmpegCandidates(host: Host = thisHost(), dataHome: string = ensembleDataHome(host.env, host.platform, host.home), executable = isExecutable): Array<{ path: string; source: FfmpegSource }> {
  const found: Array<{ path: string; source: FfmpegSource }> = [];
  const explicit = host.env.ENSEMBLE_FFMPEG?.trim();
  if (explicit && executable(explicit)) found.push({ path: explicit, source: "explicit" });
  const system = findOnPath("ffmpeg", host.env, host.platform, executable);
  if (system) found.push({ path: system, source: "system" });
  for (const path of ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"]) {
    if (host.platform !== "win32" && executable(path)) found.push({ path, source: "system" });
  }
  const own = join(captureStateDir(dataHome), "bin", host.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  if (executable(own)) found.push({ path: own, source: "ensemble" });
  for (const build of listPlaywrightFfmpeg(browserSearchRoots(host, dataHome), host)) found.push({ path: build.path, source: "playwright" });
  const seen = new Set<string>();
  return found.filter((entry) => !seen.has(entry.path) && seen.add(entry.path));
}

const cache = new Map<string, { key: string; info: FfmpegInfo | null }>();

function fileKey(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

/** Every usable ffmpeg here, probed once per binary (until the file changes). */
export async function findFfmpegs(options: { host?: Host; dataHome?: string; refresh?: boolean } = {}): Promise<FfmpegInfo[]> {
  const out: FfmpegInfo[] = [];
  for (const candidate of ffmpegCandidates(options.host, options.dataHome)) {
    const key = fileKey(candidate.path);
    const hit = cache.get(candidate.path);
    let info = hit && hit.key === key && !options.refresh ? hit.info : undefined;
    if (info === undefined) {
      info = await probeFfmpeg(candidate.path, candidate.source);
      cache.set(candidate.path, { key, info });
    }
    if (info) out.push({ ...info, source: candidate.source });
  }
  return out;
}

/** The best video output this computer can make: H.264 in MP4, else VP9, else VP8, in WebM. */
export function chooseVideoEncoder(ffmpegs: FfmpegInfo[]): VideoChoice | null {
  const usable = ffmpegs.filter((info) => info.jpegFrames && info.scale);
  const h264 = usable.find((info) => info.h264);
  if (h264) return { ffmpeg: h264, codec: "h264", container: "mp4", mime: "video/mp4", extension: "mp4" };
  const vp9 = usable.find((info) => info.vp9);
  if (vp9) return { ffmpeg: vp9, codec: "vp9", container: "webm", mime: "video/webm", extension: "webm" };
  const vp8 = usable.find((info) => info.vp8);
  if (vp8) return { ffmpeg: vp8, codec: "vp8", container: "webm", mime: "video/webm", extension: "webm" };
  return null;
}

/** An ffmpeg that can shrink a JPEG into a preview still. */
export function chooseStillTool(ffmpegs: FfmpegInfo[]): FfmpegInfo | null {
  return ffmpegs.find((info) => info.jpegFrames && info.scale && info.jpeg) ?? ffmpegs.find((info) => info.jpegFrames && info.scale && info.png) ?? null;
}

export function even(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

const QUIET = ["-hide_banner", "-loglevel", "error", "-nostdin"];

function codecArgs(codec: VideoCodec, h264Encoder: string | null): string[] {
  if (codec === "h264") {
    return h264Encoder === "libopenh264"
      ? ["-c:v", "libopenh264", "-b:v", "4M", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
      : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
  }
  if (codec === "vp9") return ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-deadline", "realtime", "-cpu-used", "8", "-pix_fmt", "yuv420p"];
  return ["-c:v", "libvpx", "-b:v", "4M", "-crf", "8", "-deadline", "realtime", "-cpu-used", "8", "-auto-alt-ref", "0", "-pix_fmt", "yuv420p"];
}

/**
 * Encode JPEG frames from stdin at a constant frame rate: frame n is shown at n/fps seconds. Each
 * frame is fitted into `width`×`height` (even numbers) on white, so a frame of another size, such as
 * after a resize, cannot break the stream.
 */
export function encodeFramesArgs(input: { choice: VideoChoice; fps: number; width: number; height: number; output: string }): string[] {
  const width = even(input.width);
  const height = even(input.height);
  const fit = `scale=${width}:${height}:force_original_aspect_ratio=decrease:eval=frame,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=white,format=yuv420p`;
  return [
    ...QUIET,
    "-y",
    "-f",
    "image2pipe",
    "-c:v",
    "mjpeg",
    "-framerate",
    String(input.fps),
    "-i",
    "pipe:0",
    "-an",
    "-vf",
    fit,
    ...codecArgs(input.choice.codec, input.choice.ffmpeg.h264),
    "-r",
    String(input.fps),
    input.output,
  ];
}

/** A small still from a JPEG on stdin, never wider than `maxWidth`: PNG or JPEG by `format`. */
export function previewArgs(input: { maxWidth: number; format: "png" | "jpeg"; output: string }): string[] {
  return [
    ...QUIET,
    "-y",
    "-f",
    "image2pipe",
    "-c:v",
    "mjpeg",
    "-i",
    "pipe:0",
    "-vf",
    `scale=w=min(${input.maxWidth}\\,iw):h=-2`,
    "-frames:v",
    "1",
    ...(input.format === "jpeg" ? ["-c:v", "mjpeg", "-q:v", "5"] : ["-c:v", "png"]),
    "-f",
    "image2",
    input.output,
  ];
}

export type GrabRegion = { display: string; x: number; y: number; width: number; height: number };

function grabInput(region: GrabRegion): string[] {
  return ["-f", "x11grab", "-draw_mouse", "0", "-video_size", `${even(region.width)}x${even(region.height)}`, "-i", `${region.display}.0+${Math.max(0, region.x)},${Math.max(0, region.y)}`];
}

/** One PNG frame of a region of an X display (an app's window on its virtual display). */
export function x11ScreenshotArgs(region: GrabRegion, output: string): string[] {
  return [...QUIET, "-y", ...grabInput(region), "-frames:v", "1", "-c:v", "png", "-f", "image2", output];
}

/** A real-time recording of a region of an X display for `seconds`, at `fps`. */
export function x11RecordArgs(input: { region: GrabRegion; fps: number; seconds: number; choice: VideoChoice; output: string }): string[] {
  return [
    ...QUIET,
    "-y",
    "-framerate",
    String(input.fps),
    ...grabInput(input.region),
    "-t",
    input.seconds.toFixed(3),
    "-an",
    ...codecArgs(input.choice.codec, input.choice.ffmpeg.h264),
    "-r",
    String(input.fps),
    input.output,
  ];
}
