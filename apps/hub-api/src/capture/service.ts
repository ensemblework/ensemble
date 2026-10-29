/**
 * The capture service (ensemble-node design B19): screenshots and video of web pages, Electron
 * apps, other desktop apps on a private virtual display, and terminal transcripts, written into the
 * caller's evidence folder with the checks that come before sending them. Its two callers, the
 * node's device tools and a coding agent's run MCP server, reach it through `capture/tools.ts`.
 *
 * Web capture goes through the browser broker (its masking, privacy rules and leases). Apps and
 * recordings started here are leased (capture/leases.ts): they end when their lease runs out, when
 * their process ends, when the runtime exits, and after a crash at the next start.
 */
import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { Page } from "playwright-core";
import type { Check } from "../node/report.js";
import { BrowserBroker, BrowserError, elementSelector } from "../browser/broker.js";
import { scanPage, sensitiveMasks } from "../browser/page-scan.js";
import { captureStateDir, ensembleDataHome } from "../browser/paths.js";
import { hasSecrets, holdReason, SECRET_MIN_LENGTH, type PrivacyRules } from "../browser/privacy.js";
import { startCommand, startElectron, virtualDisplayEnv, type CommandWrapper, type StartedElectron, type StartedProcess } from "./apps.js";
import { captureCapabilities, type CaptureCapabilities } from "./capabilities.js";
import { checkImage, checkTextIn, crashLine } from "./checks.js";
import { findDisplayTools, findWindow, processTree, VirtualDisplay, type DisplayTools, type FoundWindow } from "./display.js";
import { chooseVideoEncoder, findFfmpegs, x11RecordArgs, x11ScreenshotArgs, type FfmpegInfo } from "./ffmpeg.js";
import { MAX_FPS, RealtimeRecording, recordStepped } from "./frames.js";
import { LeaseTable } from "./leases.js";
import { CaptureError, DEFAULT_MAX_DURATION_MS, reserveFile, slugName, stillFile, VideoEncoder, type MediaFile } from "./media.js";
import { probeVideo } from "./probe.js";
import { runCommand } from "./system.js";
import { transcriptHtml } from "./terminal.js";

export type Viewport = { width: number; height: number };

/** Who is asking and where files go. The operation owns the apps and tabs it starts. */
export type CaptureRequest = {
  operation: string;
  evidenceDir: string;
  /** The longest video (default two minutes); the owner's setting. */
  maxVideoMs?: number;
};

export type WebTarget = {
  kind: "web";
  /** A page to open in a private tab, or one of the operation's broker tabs. */
  url?: string;
  tab?: string;
  viewport?: Viewport;
  device?: string;
  fullPage?: boolean;
  /** A CSS selector, or a snapshot reference for a tab. */
  element?: string;
  waitFor?: { text?: string; selector?: string; ms?: number };
};
export type AppTarget = { kind: "electron" | "gui"; app: string; window?: string };
export type TerminalTarget = { kind: "terminal"; transcript: string; title?: string; format?: "png" | "html"; columns?: number };
export type DesktopTarget = { kind: "desktop" };
export type ScreenshotTarget = WebTarget | AppTarget | TerminalTarget | DesktopTarget;

export type VideoStep = { action: "click" | "type" | "press" | "wait" | "scroll"; selector?: string; text?: string; key?: string; ms?: number; y?: number };
export type VideoInput = { target: WebTarget | AppTarget | DesktopTarget; durationSec: number; mode?: "realtime" | "frames"; fps?: number; steps?: VideoStep[]; name?: string };

export type AppStartInput = {
  kind?: "gui" | "electron";
  /** The command for a GUI app, run by the shell in `cwd`. */
  command?: string;
  cwd: string;
  /** Electron: the entry (default ".", the package's main) and extra arguments. */
  entry?: string;
  args?: string[];
  env?: Record<string, string>;
  size?: Viewport;
  /** Wait for a window with this text in its title. */
  title?: string;
  leaseMs?: number;
};

export type AppInfo = {
  app: string;
  kind: "gui" | "electron";
  pid: number;
  running: boolean;
  display: string | null;
  windowManager: string | null;
  window: { title: string; width: number; height: number; found: FoundWindow["how"] } | null;
  electronVersion?: string | null;
  startedAt: string;
  expiresAt: string;
};

type AppEntry = {
  id: string;
  kind: "gui" | "electron";
  operation: string;
  cwd: string;
  display: VirtualDisplay | null;
  process?: StartedProcess;
  electron?: StartedElectron;
  leaseId: string;
  startedAt: number;
  title?: string;
  /** Set when the app's process ended: it stays listed (for checks) until stopped. */
  ended: string | null;
};

export type CaptureServiceOptions = {
  broker: BrowserBroker;
  dataHome?: string;
  leases?: LeaseTable;
  log?: (message: string) => void;
  /** Wraps a GUI app's command, for the OS sandbox. */
  wrapCommand?: CommandWrapper;
  appLeaseMs?: number;
  displayTools?: () => DisplayTools;
  platform?: string;
};

