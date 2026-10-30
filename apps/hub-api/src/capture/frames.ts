/**
 * Recording a page (ensemble-node design E§8.3). Frame-stepped: time is frozen and moved one frame
 * at a time (Playwright's clock for timers, animation frames and `performance.now()`; the Web
 * Animations API for CSS animations and transitions; `window.__ensembleSeek(ms)` for code that keeps
 * its own clock), and each frame is a screenshot, so the video is smooth and exact under any load.
 * Real time: the page's screencast frames, resampled to a constant frame rate.
 *
 * Page functions here are serialised into the page: no named inner functions (tsx adds `__name`).
 */
import type { JSHandle, Locator, Page } from "playwright-core";
import type { PageAnimation, PageWindow } from "../browser/page-world.js";
import { CaptureError, ConstantRateFeeder, type MediaFile, type VideoEncoder } from "./media.js";

export const MAX_FPS = 60;

type Known = { base: number; at: number; wasRunning: boolean };
type KnownMap = { get(animation: PageAnimation): Known | undefined; set(animation: PageAnimation, entry: Known): void };

/** Runs in the page: pauses new animations and seeks every animation to `t` ms after the recording began. */
function seekAnimations([known, t, fromStart]: [KnownMap, number, boolean]): unknown {
  const w = globalThis as unknown as PageWindow;
  const animations = w.document.getAnimations();
  for (let index = 0; index < animations.length; index += 1) {
    const animation = animations[index]!;
    let entry = known.get(animation);
    if (!entry) {
      const wasRunning = animation.playState === "running";
      animation.pause();
      entry = { base: fromStart && t === 0 ? 0 : (animation.currentTime ?? 0), at: t, wasRunning };
      known.set(animation, entry);
    }
    animation.currentTime = entry.base + (t - entry.at) * (animation.playbackRate || 1);
  }
  return typeof w.__ensembleSeek === "function" ? w.__ensembleSeek(t) : undefined;
}

/** Runs in the page: plays again the animations that were running before the recording. */
function releaseAnimations(known: KnownMap): void {
  const w = globalThis as unknown as PageWindow;
  const animations = w.document.getAnimations();
  for (let index = 0; index < animations.length; index += 1) {
    const entry = known.get(animations[index]!);
    if (entry?.wasRunning) animations[index]!.play();
  }
}

