/**
 * Turning frames into the files the owner sees (ensemble-node design E§8.4): a video every phone
 * plays (H.264 MP4 where the system ffmpeg has an encoder, else VP9 or VP8 WebM), a poster frame
 * and a small preview still. Frames are JPEG and arrive one by one, either stepped (one per frame
 * time) or in real time with their own timestamps, which are resampled to a constant frame rate.
 * Recordings stop at a length limit, two minutes unless the caller allows more.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { chooseStillTool, encodeFramesArgs, findFfmpegs, previewArgs, type FfmpegInfo, type VideoChoice } from "./ffmpeg.js";
import { imageInfo, probeVideo } from "./probe.js";

export const DEFAULT_MAX_DURATION_MS = 120_000;
export const PREVIEW_WIDTH = 320;

export type StillFile = { path: string; mime: string; size: number; width: number; height: number };

export type MediaFile = {
  path: string;
  kind: "image" | "video" | "trace" | "html" | "file";
  mime: string;
  size: number;
  width?: number;
  height?: number;
  durationMs?: number;
  fps?: number;
  frames?: number;
  codec?: string;
  poster?: StillFile;
  preview?: StillFile;
  /** Kept for the owner to preview first: not sent and not shown to a model until they confirm. */
  held: boolean;
  reason?: string;
  /** The recording reached its length limit and stopped there. */
  truncated?: boolean;
  /** Password and code fields (and marked elements) masked at capture. */
  masked?: number;
  url?: string;
  title?: string;
};

export class CaptureError extends Error {
  constructor(
    public readonly code: "not_supported" | "unavailable" | "refused" | "sensitive" | "failed" | "bad_input" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "CaptureError";
  }
}

/** A file name part from free text: letters, digits and dashes. */
export function slugName(text: string | undefined, fallback: string): string {
  const slug = (text ?? "")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60)
    .replace(/^-|-$/g, "");
  return slug || fallback;
}

/** Reserves a new file in `dir` (never overwriting one): `name.ext`, else `name-2.ext`, and so on. */
export async function reserveFile(dir: string, name: string, extension: string): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (let n = 1; n < 1000; n += 1) {
    const path = join(dir, `${name}${n === 1 ? "" : `-${n}`}.${extension}`);
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.close();
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new CaptureError("failed", `Too many files named ${name} in the evidence folder.`);
}

export async function stillFile(path: string): Promise<StillFile> {
  const bytes = await readFile(path);
  const info = imageInfo(bytes);
  if (!info) throw new CaptureError("failed", `${basename(path)} is not an image Ensemble can read.`);
  return { path, mime: info.mime, size: bytes.length, width: info.width, height: info.height };
}

/** A preview no wider than `PREVIEW_WIDTH`, next to `source` (`name.preview.jpg` or `.png`). Null without a tool. */
export async function makePreview(jpeg: Buffer, source: string, tools?: FfmpegInfo[]): Promise<StillFile | null> {
  const tool = chooseStillTool(tools ?? (await findFfmpegs()));
  if (!tool) return null;
  const format = tool.jpeg ? "jpeg" : "png";
  const output = join(dirname(source), `${basename(source, extname(source))}.preview.${format === "jpeg" ? "jpg" : "png"}`);
  const result = await pipeInto(tool.path, previewArgs({ maxWidth: PREVIEW_WIDTH, format, output }), [jpeg], 20_000);
  if (result.code !== 0) {
    await rm(output, { force: true });
    return null;
  }
  return stillFile(output);
}

async function pipeInto(program: string, args: string[], chunks: Buffer[], timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(program, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  const stderr = collect(child);
  const done = exited(child);
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  child.stdin!.on("error", () => undefined);
  for (const chunk of chunks) child.stdin!.write(chunk);
  child.stdin!.end();
  const code = await done;
  clearTimeout(timer);
  return { code, stderr: stderr() };
}

function collect(child: ChildProcess): () => string {
  let text = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (text.length < 8_000) text += chunk.toString("utf8");
  });
  return () => text.trim();
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code));
  });
}

export type EncoderOptions = {
  choice: VideoChoice;
  output: string;
  fps: number;
  width: number;
  height: number;
  maxDurationMs?: number;
  /** Which frame becomes the poster: the middle of `expectedFrames`, or the last one written. */
  poster?: { frame: "middle"; expectedFrames: number } | { frame: "last" };
};

/**
 * One video being encoded. `write` takes a JPEG frame and waits while ffmpeg catches up; it
 * returns false once the length limit is reached. `finish` closes the stream and returns the
 * file with its measured length, frames and size, a poster and a preview.
 */
export class VideoEncoder {
  private readonly child: ChildProcess;
  private readonly stderr: () => string;
  private readonly done: Promise<number | null>;
  private readonly maxFrames: number;
  private written = 0;
  private posterFrame: Buffer | null = null;
  private failed: string | null = null;
  private finished = false;