const PREVIEW_REASON = "The owner asked to see captures of this site before they are sent.";
const UNCHECKED_REASON = "A desktop app's window cannot be checked for secrets on this computer, so the owner previews it first.";
const DEFAULT_APP_LEASE = 30 * 60_000;

export class CaptureService {
  readonly broker: BrowserBroker;
  readonly leases: LeaseTable;
  private readonly apps = new Map<string, AppEntry>();
  private readonly options: CaptureServiceOptions;
  private exitHook: (() => void) | null = null;
  private started = false;
  private counter = 0;

  constructor(options: CaptureServiceOptions) {
    this.options = options;
    this.broker = options.broker;
    this.leases = options.leases ?? new LeaseTable(join(captureStateDir(this.dataHome()), "leases.json"), undefined, (message) => this.log(message));
    this.leases.onEnded = (record, reason) => {
      for (const entry of this.apps.values()) {
        if (entry.leaseId !== record.id) continue;
        entry.ended = reason;
        if (reason !== "app exited" && reason !== "process ended") this.apps.delete(entry.id);
        void entry.electron?.app.close().catch(() => undefined);
        if (entry.display) void entry.display.stop("its app ended");
      }
    };
  }

  private dataHome(): string {
    return this.options.dataHome ?? ensembleDataHome(process.env, process.platform, homedir());
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  private get platform(): string {
    return this.options.platform ?? process.platform;
  }

  /** Cleans up after a crash, then keeps leases in check. Called once when the runtime starts. */
  async start(): Promise<{ reaped: string[] }> {
    if (this.started) return { reaped: [] };
    this.started = true;
    const reaped = await this.leases.reapLeftovers();
    this.leases.startJanitor();
    this.exitHook = () => this.leases.endAllSync();
    process.once("exit", this.exitHook);
    return { reaped };
  }

  async shutdown(): Promise<void> {
    for (const entry of [...this.apps.values()]) await this.stopEntry(entry, "shutting down");
    await this.leases.endAll();
    this.leases.stopJanitor();
    if (this.exitHook) process.off("exit", this.exitHook);
    this.exitHook = null;
    this.started = false;
  }

  capabilities(refresh = false): Promise<CaptureCapabilities> {
    return captureCapabilities({ refresh, dataHome: this.dataHome() });
  }

  private tools(): DisplayTools {
    return this.options.displayTools?.() ?? findDisplayTools();
  }

  private async dir(request: CaptureRequest): Promise<string> {
    if (!request.evidenceDir) throw new CaptureError("bad_input", "An evidence folder is required.");
    await mkdir(request.evidenceDir, { recursive: true, mode: 0o700 });
    return request.evidenceDir;
  }

  private maxVideoMs(request: CaptureRequest): number {
    return Math.max(1_000, request.maxVideoMs ?? DEFAULT_MAX_DURATION_MS);
  }

  /** A broker operation for capture's own private tabs, separate from the agent's tabs. */
  private internal(request: CaptureRequest): string {
    const id = `${request.operation}#capture-${(this.counter += 1)}`;
    this.broker.operation(id, { evidenceDir: request.evidenceDir, maxVideoMs: this.maxVideoMs(request) });
    return id;
  }

  // ── screenshots ──────────────────────────────────────────────────────────

  async screenshot(request: CaptureRequest, target: ScreenshotTarget, name?: string): Promise<MediaFile> {
    await this.dir(request);
    switch (target.kind) {
      case "web":
        return this.webScreenshot(request, target, name);
      case "electron":
        return this.electronScreenshot(request, target, name);
      case "gui":
        return this.guiScreenshot(request, target, name);
      case "terminal":
        return this.terminalCapture(request, target, name);
      case "desktop":
        throw desktopUnsupported();
      default:
        throw new CaptureError("bad_input", "Unknown capture target.");
    }
  }

  private async webScreenshot(request: CaptureRequest, target: WebTarget, name?: string): Promise<MediaFile> {
    if (target.tab) {
      if (target.device) throw new CaptureError("bad_input", "Device emulation applies to a URL opened for the capture, not to an open tab.");
      if (target.waitFor) await this.waitOn(request.operation, target.tab, target.waitFor);
      this.broker.operation(request.operation, { evidenceDir: request.evidenceDir });
      return wrapBrowser(() => this.broker.screenshot(request.operation, target.tab!, { fullPage: target.fullPage, element: target.element, viewport: target.viewport, name }));
    }
    if (!target.url) throw new CaptureError("bad_input", "Give a url or a tab.");
    const op = this.internal(request);
    try {
      const opened = await wrapBrowser(() => this.broker.open(op, target.url!, { private: true, viewport: target.viewport, device: target.device }));
      if (opened.error) throw new CaptureError("failed", `The page did not open: ${opened.error}`);
      const page = this.broker.pageFor(op, opened.tab);
      await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => undefined);
      if (target.waitFor) await this.waitOn(op, opened.tab, target.waitFor);
      return await wrapBrowser(() => this.broker.screenshot(op, opened.tab, { fullPage: target.fullPage, element: target.element, name: name ?? pageName(target.url!) }));
    } finally {
      await this.broker.release(op);
    }
  }