/** Stops the page's clock: timers, animation frames, Date and performance.now() move only when told. */
export async function freezeClock(page: Page): Promise<void> {
  await page.clock.install();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const now = await page.evaluate(() => Date.now());
    try {
      await page.clock.pauseAt(now + 25 * (attempt + 1));
      return;
    } catch (error) {
      if (!/past/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
  throw new CaptureError("failed", "Could not pause the page's clock.");
}

export type SteppedOptions = {
  page: Page;
  encoder: Pick<VideoEncoder, "write" | "full">;
  fps: number;
  durationMs: number;
  /** Seek the animations running when recording starts back to their beginning (default true). */
  fromStart?: boolean;
  masks?: () => Locator[];
  /** Called before the screenshot of the first frame of every second of video (privacy scans). */
  check?: (frame: number) => Promise<void>;
  onFrame?: (frame: { index: number; timeMs: number; jpeg: Buffer }) => void;
  /** Let time run and play the animations again afterwards (default true). */
  restore?: boolean;
  quality?: number;
};

/** Records `durationMs` of the page at `fps`, one exact frame at a time. */
export async function recordStepped(options: SteppedOptions): Promise<{ frames: number; truncated: boolean }> {
  const { page, encoder } = options;
  const fps = Math.min(MAX_FPS, Math.max(1, Math.round(options.fps)));
  const total = Math.max(1, Math.round((options.durationMs * fps) / 1000));
  await freezeClock(page);
  const known = (await page.evaluateHandle(() => new WeakMap())) as unknown as JSHandle<KnownMap>;
  let frames = 0;
  let truncated = false;
  try {
    let previousTick = 0;
    for (let index = 0; index < total; index += 1) {
      const timeMs = (index * 1000) / fps;
      const tick = Math.round(timeMs);
      if (tick > previousTick) await page.clock.runFor(tick - previousTick);
      previousTick = tick;
      try {
        await page.evaluate(seekAnimations, [known, timeMs, options.fromStart !== false] as unknown as [KnownMap, number, boolean]);
      } catch (error) {
        if (/context was destroyed|navigat/i.test(error instanceof Error ? error.message : String(error))) {
          throw new CaptureError("failed", "The page navigated during a frame-stepped recording. Record it in real time instead.");
        }
        throw error;
      }
      if (options.check && index % fps === 0) await options.check(index);
      const jpeg = await page.screenshot({ type: "jpeg", quality: options.quality ?? 90, scale: "css", animations: "allow", caret: "hide", mask: options.masks?.() ?? [] });
      options.onFrame?.({ index, timeMs, jpeg });
      frames += 1;
      if (!(await encoder.write(jpeg))) {
        truncated = index < total - 1;
        break;
      }
    }
  } finally {
    if (options.restore !== false) {
      await page.evaluate(releaseAnimations, known as unknown as KnownMap).catch(() => undefined);
      await page.clock.resume().catch(() => undefined);
    }
    await known.dispose().catch(() => undefined);
  }
  return { frames, truncated };
}

export type RealtimeOptions = {
  fps: number;
  maxDurationMs: number;
  /** Largest frame size; the page's aspect ratio is kept. */
  size: { width: number; height: number };
  /** While true, frames are dropped and the video holds the last frame shown before. */
  paused?: () => boolean;
  /** Called about once a second while recording (privacy scans). */
  check?: () => Promise<void>;
};

/**
 * A real-time recording of one page from its screencast. It stops itself at the length limit; `stop`
 * returns the finished video either way.
 */
export class RealtimeRecording {
  private readonly feeder: ConstantRateFeeder;
  private result: Promise<MediaFile> | null = null;
  private limitTimer: NodeJS.Timeout | null = null;
  private checkTimer: NodeJS.Timeout | null = null;
  private checking = false;
  readonly startedAt = Date.now();

  private constructor(
    private readonly page: Page,
    private readonly encoder: VideoEncoder,
    private readonly options: RealtimeOptions,
  ) {
    this.feeder = new ConstantRateFeeder(encoder, options.fps);
  }

  static async start(page: Page, encoder: VideoEncoder, options: RealtimeOptions): Promise<RealtimeRecording> {
    const recording = new RealtimeRecording(page, encoder, options);
    await page.screencast.start({
      size: options.size,
      quality: 85,
      onFrame: (frame) => {
        if (recording.result || recording.feeder.failed || options.paused?.()) return;
        // The feeder never rejects: an encoder failure is kept and reported by stop().
        return recording.feeder.push(frame.data, frame.timestamp);
      },
    });
    recording.limitTimer = setTimeout(() => void recording.stop().catch(() => undefined), options.maxDurationMs);
    if (options.check) {
      recording.checkTimer = setInterval(() => {
        if (recording.checking) return;
        recording.checking = true;
        void options
          .check!()
          .catch(() => undefined)
          .finally(() => (recording.checking = false));
      }, 1_000);
    }
    return recording;
  }

  get stopped(): boolean {
    return this.result !== null;
  }

  stop(): Promise<MediaFile> {
    this.result ??= (async () => {
      if (this.limitTimer) clearTimeout(this.limitTimer);
      if (this.checkTimer) clearInterval(this.checkTimer);
      await this.page.screencast.stop().catch(() => undefined);
      const end = Math.min(Date.now(), this.startedAt + this.options.maxDurationMs);
      try {
        await this.feeder.end(end);
      } catch (error) {
        await this.encoder.abort();
        throw error instanceof CaptureError ? error : new CaptureError("failed", `The recording failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const file = await this.encoder.finish();
      if (Date.now() - this.startedAt >= this.options.maxDurationMs) file.truncated = true;
      return file;
    })();
    return this.result;
  }

  /** Stops without keeping anything. */
  async discard(): Promise<void> {
    if (this.limitTimer) clearTimeout(this.limitTimer);
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.result ??= Promise.reject(new CaptureError("refused", "The recording was discarded."));
    this.result.catch(() => undefined);
    await this.page.screencast.stop().catch(() => undefined);
    await this.encoder.abort();
  }
}