  constructor(private readonly options: EncoderOptions) {
    const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    this.maxFrames = Math.max(1, Math.floor((maxDurationMs * options.fps) / 1000));
    this.child = spawn(options.choice.ffmpeg.path, encodeFramesArgs({ choice: options.choice, fps: options.fps, width: options.width, height: options.height, output: options.output }), {
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    this.stderr = collect(this.child);
    this.done = exited(this.child);
    this.child.stdin!.on("error", (error) => {
      this.failed ??= error.message;
    });
    void this.done.then((code) => {
      if (!this.finished && code !== 0) this.failed ??= this.stderr() || `ffmpeg stopped (exit ${code}).`;
    });
  }

  get frames(): number {
    return this.written;
  }

  get full(): boolean {
    return this.written >= this.maxFrames;
  }

  async write(jpeg: Buffer): Promise<boolean> {
    if (this.failed) throw new CaptureError("failed", `The video encoder failed: ${this.failed}`);
    if (this.full || this.finished) return false;
    const poster = this.options.poster ?? { frame: "last" };
    if (poster.frame === "last" || this.written === Math.floor((poster.expectedFrames - 1) / 2) || !this.posterFrame) this.posterFrame = jpeg;
    this.written += 1;
    const stdin = this.child.stdin!;
    if (!stdin.write(jpeg)) {
      await new Promise<void>((resolve) => {
        const ready = () => {
          stdin.off("drain", ready);
          this.child.off("close", ready);
          resolve();
        };
        stdin.on("drain", ready);
        this.child.once("close", ready);
      });
    }
    return !this.full;
  }

  async finish(): Promise<MediaFile> {
    if (this.finished) throw new CaptureError("failed", "This recording has already been finished.");
    this.finished = true;
    this.child.stdin!.end();
    const code = await this.done;
    const output = this.options.output;
    if (code !== 0 || this.failed || !this.written) {
      await rm(output, { force: true });
      const why = this.failed || this.stderr() || `exit ${code}`;
      throw new CaptureError("failed", this.written ? `The video encoder failed: ${why}` : "No frames were recorded.");
    }
    const probe = await probeVideo(output);
    const size = (await stat(output)).size;
    let poster: StillFile | undefined;
    let preview: StillFile | undefined;
    if (this.posterFrame) {
      const posterPath = join(dirname(output), `${basename(output, extname(output))}.poster.jpg`);
      await writeFile(posterPath, this.posterFrame, { mode: 0o600 });
      poster = await stillFile(posterPath);
      preview = (await makePreview(this.posterFrame, output).catch(() => null)) ?? undefined;
    }
    return {
      path: output,
      kind: "video",
      mime: this.options.choice.mime,
      size,
      width: probe.width,
      height: probe.height,
      durationMs: Math.round(probe.durationMs),
      fps: this.options.fps,
      frames: probe.frames,
      codec: this.options.choice.codec,
      poster,
      preview,
      held: false,
      truncated: this.written >= this.maxFrames ? true : undefined,
    };
  }

  /** Stops the encoder and deletes what it wrote. */
  async abort(): Promise<void> {
    this.finished = true;
    this.child.stdin!.destroy();
    this.child.kill("SIGKILL");
    await this.done;
    await rm(this.options.output, { force: true });
  }
}

/**
 * Real-time frames carry their own times (screencast frames arrive only when the page changes).
 * Output frame n shows the newest frame captured at or before n/fps seconds, so the video keeps
 * real time whatever the arrival rate.
 */
export class ConstantRateFeeder {
  private start: number | null = null;
  private last: Buffer | null = null;
  private emitted = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  /** The encoder's failure, kept for `end`: a frame callback never gets a rejected promise. */
  private failure: unknown = null;

  constructor(
    private readonly encoder: Pick<VideoEncoder, "write" | "full">,
    private readonly fps: number,
  ) {}

  /** Output slots due before `timeMs` that still need a frame. */
  private due(timeMs: number): number {
    if (this.start === null) return 0;
    return Math.max(0, Math.ceil(((timeMs - this.start) * this.fps) / 1000) - this.emitted);
  }

  private emit(frame: Buffer, count: number): Promise<unknown> {
    this.chain = this.chain
      .then(async () => {
        for (let i = 0; i < count && !this.stopped; i += 1) {
          if (!(await this.encoder.write(frame))) this.stopped = true;
        }
      })
      .catch((error: unknown) => {
        this.failure ??= error;
        this.stopped = true;
      });
    return this.chain;
  }

  /** A frame captured at `timeMs` (milliseconds, any epoch, increasing). */
  push(frame: Buffer, timeMs: number): Promise<unknown> {
    if (this.stopped) return this.chain;
    if (this.start === null) this.start = timeMs;
    const count = this.last ? this.due(timeMs) : 0;
    const previous = this.last;
    this.last = frame;
    if (previous && count) this.emitted += count;
    return previous && count ? this.emit(previous, count) : this.chain;
  }

  /** Fills the video up to `endMs` with the newest frame and waits for every write; throws the encoder's failure. */
  async end(endMs: number): Promise<void> {
    if (this.last && !this.stopped) {
      const count = Math.max(this.emitted ? 0 : 1, this.due(endMs));
      this.emitted += count;
      await this.emit(this.last, count);
    }
    await this.chain;
    if (this.failure) throw this.failure;
  }

  get limitReached(): boolean {
    return this.stopped || this.encoder.full;
  }

  get failed(): boolean {
    return this.failure !== null;
  }
}