  private async waitOn(operation: string, tab: string, waitFor: NonNullable<WebTarget["waitFor"]>): Promise<void> {
    if (waitFor.text) await wrapBrowser(() => this.broker.wait(operation, tab, { text: waitFor.text, timeoutMs: 15_000 }));
    if (waitFor.selector) await wrapBrowser(() => this.broker.wait(operation, tab, { selector: waitFor.selector, timeoutMs: 15_000 }));
    if (waitFor.ms) await new Promise((resolve) => setTimeout(resolve, Math.min(waitFor.ms!, 30_000)));
  }

  /** Screenshot of a page that is not a broker tab (an Electron window), masked and scanned. */
  private async pageScreenshot(page: Page, dir: string, name: string): Promise<MediaFile> {
    const rules = await this.broker.privacyRules();
    const scan = await scanPage(page, rules);
    if (scan.site === "never") throw new CaptureError("refused", "The owner marked this site as never captured.");
    const path = await reserveFile(dir, name, "png");
    await page.screenshot({ path, mask: sensitiveMasks(page), caret: "hide", timeout: 20_000 });
    const reason = scan.site === "preview" ? PREVIEW_REASON : holdReason(scan.hits);
    return { ...(await stillFile(path)), kind: "image", held: Boolean(reason), ...(reason ? { reason } : {}), title: await page.title().catch(() => "") };
  }

  private async electronWindow(entry: AppEntry, title?: string): Promise<Page> {
    const app = entry.electron!.app;
    const windows = app.windows();
    if (title) {
      for (const window of windows) if ((await window.title().catch(() => "")).toLowerCase().includes(title.toLowerCase())) return window;
      throw new CaptureError("not_found", `No window titled “${title}”.`);
    }
    return windows[0] ?? (await app.firstWindow({ timeout: 10_000 }));
  }

  private async electronScreenshot(request: CaptureRequest, target: AppTarget, name?: string): Promise<MediaFile> {
    const entry = this.running(this.app(request, target.app, "electron"));
    const page = await this.electronWindow(entry, target.window);
    return this.pageScreenshot(page, request.evidenceDir, slugName(name, `electron-${entry.id}`));
  }

  private grabber(ffmpegs: FfmpegInfo[]): FfmpegInfo {
    const grabber = ffmpegs.find((info) => info.x11grab && info.png);
    if (!grabber) throw new CaptureError("unavailable", "Capturing a desktop app needs the system's ffmpeg with X11 capture. Run `ensemble capture setup` for the install command.");
    return grabber;
  }

  private async locate(entry: AppEntry, title?: string): Promise<FoundWindow> {
    const display = entry.display!;
    const pids = this.platform === "linux" ? processTree(entry.process!.child.pid!) : new Set([entry.process!.child.pid!]);
    const window = await findWindow({ env: virtualDisplayEnv(process.env, display.env), size: display.size, pids, title: title ?? entry.title, tools: this.tools() });
    // Clamp to the display: a window partly off screen is grabbed where it is visible.
    const x = Math.max(0, window.x);
    const y = Math.max(0, window.y);
    return { ...window, x, y, width: Math.min(window.width, display.size.width - x), height: Math.min(window.height, display.size.height - y) };
  }

  private async guiScreenshot(request: CaptureRequest, target: AppTarget, name?: string): Promise<MediaFile> {
    const entry = this.running(this.app(request, target.app, "gui"));
    const grabber = this.grabber(await findFfmpegs());
    const window = await this.locate(entry, target.window);
    const path = await reserveFile(request.evidenceDir, slugName(name, `app-${entry.id}`), "png");
    const result = await runCommand(grabber.path, x11ScreenshotArgs({ display: entry.display!.display, ...window }, path), { env: virtualDisplayEnv(process.env, entry.display!.env), timeoutMs: 20_000 });
    if (result.code !== 0) throw new CaptureError("failed", `The screenshot failed: ${result.stderr.trim().slice(0, 500) || result.error}`);
    return { ...(await stillFile(path)), kind: "image", held: true, reason: UNCHECKED_REASON, title: window.title };
  }

  private async terminalCapture(request: CaptureRequest, target: TerminalTarget, name?: string): Promise<MediaFile> {
    const rules = await this.broker.privacyRules();
    const { html } = transcriptHtml({ transcript: target.transcript, title: target.title, columns: target.columns, rules });
    const base = slugName(name ?? target.title, "terminal");
    if (target.format === "html") {
      const path = await reserveFile(request.evidenceDir, base, "html");
      await writeFile(path, html, { mode: 0o600 });
      return { path, kind: "html", mime: "text/html", size: Buffer.byteLength(html), held: false };
    }
    const op = this.internal(request);
    try {
      // A short viewport, so the full-page screenshot is as tall as the transcript.
      const width = Math.round(Math.min(Math.max(target.columns ?? 100, 40), 300) * 7.9) + 40;
      const opened = await wrapBrowser(() => this.broker.open(op, "about:blank", { private: true, viewport: { width, height: 100 } }));
      const page = this.broker.pageFor(op, opened.tab);
      await page.setContent(html, { waitUntil: "load" });
      const path = await reserveFile(request.evidenceDir, base, "png");
      await page.screenshot({ path, fullPage: true, caret: "hide" });
      return { ...(await stillFile(path)), kind: "image", held: false, title: target.title };
    } finally {
      await this.broker.release(op);
    }
  }

  // ── video ────────────────────────────────────────────────────────────────

  async video(request: CaptureRequest, input: VideoInput): Promise<MediaFile> {
    await this.dir(request);
    const maxMs = this.maxVideoMs(request);
    if (!(input.durationSec > 0)) throw new CaptureError("bad_input", "Give a duration in seconds.");
    const durationMs = Math.min(input.durationSec * 1000, maxMs);
    const mode = input.mode ?? "realtime";
    if (mode === "frames" && input.steps?.length) throw new CaptureError("bad_input", "Steps run in real time: use mode realtime for a recorded flow, frames for an animation.");
    const target = input.target;
    if (target.kind === "desktop") throw desktopUnsupported();
    if (target.kind === "gui") return this.guiVideo(request, target, durationMs, input);
    const choice = chooseVideoEncoder(await findFfmpegs());
    if (!choice) throw new CaptureError("unavailable", "No video encoder on this computer. Run `ensemble capture setup`.");
    const truncatedByLimit = input.durationSec * 1000 > maxMs;

    let page: Page;
    let release: (() => Promise<unknown>) | null = null;
    let tab: { operation: string; id: string } | null = null;
    if (target.kind === "web") {
      if (target.tab) {
        page = this.broker.pageFor(request.operation, target.tab);
        tab = { operation: request.operation, id: target.tab };
        this.broker.operation(request.operation, { evidenceDir: request.evidenceDir, maxVideoMs: maxMs });
      } else {
        if (!target.url) throw new CaptureError("bad_input", "Give a url or a tab.");
        const op = this.internal(request);
        release = () => this.broker.release(op);
        const opened = await wrapBrowser(() => this.broker.open(op, target.url!, { private: true, viewport: target.viewport, device: target.device, clock: mode === "frames" }));
        if (opened.error) {
          await release();
          throw new CaptureError("failed", `The page did not open: ${opened.error}`);
        }
        page = this.broker.pageFor(op, opened.tab);
        tab = { operation: op, id: opened.tab };
        await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => undefined);
      }
    } else {
      const entry = this.running(this.app(request, target.app, "electron"));
      page = await this.electronWindow(entry, target.window);
    }

    try {
      if (target.kind === "web" && target.waitFor && tab) await this.waitOn(tab.operation, tab.id, target.waitFor);
      const name = slugName(input.name, target.kind === "web" ? "page-video" : "app-video");
      if (mode === "frames") {
        const fps = Math.min(MAX_FPS, Math.max(1, Math.round(input.fps ?? 30)));
        const viewport = page.viewportSize() ?? (await page.evaluate(() => ({ width: (globalThis as unknown as { innerWidth: number }).innerWidth, height: (globalThis as unknown as { innerHeight: number }).innerHeight })));
        const output = await reserveFile(request.evidenceDir, name, choice.extension);
        const expectedFrames = Math.max(1, Math.round((durationMs * fps) / 1000));
        const encoder = new VideoEncoder({ choice, output, fps, width: viewport.width, height: viewport.height, maxDurationMs: maxMs, poster: { frame: "middle", expectedFrames } });
        const rules = await this.broker.privacyRules();
        let held: string | null = null;
        try {
          await recordStepped({
            page,
            encoder,
            fps,
            durationMs,
            masks: () => sensitiveMasks(page),
            check: async () => {
              const scan = await scanPage(page, rules);
              if (scan.site === "never") throw new CaptureError("refused", "The owner marked this site as never captured.");
              held ??= scan.site === "preview" ? PREVIEW_REASON : holdReason(scan.hits);
            },
          });
        } catch (error) {
          await encoder.abort();
          throw error;
        }
        const file = await encoder.finish();
        return { ...file, held: Boolean(held), ...(held ? { reason: held } : {}), truncated: truncatedByLimit || file.truncated, url: page.url() };
      }

      const fps = Math.min(30, Math.max(5, Math.round(input.fps ?? 25)));
      if (tab) {
        const { operation, id } = tab;
        await wrapBrowser(() => this.broker.record(operation, id, { kind: "video", action: "start", fps, name: input.name ?? name }));
        const started = Date.now();
        let failed: unknown = null;
        try {
          await this.runSteps(page, input.steps ?? []);
          await sleep(Math.max(0, durationMs - (Date.now() - started)));
        } catch (error) {
          failed = error;
        }
        const stopped = await wrapBrowser(() => this.broker.record(operation, id, { kind: "video", action: "stop" }));
        if (failed) {
          await removeMedia(stopped.file);
          throw failed;
        }
        const file = stopped.file!;
        return { ...file, truncated: truncatedByLimit || file.truncated };
      }
      return await this.recordAppPage(request, page, { choice, fps, durationMs, maxMs, name, steps: input.steps ?? [], truncatedByLimit });
    } finally {
      if (release) await release();
    }
  }

  private async recordAppPage(
    request: CaptureRequest,
    page: Page,
    input: { choice: NonNullable<ReturnType<typeof chooseVideoEncoder>>; fps: number; durationMs: number; maxMs: number; name: string; steps: VideoStep[]; truncatedByLimit: boolean },
  ): Promise<MediaFile> {
    const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
    const size = { width: Math.min(viewport.width, 1920), height: Math.min(viewport.height, 1920) };
    const output = await reserveFile(request.evidenceDir, input.name, input.choice.extension);
    const encoder = new VideoEncoder({ choice: input.choice, output, fps: input.fps, width: size.width, height: size.height, maxDurationMs: input.maxMs, poster: { frame: "last" } });
    const rules = await this.broker.privacyRules();
    const watch: { held: string | null } = { held: null };
    const check = async () => {
      if (watch.held || page.isClosed()) return;
      const scan = await scanPage(page, rules).catch(() => null);
      if (!scan) return;
      watch.held = scan.site ? PREVIEW_REASON : hasSecrets(scan.hits) ? holdReason(scan.hits) : scan.exposedFields ? "A one-time code or card field was on screen." : null;
    };
    await check();
    const recording = await RealtimeRecording.start(page, encoder, { fps: input.fps, maxDurationMs: input.maxMs, size, check });
    const started = Date.now();
    try {
      await this.runSteps(page, input.steps);
      await sleep(Math.max(0, input.durationMs - (Date.now() - started)));
    } catch (error) {
      await recording.discard();
      throw error;
    }
    const file = await recording.stop();
    return { ...file, held: Boolean(watch.held), ...(watch.held ? { reason: watch.held } : {}), truncated: input.truncatedByLimit || file.truncated };
  }

  /** A short scripted flow during a real-time recording: no scripts, only clicks, typing, keys, waits and scrolls. */
  private async runSteps(page: Page, steps: VideoStep[]): Promise<void> {
    if (steps.length > 50) throw new CaptureError("bad_input", "At most 50 steps.");
    const rules = await this.broker.privacyRules();
    for (const [index, step] of steps.entries()) {
      const where = () => {
        if (step.selector) return page.locator(elementSelector(step.selector)).first();
        if (step.text) return page.getByText(step.text).first();
        throw new CaptureError("bad_input", `Step ${index + 1} needs a selector or a text.`);
      };
      try {
        if (step.action === "click") await where().click({ timeout: 10_000 });
        else if (step.action === "type") {
          if (!step.selector) throw new CaptureError("bad_input", `Step ${index + 1} needs the field's selector.`);
          const text = step.text ?? "";
          if ((rules.secretValues ?? []).some((value) => value.length >= SECRET_MIN_LENGTH && text.includes(value))) throw new CaptureError("refused", "A step types one of the owner's saved secrets.");
          await page.locator(elementSelector(step.selector)).first().fill(text, { timeout: 10_000 });
        } else if (step.action === "press") await page.keyboard.press(step.key ?? "Enter");
        else if (step.action === "wait") await sleep(Math.min(Math.max(0, step.ms ?? 500), 30_000));
        else if (step.action === "scroll") await page.mouse.wheel(0, step.y ?? 600);
      } catch (error) {
        if (error instanceof CaptureError || error instanceof BrowserError) throw error;
        throw new CaptureError("failed", `Step ${index + 1} (${step.action}) failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      }
    }
  }

  private async guiVideo(request: CaptureRequest, target: AppTarget, durationMs: number, input: VideoInput): Promise<MediaFile> {
    if (input.mode === "frames") throw new CaptureError("not_supported", "Frame-stepped video works for web pages and Electron apps, whose time Ensemble can control. Record a desktop app in real time.");
    if (input.steps?.length) throw new CaptureError("not_supported", "Steps work for web pages and Electron apps only.");
    const entry = this.running(this.app(request, target.app, "gui"));
    const grabber = this.grabber(await findFfmpegs());
    const choice = chooseVideoEncoder([{ ...grabber, jpegFrames: true }]);
    if (!choice) throw new CaptureError("unavailable", "The system's ffmpeg has no video encoder.");
    const window = await this.locate(entry, target.window);
    const fps = Math.min(30, Math.max(5, Math.round(input.fps ?? 25)));
    const output = await reserveFile(request.evidenceDir, slugName(input.name, `app-${entry.id}-video`), choice.extension);
    const region = { display: entry.display!.display, ...window };
    const env = virtualDisplayEnv(process.env, entry.display!.env);
    const recorder = spawn(grabber.path, x11RecordArgs({ region, fps, seconds: durationMs / 1000, choice, output }), { env, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    recorder.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4_000) stderr += chunk.toString("utf8");
    });
    const lease = this.leases.add({ kind: "recording", pid: recorder.pid!, label: `recording of ${entry.id}`, operation: request.operation, expiresAt: Date.now() + durationMs + 60_000, parent: entry.leaseId });
    const code = await new Promise<number | null>((resolve) => {
      recorder.once("error", () => resolve(null));
      recorder.once("close", (exit) => resolve(exit));
    });
    await this.leases.end(lease.id, "finished");
    if (code !== 0) throw new CaptureError("failed", `The recording failed: ${stderr.trim().slice(0, 500)}`);
    const probe = await probeVideo(output);
    const base = join(dirname(output), basename(output, extname(output)));
    const posterRun = await runCommand(grabber.path, x11ScreenshotArgs(region, `${base}.poster.png`), { env, timeoutMs: 20_000 });
    const poster = posterRun.code === 0 ? await stillFile(`${base}.poster.png`) : undefined;
    const previewRun = poster
      ? await runCommand(grabber.path, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", poster.path, "-vf", "scale=w=min(320\\,iw):h=-2", "-frames:v", "1", `${base}.preview.png`], { timeoutMs: 20_000 })
      : null;
    const preview = previewRun?.code === 0 ? await stillFile(`${base}.preview.png`) : undefined;
    const { size } = await stat(output);
    return {
      path: output,
      kind: "video",
      mime: choice.mime,
      size,
      width: probe.width,
      height: probe.height,
      durationMs: Math.round(probe.durationMs),
      fps,
      frames: probe.frames,
      codec: choice.codec,
      poster,
      preview,
      held: true,
      reason: UNCHECKED_REASON,
      title: window.title,
    };
  }

  // ── apps ─────────────────────────────────────────────────────────────────

  private running(entry: AppEntry): AppEntry {
    if (entry.ended) throw new CaptureError("failed", `App ${entry.id} is not running any more (${entry.ended}). Start it again.`);
    return entry;
  }

  private app(request: CaptureRequest | string, id: string, kind?: "gui" | "electron"): AppEntry {
    const operation = typeof request === "string" ? request : request.operation;
    const entry = this.apps.get(id);
    if (!entry) throw new CaptureError("not_found", `There is no app ${id}. Start one with capture_app_start.`);
    if (entry.operation !== operation) throw new CaptureError("refused", `App ${id} belongs to other work.`);
    if (kind && entry.kind !== kind) throw new CaptureError("bad_input", `App ${id} is ${entry.kind === "electron" ? "an Electron app" : "a desktop app"}: use target ${entry.kind}.`);
    this.leases.renew(entry.leaseId, this.options.appLeaseMs ?? DEFAULT_APP_LEASE);
    if (entry.display) this.leases.renew(entry.display.lease.id, this.options.appLeaseMs ?? DEFAULT_APP_LEASE);
    return entry;
  }

  private async info(entry: AppEntry): Promise<AppInfo> {
    const lease = this.leases.get(entry.leaseId);
    let window: AppInfo["window"] = null;
    let pid = 0;
    let running = false;
    if (entry.electron) {
      const child = entry.electron.app.process();
      pid = child.pid ?? 0;
      running = child.exitCode === null && child.signalCode === null;
      const page = entry.electron.app.windows()[0];
      if (page) {
        const size = page.viewportSize();
        window = { title: await page.title().catch(() => ""), width: size?.width ?? 0, height: size?.height ?? 0, found: "pid" };
      }
    } else if (entry.process) {
      pid = entry.process.child.pid ?? 0;
      running = entry.process.child.exitCode === null && entry.process.child.signalCode === null;
      if (running && entry.display) {
        const found = await this.locate(entry).catch(() => null);
        if (found) window = { title: found.title, width: found.width, height: found.height, found: found.how };
      }
    }
    return {
      app: entry.id,
      kind: entry.kind,
      pid,
      running,
      display: entry.display?.display ?? null,
      windowManager: entry.display?.windowManager ?? null,
      window,
      ...(entry.electron ? { electronVersion: entry.electron.electron.version } : {}),
      startedAt: new Date(entry.startedAt).toISOString(),
      expiresAt: new Date(lease?.expiresAt ?? entry.startedAt).toISOString(),
    };
  }

  /** Starts an app to capture: on a private virtual display on Linux. Returns its handle. */
  async appStart(request: CaptureRequest, input: AppStartInput): Promise<AppInfo> {
    const kind = input.kind ?? (input.command ? "gui" : "electron");
    if (this.platform === "win32") throw new CaptureError("not_supported", "Capturing desktop apps on Windows is not supported yet.");
    if (kind === "gui" && this.platform !== "linux") throw new CaptureError("not_supported", "Capturing other desktop apps is supported on Linux; on macOS it needs window capture with Screen Recording permission, which Ensemble does not do yet.");
    if (kind === "gui" && !input.command?.trim()) throw new CaptureError("bad_input", "Give the command that starts the app.");
    const leaseMs = Math.min(Math.max(10_000, input.leaseMs ?? this.options.appLeaseMs ?? DEFAULT_APP_LEASE), 24 * 60 * 60_000);
    const linux = this.platform === "linux";
    const display = linux ? await VirtualDisplay.start({ tools: this.tools(), leases: this.leases, stateDir: captureStateDir(this.dataHome()), size: input.size, operation: request.operation, leaseMs }) : null;
    const env = { ...(display ? virtualDisplayEnv(process.env, display.env) : process.env), ...(input.env ?? {}) };
    this.counter += 1;
    const id = `app${this.counter}`;
    try {
      let entry: AppEntry;
      if (kind === "electron") {
        const electron = await startElectron({ appDir: input.cwd, entry: input.entry, args: input.args, env, leases: this.leases, operation: request.operation, leaseMs, parent: display?.lease.id, linux });
        entry = { id, kind, operation: request.operation, cwd: input.cwd, display, electron, leaseId: electron.lease.id, startedAt: Date.now(), title: input.title, ended: null };
      } else {
        const started = await startCommand({ command: input.command!, cwd: input.cwd, env, leases: this.leases, operation: request.operation, leaseMs, parent: display?.lease.id, label: `app ${input.command!.slice(0, 80)}`, wrap: this.options.wrapCommand });
        entry = { id, kind, operation: request.operation, cwd: input.cwd, display, process: started, leaseId: started.lease.id, startedAt: Date.now(), title: input.title, ended: null };
        const self = entry;
        started.child.once("exit", () => {
          // Its lease ends with it (the janitor would notice later); the entry stays for checks.
          if (this.apps.get(id) === self) void this.leases.end(self.leaseId, "app exited");
        });
      }
      this.apps.set(id, entry);
      if (kind === "gui") await this.waitForWindow(entry, input.title, 15_000);
      return this.info(entry);
    } catch (error) {
      if (display) await display.stop("the app did not start");
      throw error;
    }
  }

  private async waitForWindow(entry: AppEntry, title: string | undefined, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && this.apps.has(entry.id) && !entry.ended) {
      const found = await this.locate(entry, title).catch(() => null);
      if (found && found.how !== "display") return;
      await sleep(300);
    }
  }

  private appsOf(operation: string): AppEntry[] {
    return [...this.apps.values()].filter((entry) => entry.operation === operation);
  }

  async listApps(request: CaptureRequest | string): Promise<AppInfo[]> {
    const operation = typeof request === "string" ? request : request.operation;
    return Promise.all(this.appsOf(operation).map((entry) => this.info(entry)));
  }

  private async stopEntry(entry: AppEntry, reason: string): Promise<{ output: string }> {
    this.apps.delete(entry.id);
    const output = (entry.electron?.output ?? entry.process?.output)?.text(40) ?? "";
    if (entry.electron) await entry.electron.app.close().catch(() => undefined);
    await this.leases.end(entry.leaseId, reason);
    if (entry.display) await entry.display.stop(reason);
    return { output };
  }

  async appStop(request: CaptureRequest | string, id: string): Promise<{ app: string; stopped: true; output: string }> {
    const entry = this.app(request, id);
    const { output } = await this.stopEntry(entry, "stopped");
    return { app: id, stopped: true, output };
  }

  /** Ends everything an operation started here (apps, displays); its tabs are the broker's. */
  async release(operation: string): Promise<void> {
    for (const entry of this.appsOf(operation)) await this.stopEntry(entry, "work ended");
    for (const record of this.leases.list(operation)) await this.leases.end(record.id, "work ended");
  }

  // ── checks before sending ────────────────────────────────────────────────

  /** The app is still running after a few seconds, has a window (with the expected title) and printed no crash. */
  async checkApp(request: CaptureRequest | string, id: string, input: { title?: string; aliveMs?: number } = {}): Promise<Check[]> {
    const entry = this.app(request, id);
    const aliveMs = Math.min(Math.max(0, input.aliveMs ?? 3_000), 60_000);
    await sleep(Math.max(0, entry.startedAt + aliveMs - Date.now()));
    const info = await this.info(entry);
    const output = (entry.electron?.output ?? entry.process?.output)?.text(40) ?? "";
    const seconds = `${Math.round(aliveMs / 100) / 10} s`;
    const checks: Check[] = [
      info.running
        ? { name: `The app is still running after ${seconds}`, verdict: "pass", detail: `Process ${info.pid} is running.` }
        : { name: `The app is still running after ${seconds}`, verdict: "fail", detail: `It exited.${output ? ` Last output:\n${output.slice(-1_500)}` : ""}` },
    ];
    const titleWanted = input.title ?? entry.title;
    let windowTitle: string | null = info.window && info.window.found !== "display" ? info.window.title : null;
    if (entry.electron && titleWanted) {
      for (const window of entry.electron.app.windows()) {
        const title = await window.title().catch(() => "");
        if (title.toLowerCase().includes(titleWanted.toLowerCase())) windowTitle = title;
      }
    }
    const windowName = titleWanted ? `A window titled “${titleWanted}” is open` : "A window is open";
    if (windowTitle === null) checks.push({ name: windowName, verdict: "fail", detail: info.running ? "No window appeared." : "The app is not running." });
    else if (titleWanted && !windowTitle.toLowerCase().includes(titleWanted.toLowerCase())) checks.push({ name: windowName, verdict: "fail", detail: `The window is titled “${windowTitle}”.` });
    else checks.push({ name: windowName, verdict: "pass", detail: `“${windowTitle}”${info.window ? ` (${info.window.width}×${info.window.height})` : ""}.` });
    const crash = crashLine(output);
    checks.push(crash ? { name: "No crash in the app's output", verdict: "fail", detail: crash } : { name: "No crash in the app's output", verdict: "pass", detail: output ? "Its output shows no crash." : "It printed nothing." });
    return checks;
  }

  checkImage(path: string, options?: { name?: string; id?: string }): Promise<Check> {
    return checkImage(path, options);
  }

  /** The page (a URL, a tab or an Electron window) shows every expected string, in its text or accessible names. */
  async checkText(request: CaptureRequest, target: { url?: string; tab?: string; app?: string; window?: string }, expected: string[], options: { name?: string; id?: string } = {}): Promise<Check> {
    const read = async (page: Page) => {
      const rules: PrivacyRules = await this.broker.privacyRules();
      const scan = await scanPage(page, rules);
      if (scan.site === "never") throw new CaptureError("refused", "The owner marked this site as never captured.");
      const visible = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
      const aria = await page.ariaSnapshot({ timeout: 10_000 }).catch(() => "");
      return `${await page.title().catch(() => "")}\n${visible}\n${aria}`;
    };
    if (target.app) return checkTextIn(await read(await this.electronWindow(this.running(this.app(request, target.app, "electron")), target.window)), expected, options);
    if (target.tab) return checkTextIn(await read(this.broker.pageFor(request.operation, target.tab)), expected, options);
    if (!target.url) throw new CaptureError("bad_input", "Give a url, a tab or an app.");
    const op = this.internal(request);
    try {
      const opened = await wrapBrowser(() => this.broker.open(op, target.url!, { private: true }));
      if (opened.error) return { ...(options.id ? { id: options.id } : {}), name: options.name ?? "Shows the expected text", verdict: "fail", detail: `The page did not open: ${opened.error}` };
      const page = this.broker.pageFor(op, opened.tab);
      await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => undefined);
      return checkTextIn(await read(page), expected, options);
    } finally {
      await this.broker.release(op);
    }
  }
}

/** A file name for a page: its host, with loopback addresses called localhost. */
function pageName(url: string): string {
  try {
    const host = new URL(url).hostname;
    return /^(localhost|127(\.\d+){3}|\[::1\])$/.test(host) ? "localhost" : slugName(host.replace(/\./g, "-"), "page");
  } catch {
    return "page";
  }
}

function desktopUnsupported(): CaptureError {
  return new CaptureError("not_supported", "Capturing your real screen is not supported yet. When it is, it will ask for your consent each time (the desktop portal on Wayland, Screen Recording permission on macOS).");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Broker errors keep their message; their codes map onto capture's. */
async function wrapBrowser<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BrowserError) {
      const code = error.code === "sensitive" ? "sensitive" : error.code === "not_found" ? "not_found" : error.code === "bad_input" ? "bad_input" : error.code === "unavailable" ? "unavailable" : error.code === "refused" || error.code === "not_yours" ? "refused" : "failed";
      throw new CaptureError(code, error.message);
    }
    throw error;
  }
}

/** Deletes a video and its poster and preview. */
async function removeMedia(file: MediaFile | undefined): Promise<void> {
  if (!file) return;
  for (const path of [file.path, file.poster?.path, file.preview?.path]) if (path) await rm(path, { force: true });
}
