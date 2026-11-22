/**
 * The desktop helper's protocol (protocol.ts) on top of cua-driver (MIT, github.com/trycua/cua), for macOS
 * (macos-cua.ts) and Windows (windows-cua.ts): DesktopService runs on top unchanged. One method becomes one or a
 * few MCP tool calls over the driver's stdin and stdout (mcp-stdio.ts):
 *
 * - screenshots: `get_desktop_state` (the main display, PNG); crops, sizes and hashes in png.ts;
 * - elements: `list_apps`, `list_windows`, `get_window_state` (element tokens kept per look), and `click`,
 *   `set_value`, `type_text`, `press_key`, `hotkey`, `scroll` on a token, in the background;
 * - the owner's pointer and keyboard: the same tools with `scope: "desktop"` (screen pixels, the app in front);
 * - recording: `start_recording`/`stop_recording`.
 *
 * Each action's own account of what it did (`effect`) comes back with its answer; a refusal is a typed error
 * that says nothing ran. What differs by system (grants, idle time and the lock, notices, browsers, element
 * roles, key names, prompts, screen units, recording) is the subclass's.
 */
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isBrowserToolkit, keyboardFloor } from "../floor.js";
import type { HelperCommand, HelperHealth } from "../helper-process.js";
import { fit } from "../mapping.js";
import { HelperError, type CaptureResult, type Fact, type FocusInfo, type HelperApp, type HelperElement, type HelperErrorKind, type Ran, type SessionInfo, type StatusResult, type Stream, type TreeResult } from "../protocol.js";
import { McpStdioClient, type McpResult } from "./mcp-stdio.js";
import { mp4Facts } from "./mp4.js";
import { cropPixels, decodePng, encodePng, hashBytes, pngSize, shrinkPixels } from "./png.js";

export type CuaAdapterOptions = {
  /** How to start cua-driver here, or why it cannot run. */
  spawn: () => HelperCommand | { unavailable: string };
  /** The cua-driver version this Ensemble is built for: any other is not used. */
  version: string;
  /** A private folder for screenshots in flight and recordings before they are saved. */
  workDir: string;
  log?: (message: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  helloTimeoutMs?: number;
  maxRestarts?: number;
  restartWindowMs?: number;
  stopGraceMs?: number;
};

/** The one display cua-driver captures and aims at: the main one. */
export const MAIN = 1;
/** The long side of the small captures that tell whether the screen changed. */
const PROBE_EDGE = 400;
/** Characters typed at a time; between chunks, the window in front and the owner's input are checked. */
export const TYPING_CHUNK = 8;
/** The pause after each typed chunk before the owner's input is read. */
const TYPING_PAUSE_MS = 120;
/** Idle time this much shorter than the time since the last key means someone else's input. */
const OWNER_INPUT_MARGIN_MS = 40;
/** Between chunks the window on top is checked; every this many chunks also the app in front. */
const TYPING_FULL_CHECK = 4;
/** Typing stops while this much more than one chunk's time is left, to answer before the request's end. */
const TYPING_RESERVE_MS = 500;

export const obj = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
export const arr = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value.map(obj) : []);
export const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
export const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export type RunningApp = { pid: number; name: string; bundle: string | null; active: boolean; launchPath: string | null };
export type Win = { id: number; pid: number; app: string; title: string; bounds: { x: number; y: number; width: number; height: number } | null; onScreen: boolean; minimized: boolean; z: number | null; layer: number };
type Tree = { pid: number; windowId: number; app: string; tokens: Map<string, string>; actions: Map<string, string[]> };
type Recording = { id: string; dir: string; path: string; active: boolean; reason: string | null; video: string | null; timer: NodeJS.Timeout | null; startedAt: number };
/**
 * One request: its end, the signal that its work ended (its caller let go), the stops it began after, and whether
 * it acted on the desktop yet (so a request cut short says it ran).
 */
export type Ctx = { until: number; signal?: AbortSignal; stops: number; sent: boolean };
export type Front = { apps: RunningApp[]; wins: Win[]; app: RunningApp | null; top: Win | null; prompt: { title: string } | null };
/** Why typing ended before the end of the text (the service says each in its words). */
type TypingStop = "focus_moved" | "owner_input" | "out_of_time" | "cancelled";
export type Shot = { png: Buffer; size: { width: number; height: number }; native: { width: number; height: number } };
/** Idle time and the lock; `why` says what holds the screen when it is not the lock screen (User Account Control). */
export type IdleState = { locked: boolean | null; idle_ms: number | null; why?: string };

/** An app from `list_apps`: an installed app that is not running has pid 0. */
function appOf(item: Record<string, unknown>): RunningApp | null {
  const pid = num(item.pid) ?? 0;
  const name = str(item.name);
  if (!name || (item.running === true && pid <= 0)) return null;
  return { pid, name, bundle: str(item.bundle_id), active: item.active === true, launchPath: str(item.launch_path) };
}

export function winOf(item: Record<string, unknown>): Win | null {
  const id = num(item.window_id);
  const pid = num(item.pid);
  if (id === null || pid === null) return null;
  const bounds = obj(item.bounds);
  const [x, y, width, height] = [num(bounds.x), num(bounds.y), num(bounds.width), num(bounds.height)];
  return {
    id,
    pid,
    app: str(item.app_name) ?? "",
    title: typeof item.title === "string" ? item.title : "",
    bounds: x !== null && y !== null && width !== null && height !== null ? { x, y, width, height } : null,
    onScreen: item.is_on_screen !== false,
    minimized: item.minimized === true,
    z: num(item.z_index),
    layer: num(item.layer) ?? 0,
  };
}

/** A failure once typing began: it ran, and says how much went in (at least that much when a chunk was in flight). */
function typingFailed(error: unknown, typed: number, total: number, inFlight: boolean): HelperError {
  const known = error instanceof HelperError ? error : null;
  const why = (known?.message ?? (error instanceof Error ? error.message : "Typing failed.")).slice(0, 300);
  const count = `${inFlight ? "at least " : ""}${typed} of ${total} characters`;
  return new HelperError(known?.kind ?? "input_failed", `Typing stopped after ${count} (the rest was not typed): ${why}`, "yes", false, { ...known?.data, typed: { keysym: typed, atspi: 0, clipboard: 0, untyped: 0 }, total, stopped: known?.kind ?? "failed" });
}

/** One account for text typed in chunks: confirmed when every chunk was, a mix of taken and not taken is partial. */
function overall(effects: readonly string[]): string {
  if (!effects.length) return "unverifiable";
  if (effects.every((effect) => effect === effects[0])) return effects[0]!;
  const missed = effects.some((effect) => effect === "partial" || effect === "suspected_noop");
  const took = effects.some((effect) => effect === "confirmed" || effect === "partial");
  return missed && took ? "partial" : "unverifiable";
}

/** Front first; a window whose order is unknown goes last. */
export const byFront = (a: Win, b: Win) => (b.z ?? -Infinity) - (a.z ?? -Infinity);

/** The window on top of all others that show (the one the keyboard goes to unless an app without windows is in front). */
export const topWindow = (wins: readonly Win[]) => wins.filter((win) => win.layer === 0 && win.onScreen && !win.minimized).sort(byFront)[0] ?? null;
const sameWindow = (a: Win | null, b: Win | null) => (a === null || b === null ? a === b : a.id === b.id && a.pid === b.pid);

export function textOf(result: McpResult | null | undefined): string | null {
  const text = (result?.content ?? [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text!)
    .join(" ")
    .replace(/^[✅❌⚠️\s]+/u, "")
    .trim();
  return text ? text.slice(0, 400) : null;
}

function imageOf(result: McpResult | null | undefined): Buffer | null {
  const item = (result?.content ?? []).find((entry) => entry?.type === "image" && typeof entry.data === "string");
  return item ? Buffer.from(item.data!, "base64") : null;
}

/** How much smaller than the screen a `get_desktop_state` picture is, as cua-driver works it out; null for full size. */
function shrinkOf(data: Record<string, unknown>): { x: number; y: number } | null {
  const [width, height, fullWidth, fullHeight] = [num(data.screenshot_width), num(data.screenshot_height), num(data.screenshot_original_width), num(data.screenshot_original_height)];
  if (!width || !height || !fullWidth || !fullHeight || width <= 0 || height <= 0 || fullWidth <= 0 || fullHeight <= 0) return null;
  const shrunk = { x: fullWidth / width, y: fullHeight / height };
  return shrunk.x === 1 && shrunk.y === 1 ? null : shrunk;
}

const NEEDS_SCREEN_CODES = new Set(["background_unavailable", "background_occluded", "select_menu_would_raise_window", "window_not_key", "target_focus_unconfirmed", "foreground_required"]);
const GONE_CODES = new Set(["stale_element_token", "stale_bare_row", "window_target_not_found", "window_id_not_found", "window_owner_pid_mismatch", "element_not_found", "stale_snapshot"]);
const CONSENT_CODES = new Set(["automation_consent_required", "permission_required", "accessibility_not_granted", "screen_recording_not_granted", "accessibility_permission_missing", "screen_recording_permission_missing"]);
const NOT_FOUND_CODES = new Set(["APP_NOT_INSTALLED", "APP_NAME_AMBIGUOUS", "ambiguous_window_target", "app_not_found", "pid_not_found"]);
/** A window of an app with more rights than the driver (an app run as administrator): Windows keeps its input from it. */
const ELEVATED_CODES = new Set(["background_uipi_blocked"]);

function kindOf(code: string | null, text: string, effects: boolean): HelperErrorKind {
  if (code && NEEDS_SCREEN_CODES.has(code)) return "needs_screen";
  if (code && GONE_CODES.has(code)) return "element_gone";
  if (code && CONSENT_CODES.has(code)) return "consent_needed";
  if (code && NOT_FOUND_CODES.has(code)) return "target_not_found";
  if (code && ELEVATED_CODES.has(code)) return "unsupported_here";
  if (code === "invalid_arguments" || code === "desktop_scope_disabled" || code === "invalid_target") return "invalid_params";
  if (code === "no_focused_text_input" || code === "delivery_failed") return "input_failed";
  if (/(accessibility|screen recording|screen capture)/i.test(text) && /(not granted|not trusted|not allowed|permission|denied|blocked)/i.test(text)) return "consent_needed";
  return effects ? "input_failed" : "internal";
}

export abstract class CuaAdapter extends EventEmitter {
  protected readonly mcp: McpStdioClient;
  protected session: { epoch: number; stream: Stream } | null = null;
  protected epoch = 0;
  private seq = 0;
  /** Screen pixels per point on the main display, from its latest screenshot. */
  protected scale = 1;
  private readonly trees = new Map<string, Tree>();
  private treeCount = 0;
  /** How many times `stop` was called: a request that began before the latest goes no further. */
  private stops = 0;
  /** Screenshots come back in the answer rather than through a file (after the driver refused the file once). */
  private inlineShots = false;
  /**
   * The full size over the size of the latest screenshot when it was made smaller (`max_image_dimension`): the
   * driver multiplies a later desktop action's x and y by it, as if they were read off that picture.
   */
  private shrunk: { x: number; y: number } | null = null;
  protected recording: Recording | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  /** The page a window showed in its latest look, where its elements said (`pid:window`). */
  private readonly pages = new Map<string, { app: string; url: string; title: string }>();
  protected readonly proven: Record<"capture" | "input", Fact> = {
    capture: { state: "untested", detail: "No screenshot has been taken yet." },
    input: { state: "untested", detail: "Nothing has been pressed or typed yet." },
  };

  /** The system's name in what the agent is told ("macOS", "Windows"). */
  protected abstract readonly system: string;

  constructor(protected readonly base: CuaAdapterOptions & { label: string }) {
    super();
    this.mcp = new McpStdioClient({
      spawn: base.spawn,
      version: base.version,
      label: base.label,
      log: base.log,
      now: base.now,
      helloTimeoutMs: base.helloTimeoutMs,
      maxRestarts: base.maxRestarts,
      restartWindowMs: base.restartWindowMs,
      stopGraceMs: base.stopGraceMs,
    });
    this.mcp.on("exit", (info: { code: number | null; signal: string | null; expected: boolean }) => this.onExit(info));
  }

  // ── what each system does its own way ────────────────────────────────────

  protected abstract status(ctx: Ctx): Promise<StatusResult>;
  /** Screen control starts once a real screenshot proves it. */
  protected abstract sessionStart(ctx: Ctx): Promise<SessionInfo>;
  protected abstract idle(): Promise<IdleState>;
  /** How long ago anyone last used the keyboard or mouse; null when not known. */
  protected abstract idleMs(): Promise<number | null>;
  protected abstract notice(params: Record<string, unknown>): Promise<{ shown: boolean }>;
  /** Throws when reading and pressing elements cannot work here now (a grant is off). */
  protected abstract needAccessibility(ctx: Ctx): Promise<void>;
  /** An app's toolkit (a browser's engine, `Web`, or the system's name), from its identity and its windows. */
  protected abstract toolkitOf(app: RunningApp, wins: readonly Win[]): string;
  /** An app's id for the floor and the asks. */
  protected abstract appIdOf(app: RunningApp, wins: readonly Win[]): string | null;
  /** One accessibility element in the helper's words: AT-SPI-like roles, a name, states, actions and its box inside the window. */
  protected abstract element(item: Record<string, unknown>, id: string, origin: { x: number; y: number }): HelperElement | null;
  /** `ctrl+s`, `Return`: modifiers and a key in this driver's names. */
  protected abstract parseKeys(combo: string): { modifiers: string[]; key: string };
  /** Whether a window of this app is a password or permission prompt of the system. */
  protected abstract promptApp(app: string): boolean;
  /** The display's full size in pixels, from `get_desktop_state`'s facts and the picture's size. */
  protected abstract nativeSize(data: Record<string, unknown>, size: { width: number; height: number }): { width: number; height: number };
  /** Screen pixels per unit of the windows' bounds. */
  protected abstract boundsScale(): number;
  /** Why recording the screen cannot work here, or null. */
  protected abstract recordingUnavailable(): string | null;
  /** `launch_app`'s arguments for an app from `list_apps` (or the name asked for). */
  protected abstract launchArgs(found: RunningApp | null, ref: string): Record<string, unknown>;

  /** Before apps are listed (macOS reads which apps open web links). */
  protected async beforeApps(): Promise<void> {}

  /** Whether opening an app that runs with a window uses it rather than launching it again. */
  protected reuseRunning(): boolean {
    return false;
  }

  /** A missing grant: the agent's words and the fix (macOS). */
  protected consentError(code: string | null, text: string, ran: Ran): HelperError {
    return new HelperError("consent_needed", text.slice(0, 300), ran, false, code ? { code } : {});
  }

  /** Rows of a small screenshot left out of "did the screen change" (a clock in a menu bar or task bar). */
  protected probeRows(height: number): { top: number; bottom: number } {
    return { top: Math.ceil(height * 0.04), bottom: 0 };
  }

  /** A password or permission prompt of the system that shows now, from the windows. */
  protected async promptOf(apps: readonly RunningApp[], wins: readonly Win[]): Promise<{ title: string } | null> {
    const names = new Map(apps.map((item) => [item.pid, item.name]));
    const prompt = wins.find((win) => win.onScreen && this.promptApp(win.app || names.get(win.pid) || ""));
    return prompt ? { title: prompt.title || "Authentication" } : null;
  }

  /** The quick check between typed chunks: a prompt among the windows that show. */
  protected async promptShown(wins: readonly Win[]): Promise<boolean> {
    return wins.some((win) => win.onScreen && this.promptApp(win.app));
  }

  /** The address of the page an app's window shows, when its elements say (a web document's value). */
  protected pageOf(_elements: ReadonlyArray<Record<string, unknown>>): string | null {
    return null;
  }

  // ── the process ──────────────────────────────────────────────────────────

  protected now(): number {
    return (this.base.now ?? Date.now)();
  }

  protected sleep(ms: number): Promise<void> {
    return this.base.sleep ? this.base.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms).unref?.());
  }

  health(): HelperHealth {
    return this.mcp.health();
  }

  protected onExit(info: { code: number | null; signal: string | null; expected: boolean }): void {
    this.session = null;
    this.shrunk = null;
    this.trees.clear();
    this.pages.clear();
    const recording = this.recording;
    if (recording) {
      if (recording.timer) clearTimeout(recording.timer);
      this.recording = null;
      void rm(recording.dir, { recursive: true, force: true }).catch(() => undefined);
    }
    this.emit("exit", info);
  }

  /**
   * Ends the driver. A request under way goes no further (typing stops before its next chunk), and one still
   * running after the grace (4 s, like the Linux helper's) ends with the driver, killed.
   */
  async stop(): Promise<void> {
    this.stops += 1;
    let grace: NodeJS.Timeout | undefined;
    const quiet = await Promise.race([
      this.chain.then(() => true),
      new Promise<boolean>((resolve) => {
        grace = setTimeout(() => resolve(false), this.base.stopGraceMs ?? 4_000);
        grace.unref?.();
      }),
    ]);
    clearTimeout(grace);
    if (!quiet) await this.mcp.kill();
    await this.serial(async () => {
      const recording = this.recording;
      if (recording?.active && this.mcp.running) await this.mcp.call("stop_recording", {}, { timeoutMs: 10_000 }).catch(() => undefined);
    }).catch(() => undefined);
    this.session = null;
    await this.mcp.stop();
  }

  /** One request of the helper protocol, after the one before it is done. */
  call<T>(method: string, params: Record<string, unknown>, options: { timeoutMs: number; effects?: boolean; signal?: AbortSignal }): Promise<T> {
    const ctx: Ctx = { until: this.now() + options.timeoutMs, signal: options.signal, stops: this.stops, sent: false };
    if (options.signal?.aborted) return Promise.reject(new HelperError("cancelled", "The work this request was for ended.", "no"));
    return this.serial(() => (this.ended(ctx) ? Promise.reject(this.cancelled(ctx)) : this.dispatch(method, params, ctx))) as Promise<T>;
  }

  /** Whether a request should go no further: the work it was for ended, or desktop control stopped since it began. */
  protected ended(ctx: Ctx): boolean {
    return ctx.signal?.aborted === true || ctx.stops !== this.stops;
  }

  private cancelled(ctx: Ctx): HelperError {
    return new HelperError("cancelled", ctx.stops !== this.stops ? "Desktop control stopped during this request." : "The work this request was for ended.", ctx.sent ? "yes" : "no");
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private dispatch(method: string, params: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
    switch (method) {
      case "status":
        return this.status(ctx);
      case "session.start":
        return this.sessionStart(ctx);
      case "session.stop":
        this.session = null;
        return Promise.resolve({ state: "off" });
      case "idle":
        return this.idle();
      case "notify":
        return this.notice(params);
      case "frame.capture":
        return this.capture(params, ctx);
      case "frame.state":
        return this.probe(ctx).then((hash) => ({ display: MAIN, seq: this.seq, hash }));
      case "frame.settle":
        return this.settle(num(params.min_ms) ?? 0, num(params.timeout_ms) ?? 1_000, ctx).then(({ settled, hash }) => ({ settled, hash }));
      case "a11y.apps":
        return this.appList(ctx);
      case "a11y.focus":
        return this.focus(params, ctx);
      case "a11y.tree":
        return this.tree(params, ctx);
      case "a11y.do":
        return this.elementAction(params, ctx);
      case "apps.catalog":
        return this.catalog(params, ctx);
      case "apps.launch":
        return this.launch(params, ctx);
      case "apps.focus":
        return this.bringToFront(params, ctx);
      case "input.pointer":
        return this.pointer(params, ctx);
      case "input.drag":
        return this.drag(params, ctx);
      case "input.scroll":
        return this.scroll(params, ctx);
      case "input.keys":
        return this.keys(params, ctx);
      case "input.text":
        return this.text(params, ctx);
      case "record.start":
        return this.recordStart(params, ctx);
      case "record.stop":
        return this.recordStop(params, ctx);
      case "record.discard":
        return this.recordDiscard(params, ctx);
      case "media.check":
        return this.mediaCheck(params);
      default:
        return Promise.reject(new HelperError("method_not_found", `${method} is not available on ${this.system}.`, "no"));
    }
  }

  // ── tool calls ───────────────────────────────────────────────────────────

  /** One tool call within the request's time; a failure or refusal becomes a typed error. */
  protected async tool(name: string, args: Record<string, unknown>, ctx: Ctx, effects = false): Promise<{ data: Record<string, unknown>; result: McpResult }> {
    if (this.ended(ctx)) throw this.cancelled(ctx);
    const left = ctx.until - this.now();
    if (left < 300) throw new HelperError("timeout", "Desktop control ran out of time for this request.", ctx.sent ? "yes" : "no", true);
    const result = await this.mcp.call(name, this.screenPoints(args), { timeoutMs: left, effects });
    const data = obj(result?.structuredContent);
    if (name === "get_desktop_state" && !result?.isError) this.shrunk = shrinkOf(data);
    const refused = data.effect === "refused" || data.status === "refused";
    if (!result?.isError && !refused) {
      if (effects) ctx.sent = true;
      return { data, result };
    }
    throw this.failure(name, result, data, effects);
  }

  private failure(name: string, result: McpResult, data: Record<string, unknown>, effects: boolean): HelperError {
    const error = obj(data.error);
    const refusal = obj(data.refusal);
    const code = str(error.code) ?? str(refusal.code) ?? str(data.code) ?? str(data.error);
    const text = str(error.hint) ?? str(refusal.message) ?? textOf(result) ?? str(data.hint) ?? `${name} failed.`;
    const kind = kindOf(code, text, effects);
    // A refusal is decided before anything is sent; a bare failure of an action may have gone part way.
    const ran: Ran = code !== null || data.effect === "refused" || data.status === "refused" || !effects ? "no" : "maybe";
    if (kind === "consent_needed") return this.consentError(code, text, ran);
    if (code && ELEVATED_CODES.has(code)) {
      return new HelperError(kind, "That window belongs to an app running as administrator: Windows keeps other apps' input from it, so desktop control cannot act there. Hand it to your owner with desktop_handoff.", ran, false, { code });
    }
    const hint = kind === "needs_screen" ? " It needs the owner's screen: run it in the foreground (foreground: true asks them once)." : kind === "element_gone" ? " Look again: the element changed or is gone." : "";
    return new HelperError(kind, `${text.slice(0, 300)}${hint}`, ran, false, code ? { code } : {});
  }

  /** A desktop action's x and y in the latest screenshot's pixels, so that the driver's scaling gives screen pixels. */
  private screenPoints(args: Record<string, unknown>): Record<string, unknown> {
    const shrunk = this.shrunk;
    if (!shrunk || (args.scope !== "desktop" && args.coordinate_frame !== "desktop") || args.capture_id !== undefined) return args;
    const out = { ...args };
    for (const key of ["x", "from_x", "to_x"]) if (typeof out[key] === "number") out[key] = (out[key] as number) / shrunk.x;
    for (const key of ["y", "from_y", "to_y"]) if (typeof out[key] === "number") out[key] = (out[key] as number) / shrunk.y;
    return out;
  }

  /** The schema property this cua-driver uses for screen coordinates of the main display. */
  protected desktop(tool: string): Record<string, unknown> {
    if (!this.mcp.takes(tool, "scope") && this.mcp.takes(tool, "target")) return { target: { kind: "desktop", display_id: "primary" } };
    return { scope: "desktop" };
  }

  /** The owner's pointer goes where it is told even over an app that is not in front. */
  private foreground(tool: string): Record<string, unknown> {
    return this.mcp.takes(tool, "delivery_mode") ? { delivery_mode: "foreground" } : {};
  }

  protected needSession(): { epoch: number; stream: Stream } {
    if (!this.session) throw new HelperError("no_session", "Screen control is not on.", "no");
    return this.session;
  }

  // ── the session ──────────────────────────────────────────────────────────

  /** A screenshot proved screen control: it starts with that display. */
  protected begin(native: { width: number; height: number }): SessionInfo {
    this.proven.capture = { state: "working", detail: `${native.width}×${native.height} pixels` };
    this.epoch += 1;
    this.session = { epoch: this.epoch, stream: this.streamOf(native) };
    return { state: "on", epoch: this.epoch, streams: [this.session.stream] };
  }

  protected sessionView(): StatusResult["session"] {
    return { state: this.session ? "on" : "off", epoch: this.session?.epoch ?? this.epoch, ...(this.session ? { streams: [this.session.stream] } : {}) };
  }

  protected recordingsView(): StatusResult["recordings"] {
    const recording = this.recording;
    return recording ? [{ id: recording.id, active: recording.active, wall_ms: this.now() - recording.startedAt }] : [];
  }

  private streamOf(native: { width: number; height: number }): Stream {
    return { node: MAIN, x: 0, y: 0, width: native.width, height: native.height, frame_width: native.width, frame_height: native.height, name: "main", primary: true, scale: this.scale };
  }

  /** A screenshot of a size other than the session's means the display changed: screen control starts over with it. */
  private track(native: { width: number; height: number }): void {
    const session = this.session;
    if (!session || (session.stream.width === native.width && session.stream.height === native.height)) return;
    this.epoch += 1;
    this.session = { epoch: this.epoch, stream: this.streamOf(native) };
    this.emit("event", { kind: "session.started", epoch: this.epoch, streams: [this.session.stream] });
  }

  // ── screenshots ──────────────────────────────────────────────────────────

  /** The main display as a PNG, its long side at most `edge` (0: full size), and its full size in pixels. */
  protected async grab(edge: number, ctx: Ctx): Promise<Shot> {
    const shots = join(this.base.workDir, "shots");
    await mkdir(shots, { recursive: true, mode: 0o700 });
    const out = join(shots, `shot-${randomBytes(6).toString("hex")}.png`);
    const toFile = !this.inlineShots && this.mcp.takes("get_desktop_state", "screenshot_out_file");
    const dimension = { max_image_dimension: Math.max(0, Math.round(edge)) };
    try {
      let answer: { data: Record<string, unknown>; result: McpResult };
      try {
        answer = await this.tool("get_desktop_state", { ...dimension, ...(toFile ? { screenshot_out_file: out } : {}) }, ctx);
      } catch (error) {
        if (!toFile || !(error instanceof HelperError) || (error.kind !== "internal" && error.kind !== "invalid_params")) throw error;
        this.inlineShots = true;
        answer = await this.tool("get_desktop_state", dimension, ctx);
      }
      const { data, result } = answer;
      const png = (toFile && !this.inlineShots ? await readFile(out).catch(() => null) : null) ?? imageOf(result);
      const size = png ? pngSize(png) : null;
      if (!png || !size) throw new HelperError("capture_failed", "The screenshot came back empty.", "no", true);
      const scale = num(data.scale_factor);
      if (scale && scale > 0) this.scale = scale;
      return { png, size, native: this.nativeSize(data, size) };
    } finally {
      await rm(out, { force: true }).catch(() => undefined);
    }
  }

  /** A hash of a small screenshot without the rows a clock is in (it would count as a change). */
  private async probe(ctx: Ctx): Promise<number> {
    this.needSession();
    const shot = await this.grab(PROBE_EDGE, ctx);
    const pixels = decodePng(shot.png);
    const { top, bottom } = this.probeRows(pixels.height);
    return hashBytes(pixels.data.subarray(top * pixels.width * 4, Math.max(top, pixels.height - bottom) * pixels.width * 4));
  }

  private async settle(minMs: number, timeoutMs: number, ctx: Ctx): Promise<{ settled: boolean; hash: number; waited: number }> {
    const started = this.now();
    const until = Math.min(started + Math.max(0, timeoutMs), ctx.until - 2_000);
    if (minMs > 0) await this.sleep(Math.min(minMs, Math.max(0, until - this.now())));
    let last = await this.probe(ctx);
    while (this.now() < until) {
      await this.sleep(120);
      const next = await this.probe(ctx);
      if (next === last) return { settled: true, hash: next, waited: this.now() - started };
      last = next;
    }
    return { settled: false, hash: last, waited: this.now() - started };
  }

  private async capture(params: Record<string, unknown>, ctx: Ctx): Promise<CaptureResult> {
    const session = this.needSession();
    const edge = Math.max(0, num(params.max_long_edge) ?? 1568);
    const settle = obj(params.settle);
    let settled: boolean | null = null;
    let waited = 0;
    if (num(settle.timeout_ms) !== null) ({ settled, waited } = await this.settle(num(settle.min_ms) ?? 0, num(settle.timeout_ms)!, ctx));
    const crop = Array.isArray(params.crop) && params.crop.length === 4 && params.crop.every((value) => typeof value === "number") ? (params.crop as number[]) : null;
    let png: Buffer;
    let native: { width: number; height: number };
    let region: [number, number, number, number];
    if (crop) {
      const full = await this.grab(0, ctx);
      native = full.native;
      const pixels = decodePng(full.png);
      const part = cropPixels(pixels, { x: (crop[0]! * pixels.width) / native.width, y: (crop[1]! * pixels.height) / native.height, width: (crop[2]! * pixels.width) / native.width, height: (crop[3]! * pixels.height) / native.height });
      const size = edge > 0 ? fit(part, edge) : part;
      png = encodePng(shrinkPixels(part, size.width, size.height));
      const x = Math.min(Math.max(0, crop[0]!), native.width - 1);
      const y = Math.min(Math.max(0, crop[1]!), native.height - 1);
      region = [x, y, Math.min(Math.max(1, crop[2]!), native.width - x), Math.min(Math.max(1, crop[3]!), native.height - y)];
    } else {
      const shot = await this.grab(edge, ctx);
      native = shot.native;
      png = shot.png;
      region = [0, 0, native.width, native.height];
    }
    this.track(native);
    const size = pngSize(png)!;
    let path: string | undefined;
    if (typeof params.save_path === "string" && params.save_path) {
      // cua-driver captures PNG: the picture keeps its own format, and its path says so.
      path = params.save_path.replace(/\.jpe?g$/i, ".png");
      await writeFile(path, png, { mode: 0o600 });
    }
    this.proven.capture = { state: "working", detail: `${native.width}×${native.height} pixels` };
    this.seq += 1;
    return {
      display: MAIN,
      epoch: this.session?.epoch ?? session.epoch,
      image: { width: size.width, height: size.height, mime: "image/png", bytes: png.length, ...(path ? { path } : {}), ...(params.inline ? { base64: png.toString("base64") } : {}) },
      frame: native,
      region,
      hash: hashBytes(png),
      seq: this.seq,
      settled,
      waited_ms: Math.round(waited),
      at: this.now(),
    };
  }

  // ── apps, windows and elements ───────────────────────────────────────────

  protected async apps(ctx: Ctx, running = true): Promise<Array<RunningApp & { item: Record<string, unknown> }>> {
    const { data } = await this.tool("list_apps", {}, ctx);
    const out: Array<RunningApp & { item: Record<string, unknown> }> = [];
    for (const item of arr(data.apps)) {
      if (running && item.running !== true) continue;
      const app = appOf(item);
      if (app) out.push({ ...app, item });
    }
    return out;
  }

  protected async windows(ctx: Ctx, pid?: number, onScreenOnly = false): Promise<Win[]> {
    const args = { ...(pid !== undefined ? { pid } : {}), ...(onScreenOnly && this.mcp.takes("list_windows", "on_screen_only") ? { on_screen_only: true } : {}) };
    const { data } = await this.tool("list_windows", args, ctx);
    return arr(data.windows)
      .map(winOf)
      .filter((win): win is Win => win !== null);
  }

  /** An app with its own windows, front first; window boxes in screen pixels, for the floor's "which window is at this point". */
  protected helperApp(app: RunningApp, wins: readonly Win[]): HelperApp {
    const own = wins.filter((win) => win.pid === app.pid && win.layer === 0).sort(byFront);
    const front = own.find((win) => win.onScreen && !win.minimized);
    const s = this.boundsScale();
    return {
      name: app.name,
      toolkit: this.toolkitOf(app, wins),
      pid: app.pid,
      app_id: this.appIdOf(app, wins),
      windows: own.map((win, index) => ({
        index,
        title: win.title,
        role: "window",
        active: app.active && win === front,
        showing: win.onScreen && !win.minimized,
        iconified: win.minimized,
        box: win.bounds ? [Math.round(win.bounds.x * s), Math.round(win.bounds.y * s), Math.round(win.bounds.width * s), Math.round(win.bounds.height * s)] : null,
        z: win.z,
      })),
    };
  }

  private async appList(ctx: Ctx): Promise<{ apps: HelperApp[]; units: number }> {
    await this.beforeApps();
    const [apps, wins] = [await this.apps(ctx), await this.windows(ctx)];
    return { apps: apps.map((app) => this.helperApp(app, wins)), units: apps.length };
  }

  /** The app in front, its window in front (the top one that shows), and a password prompt of the system if one shows. */
  protected async front(ctx: Ctx): Promise<Front> {
    await this.beforeApps();
    const [apps, wins] = [await this.apps(ctx), await this.windows(ctx)];
    const app = apps.find((item) => item.active) ?? null;
    const top = app ? (wins.filter((win) => win.pid === app.pid && win.layer === 0 && win.onScreen && !win.minimized).sort(byFront)[0] ?? null) : null;
    return { apps, wins, app, top, prompt: await this.promptOf(apps, wins) };
  }

  protected focusOf(front: Front, documents: boolean): FocusInfo {
    const { apps, wins, app, top, prompt } = front;
    const pages: NonNullable<FocusInfo["documents"]> = [];
    if (documents) {
      // cua-driver does not read a browser's address, so every window of a browser is a page that cannot be read:
      // also one that is minimised, hidden or on another Space, where an element can still be pressed. Which one
      // the keyboard reaches comes from what shows in front.
      for (const browser of apps.filter((item) => isBrowserToolkit(this.toolkitOf(item, wins)))) {
        const own = wins.filter((win) => win.pid === browser.pid && win.layer === 0).sort(byFront);
        const shown = own.find((win) => win.onScreen && !win.minimized) ?? null;
        for (const win of own) pages.push({ app: browser.name, url: null, window: win.title, active: browser === app && win === shown });
      }
      // Another app's window whose elements showed a web page in its latest look (a web view): that page's address.
      for (const other of apps.filter((item) => !isBrowserToolkit(this.toolkitOf(item, wins)))) {
        const own = wins.filter((win) => win.pid === other.pid && win.layer === 0).sort(byFront);
        const shown = own.find((win) => win.onScreen && !win.minimized) ?? null;
        for (const win of own) {
          const page = this.pages.get(`${win.pid}:${win.id}`);
          if (page) pages.push({ app: other.name, url: page.url, window: win.title, active: other === app && win === shown });
        }
      }
    }
    return {
      app: app ? { name: app.name, toolkit: this.toolkitOf(app, wins), pid: app.pid, app_id: this.appIdOf(app, wins) } : null,
      window: top ? { index: 0, title: top.title, role: "window" } : null,
      shell: false,
      prompt,
      // cua-driver does not say here which element has the keyboard.
      focused: null,
      documents: pages,
    };
  }

  private async focus(params: Record<string, unknown>, ctx: Ctx): Promise<FocusInfo> {
    return this.focusOf(await this.front(ctx), params.documents === true);
  }

  protected resolve(apps: readonly RunningApp[], ref: unknown): RunningApp | null {
    if (typeof ref === "number" || (typeof ref === "string" && /^\d+$/.test(ref.trim()))) return apps.find((app) => app.pid === Number(ref)) ?? null;
    const wanted = typeof ref === "string" ? ref.trim().toLowerCase() : "";
    if (!wanted) return null;
    return apps.find((app) => app.bundle?.toLowerCase() === wanted) ?? apps.find((app) => app.name.toLowerCase() === wanted) ?? apps.find((app) => app.name.toLowerCase().includes(wanted)) ?? null;
  }

  private async tree(params: Record<string, unknown>, ctx: Ctx): Promise<TreeResult> {
    await this.needAccessibility(ctx);
    await this.beforeApps();
    const apps = await this.apps(ctx);
    const app = this.resolve(apps, params.app);
    if (!app) throw new HelperError("target_not_found", `No running app is called ${String(params.app)}: desktop_apps lists them, desktop_open opens one.`, "no");
    const wins = (await this.windows(ctx, app.pid)).filter((win) => win.pid === app.pid && win.layer === 0).sort(byFront);
    const chosen = typeof params.window === "number" ? wins[params.window] : (wins.find((win) => win.onScreen && !win.minimized) ?? wins[0]);
    if (!chosen) throw new HelperError("not_inspectable", `${app.name} has no window to read: open it with desktop_open, or look again in a moment.`, "no");
    const wanted = Math.min(400, Math.max(10, num(params.max_elements) ?? 120));
    const { data } = await this.tool(
      "get_window_state",
      {
        pid: app.pid,
        window_id: chosen.id,
        include_screenshot: false,
        max_elements: Math.min(1_500, Math.max(300, wanted * 4)),
        ...(this.mcp.takes("get_window_state", "tree_format") ? { tree_format: "elements" } : {}),
      },
      ctx,
    );
    const origin = chosen.bounds ?? { x: 0, y: 0 };
    const tokens = new Map<string, string>();
    const actions = new Map<string, string[]>();
    const elements: HelperElement[] = [];
    const raw = arr(data.elements);
    const page = this.pageOf(raw);
    const key = `${app.pid}:${chosen.id}`;
    if (page) this.pages.set(key, { app: app.name, url: page, title: chosen.title });
    else this.pages.delete(key);
    for (const item of raw) {
      const index = num(item.element_index);
      const token = str(item.element_token);
      if (index === null || index < 0 || index > 9_999 || !token) continue;
      const element = this.element(item, `e${index}`, origin);
      if (!element) continue;
      tokens.set(element.id, token);
      actions.set(element.id, element.actions);
      elements.push(element);
    }
    const listed = elements.slice(0, wanted);
    const id = `t${(this.treeCount += 1)}`;
    this.trees.set(id, { pid: app.pid, windowId: chosen.id, app: app.name, tokens, actions });
    for (const old of [...this.trees.keys()].slice(0, Math.max(0, this.trees.size - 8))) this.trees.delete(old);
    const front = wins.find((win) => win.onScreen && !win.minimized);
    return {
      tree_id: id,
      app: this.helperApp(app, wins),
      window: { index: wins.indexOf(chosen), title: str(data.window_title) ?? chosen.title, role: "window", active: app.active && chosen === front, extents: chosen.bounds ? [chosen.bounds.x, chosen.bounds.y, chosen.bounds.width, chosen.bounds.height] : null },
      elements: listed,
      truncated: data.truncated === true || elements.length > listed.length,
      visited: raw.length,
    };
  }

  private async elementAction(params: Record<string, unknown>, ctx: Ctx): Promise<Record<string, unknown>> {
    await this.needAccessibility(ctx);
    const tree = this.trees.get(String(params.tree_id ?? ""));
    if (!tree) throw new HelperError("element_gone", "That look's elements are no longer known here: look again.", "no");
    const element = String(params.element ?? "");
    const token = tree.tokens.get(element);
    if (!token) throw new HelperError("element_gone", `There is no element ${element} in that look: look again.`, "no");
    if (params.secret === true && this.recording) throw this.noSecretWhileRecording();
    const action = str(params.action) ?? "press";
    const text = typeof params.text === "string" ? params.text : "";
    let answer: { data: Record<string, unknown> };
    switch (action) {
      case "press":
      case "toggle":
        answer = await this.tool("click", { element_token: token }, ctx, true);
        break;
      case "select":
        answer =
          typeof params.name === "string" && params.name
            ? await this.tool("set_value", { element_token: token, value: params.name }, ctx, true)
            : await this.tool("click", { element_token: token, ...(tree.actions.get(element)?.includes("pick") ? { action: "pick" } : {}) }, ctx, true);
        break;
      case "set_text":
        answer = await this.tool("set_value", { element_token: token, value: text }, ctx, true);
        break;
      case "insert_text": {
        const sent = await this.tool("type_text", { element_token: token, text }, ctx, true);
        // Keys posted to a window that does not pass them on (on Windows, a classic text box of a window that never
        // had the focus): the field read back without the text.
        if (obj(sent.data.escalation).reason === "delivery_failed" && /did not contain the requested text/i.test(textOf(sent.result) ?? "")) {
          return { done: false, refused: "The field did not take the text sent to it in the background", via: str(sent.data.route) ?? "keys", verified: false, states_before: [], states_after: [], effect: "unverifiable" };
        }
        answer = sent;
        break;
      }
      case "scroll_to":
        answer = await this.tool("scroll", { element_token: token, direction: "down", amount: 1 }, ctx, true);
        break;
      case "key": {
        const { modifiers, key } = this.parseKeys(String(params.keys ?? ""));
        const repeat = Math.min(30, Math.max(1, num(params.repeat) ?? 1));
        answer = { data: {} };
        for (let n = 0; n < repeat; n += 1) {
          answer = modifiers.length
            ? await this.tool("hotkey", { keys: [...modifiers, key], element_token: token }, ctx, true)
            : await this.tool("press_key", { key, element_token: token }, ctx, true);
        }
        break;
      }
      case "focus":
        throw new HelperError("unsupported_here", `On ${this.system} an element takes the keyboard when it is pressed or typed into: press it, or type or set_text on it.`, "no");
      default:
        throw new HelperError("invalid_params", `Unknown element action ${action}.`, "no");
    }
    this.proven.input = { state: "working", detail: "Accessibility actions go through." };
    const effect = str(answer.data.effect) ?? "unverifiable";
    return { done: effect !== "suspected_noop", via: str(answer.data.route) ?? "accessibility", verified: effect === "confirmed" ? true : effect === "partial" ? false : null, states_before: [], states_after: [], effect };
  }

  protected noSecretWhileRecording(): HelperError {
    return new HelperError("unsupported_here", `A saved secret is never filled in while the screen is being recorded on ${this.system} (the recording keeps notes of what each action sent): save or discard the recording first.`, "no");
  }

  private async catalog(params: Record<string, unknown>, ctx: Ctx): Promise<{ apps: Array<{ id: string; name: string }> }> {
    const apps = await this.apps(ctx, false);
    const query = str(params.query)?.toLowerCase() ?? null;
    const limit = Math.min(500, Math.max(1, num(params.limit) ?? 200));
    const seen = new Map<string, { id: string; name: string }>();
    for (const app of apps) {
      const id = app.bundle ?? app.launchPath ?? app.name;
      if (!seen.has(id)) seen.set(id, { id, name: app.name });
    }
    const all = [...seen.values()].filter((app) => !query || `${app.name} ${app.id}`.toLowerCase().includes(query));
    const rank = (app: { id: string; name: string }) => (query && (app.name.toLowerCase() === query || app.id.toLowerCase() === query) ? 0 : 1);
    return { apps: all.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).slice(0, limit) };
  }

  /** Opens an app without bringing it forward (cua-driver's launch never takes the front), and waits for a window. */
  private async launch(params: Record<string, unknown>, ctx: Ctx): Promise<Record<string, unknown>> {
    await this.beforeApps();
    const ref = String(params.id ?? "").trim();
    const apps = await this.apps(ctx, false);
    const lower = ref.toLowerCase();
    const found = apps.find((app) => app.bundle?.toLowerCase() === lower) ?? apps.find((app) => app.name.toLowerCase() === lower) ?? apps.find((app) => app.launchPath === ref) ?? null;
    const started = this.now();
    if (found && found.pid > 0 && found.item.running === true && this.reuseRunning()) {
      const shown = (await this.windows(ctx, found.pid)).filter((win) => win.pid === found.pid && win.layer === 0);
      if (shown.length) return { app: { id: found.bundle ?? ref, name: found.name, running: this.helperApp(found, shown) }, stages: { accepted: true, started: true, window: true, focused: false }, waited_ms: 0, running: true };
    }
    const { data } = await this.tool("launch_app", this.launchArgs(found, ref), ctx, true).catch((error: unknown) => {
      if (error instanceof HelperError && error.kind === "target_not_found") throw new HelperError("launch_failed", `${ref} could not be opened: ${error.message}`, "no");
      throw error;
    });
    let pid = num(data.pid);
    let name = found?.name ?? str(data.name) ?? ref;
    const state = obj(data.launch_state);
    let wins = arr(data.windows)
      .map(winOf)
      .filter((win): win is Win => win !== null && win.layer === 0);
    const waitMs = Math.min(20_000, Math.max(0, num(params.wait_ms) ?? 8_000));
    const names = new Set([str(data.bundle_id), found?.bundle, found?.name, ref].filter((item): item is string => !!item).map((item) => item.toLowerCase()));
    for (let tries = 1; pid !== null && !wins.length && this.now() - started < waitMs && ctx.until - this.now() > 2_000; tries += 1) {
      await this.sleep(300);
      const current: number = pid;
      wins = (await this.windows(ctx, current)).filter((win) => win.pid === current && win.layer === 0);
      if (wins.length || tries % 5 !== 0 || !this.reuseRunning()) continue;
      // The window can belong to another process of the same app: one that ran already, or a packaged app's host.
      for (const other of (await this.apps(ctx)).filter((item) => item.pid > 0 && item.pid !== current && (names.has(item.name.toLowerCase()) || (item.bundle !== null && names.has(item.bundle.toLowerCase()))))) {
        const own = (await this.windows(ctx, other.pid)).filter((win) => win.pid === other.pid && win.layer === 0);
        if (!own.length) continue;
        [pid, name, wins] = [other.pid, other.name, own];
        break;
      }
    }
    const app: RunningApp | null = pid !== null ? { pid, name, bundle: str(data.bundle_id) ?? found?.bundle ?? null, active: false, launchPath: found?.launchPath ?? null } : null;
    return {
      app: { id: app?.bundle ?? found?.bundle ?? ref, name: app?.name ?? found?.name ?? ref, running: app ? this.helperApp(app, wins) : null },
      stages: { accepted: true, started: pid !== null && state.process_running !== false, window: wins.length > 0 || state.window_ready === true, focused: false },
      waited_ms: this.now() - started,
    };
  }

  private async bringToFront(params: Record<string, unknown>, ctx: Ctx): Promise<{ focused: boolean; via: string | null }> {
    const app = this.resolve(await this.apps(ctx), params.app);
    if (!app) return { focused: false, via: null };
    const own = (await this.windows(ctx, app.pid)).filter((item) => item.pid === app.pid && item.layer === 0 && !item.minimized).sort(byFront);
    const win = own.find((item) => item.onScreen) ?? own[0];
    const { data } = await this.tool("bring_to_front", { pid: app.pid, ...(win ? { window_id: win.id } : {}) }, ctx, true);
    // macOS says `activated`; Windows `landed_on_target` (the window is the foreground window now).
    return { focused: data.activated === true || data.landed_on_target === true, via: "activate" };
  }

  // ── the owner's pointer and keyboard ─────────────────────────────────────

  private async inputReady(ctx: Ctx): Promise<{ epoch: number; stream: Stream }> {
    const session = this.needSession();
    await this.needAccessibility(ctx);
    return session;
  }

  private sent(data: Record<string, unknown>): { effect: string } {
    this.proven.input = { state: "working", detail: "Input goes through." };
    return { effect: str(data.effect) ?? "unverifiable" };
  }

  private async pointer(params: Record<string, unknown>, ctx: Ctx): Promise<Record<string, unknown>> {
    await this.inputReady(ctx);
    const x = num(params.x);
    const y = num(params.y);
    if (x === null || y === null) throw new HelperError("invalid_params", "A pointer action needs x and y.", "no");
    const action = str(params.action) ?? "click";
    if (action === "move") return { done: true, ...this.sent((await this.tool("move_cursor", { x, y, ...this.desktop("move_cursor"), ...this.foreground("move_cursor") }, ctx, true)).data) };
    if (action !== "click") throw new HelperError("unsupported_here", `Pointer ${action} is not available on ${this.system}.`, "no");
    const button = params.button === "right" || params.button === "middle" ? params.button : "left";
    const count = Math.min(3, Math.max(1, num(params.count) ?? 1));
    const { data } = await this.tool("click", { x, y, button, count, ...this.desktop("click"), ...this.foreground("click") }, ctx, true);
    return { done: true, ...this.sent(data) };
  }

  private async drag(params: Record<string, unknown>, ctx: Ctx): Promise<Record<string, unknown>> {
    await this.inputReady(ctx);
    const from = Array.isArray(params.from) ? (params.from as number[]) : [];
    const to = Array.isArray(params.to) ? (params.to as number[]) : [];
    if (from.length !== 2 || to.length !== 2) throw new HelperError("invalid_params", "A drag needs from and to.", "no");
    const button = params.button === "right" || params.button === "middle" ? params.button : "left";
    const { data } = await this.tool("drag", { from_x: from[0], from_y: from[1], to_x: to[0], to_y: to[1], button, ...this.desktop("drag"), ...this.foreground("drag") }, ctx, true);
    return { done: true, ...this.sent(data) };
  }

  private async scroll(params: Record<string, unknown>, ctx: Ctx): Promise<Record<string, unknown>> {
    const session = await this.inputReady(ctx);
    const direction = ["up", "down", "left", "right"].includes(String(params.direction)) ? String(params.direction) : "down";
    const amount = Math.min(50, Math.max(1, num(params.amount) ?? 3));
    const x = num(params.x) ?? session.stream.width / 2;
    const y = num(params.y) ?? session.stream.height / 2;
    const { data } = await this.tool("scroll", { direction, amount, x, y, ...this.desktop("scroll"), ...this.foreground("scroll") }, ctx, true);
    return { done: true, ...this.sent(data) };
  }

  private async keys(params: Record<string, unknown>, ctx: Ctx): Promise<Record<string, unknown>> {
    await this.inputReady(ctx);
    const { modifiers, key } = this.parseKeys(String(params.keys ?? ""));
    const repeat = Math.min(30, Math.max(1, num(params.repeat) ?? 1));
    let data: Record<string, unknown> = {};
    for (let n = 0; n < repeat; n += 1) {
      data = modifiers.length ? (await this.tool("hotkey", { keys: [...modifiers, key], ...this.desktop("hotkey") }, ctx, true)).data : (await this.tool("press_key", { key, ...this.desktop("press_key") }, ctx, true)).data;
    }
    return { sent: repeat, ...this.sent(data) };
  }

  /**
   * Typing into the app in front, a few characters at a time, like the Linux helper. Between chunks it stops
   * when the window on top changed, a password prompt opened or the floor now refuses the window (`focus_moved`;
   * every few chunks also when another app came to the front), when the owner used the keyboard or mouse since
   * the last key (`owner_input`: the system's idle time is shorter than the time since it), while one more chunk
   * would not fit in the request's time (`out_of_time`), and when the work it is for ended or desktop control
   * stopped (`cancelled`). Once anything was typed, a failure says how much.
   */
  private async text(params: Record<string, unknown>, ctx: Ctx): Promise<Record<string, unknown>> {
    await this.inputReady(ctx);
    if (params.secret === true && this.recording) throw this.noSecretWhileRecording();
    const chars = [...(typeof params.text === "string" ? params.text : "")];
    const start = await this.front(ctx);
    const startTop = topWindow(start.wins);
    const effects: string[] = [];
    let typed = 0;
    let typing = false;
    let slowest = 0;
    const answer = (stopped: TypingStop | null) => ({ typed: { keysym: typed, atspi: 0, clipboard: 0, untyped: 0 }, stopped, ...(typed ? this.sent({ effect: overall(effects) }) : { effect: "unverifiable" }) });
    try {
      for (let at = 0, chunk = 0; at < chars.length; at += TYPING_CHUNK, chunk += 1) {
        const began = this.now();
        if (at > 0) {
          if (this.ended(ctx)) return answer("cancelled");
          if (ctx.until - began < slowest + TYPING_RESERVE_MS) return answer("out_of_time");
          if (await this.focusMoved(start, startTop, chunk % TYPING_FULL_CHECK === 0, ctx)) return answer("focus_moved");
        }
        typing = true;
        const { data } = await this.tool("type_text", { text: chars.slice(at, at + TYPING_CHUNK).join(""), ...this.desktop("type_text") }, ctx, true);
        typing = false;
        const lastKeyAt = this.now();
        typed += Math.min(TYPING_CHUNK, chars.length - at);
        effects.push(str(data.effect) ?? "unverifiable");
        if (at + TYPING_CHUNK >= chars.length) break;
        // A pause after the last key: input during it is not the driver's. The clock is read before the system is
        // asked, so a slow answer never looks like input.
        await this.sleep(TYPING_PAUSE_MS);
        const checkedAt = this.now();
        const idle = await this.idleMs();
        if (idle !== null && idle + OWNER_INPUT_MARGIN_MS < checkedAt - lastKeyAt) return answer("owner_input");
        slowest = Math.max(slowest, this.now() - began);
      }
    } catch (error) {
      if (typed === 0) throw error;
      if (error instanceof HelperError && error.kind === "cancelled") return answer("cancelled");
      throw typingFailed(error, typed, chars.length, typing && !(error instanceof HelperError && error.ran === "no"));
    }
    return answer(null);
  }

  /**
   * Whether the keyboard may no longer reach where typing began: another window on top, a password prompt, or the
   * floor refusing the window now (its title can change); with `full`, also another app in front.
   */
  private async focusMoved(start: Front, startTop: Win | null, full: boolean, ctx: Ctx): Promise<boolean> {
    if (full) {
      const now = await this.front(ctx);
      return now.app?.pid !== start.app?.pid || !sameWindow(topWindow(now.wins), startTop) || now.prompt !== null || keyboardFloor(this.focusOf(now, true)) !== null;
    }
    const wins = await this.windows(ctx, undefined, true);
    const top = topWindow(wins);
    if (!sameWindow(top, startTop) || (await this.promptShown(wins))) return true;
    return keyboardFloor(this.focusOf({ ...start, wins, top: top && top.pid === start.app?.pid ? top : start.top, prompt: null }, true)) !== null;
  }

  // ── recording ────────────────────────────────────────────────────────────

  private async recordStart(params: Record<string, unknown>, ctx: Ctx): Promise<Record<string, unknown>> {
    this.needSession();
    if (this.recording) throw new HelperError("recording_active", "The screen is being recorded already.", "no");
    const unavailable = this.recordingUnavailable();
    if (unavailable) throw new HelperError("unsupported_here", unavailable, "no");
    const path = str(params.path);
    if (!path) throw new HelperError("invalid_params", "A recording needs a path.", "no");
    const id = `rec_${randomBytes(6).toString("hex")}`;
    const dir = join(this.base.workDir, "recordings", id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await this.tool("start_recording", { output_dir: dir, record_video: true, ...(this.mcp.takes("start_recording", "include_accessibility_tree") ? { include_accessibility_tree: false } : {}) }, ctx);
      let state: Record<string, unknown> = {};
      for (let tries = 0; tries < 15; tries += 1) {
        state = (await this.tool("get_recording_state", {}, ctx)).data;
        if (state.video_active === true || str(state.last_error)) break;
        await this.sleep(200);
      }
      if (state.video_active !== true) {
        await this.tool("stop_recording", {}, ctx).catch(() => undefined);
        throw new HelperError("recording_failed", `The screen recording did not start${str(state.last_error) ? ` (${str(state.last_error)!.slice(0, 200)})` : ""}.`, "no");
      }
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    const recording: Recording = { id, dir, path, active: true, reason: null, video: null, timer: null, startedAt: this.now() };
    const maxMs = Math.min(15 * 60_000, Math.max(1_000, num(params.max_ms) ?? 120_000));
    recording.timer = setTimeout(() => void this.serial(() => this.endRecording(recording, "max_duration", { until: this.now() + 30_000, stops: this.stops, sent: false })).catch(() => undefined), maxMs);
    recording.timer.unref?.();
    this.recording = recording;
    return { id, container: "mp4", codec: "h264", mime: "video/mp4" };
  }

  /** Stops the video and waits until its file is finished; a recording that reached its length says so. */
  private async endRecording(recording: Recording, reason: string, ctx: Ctx): Promise<void> {
    if (!recording.active) return;
    if (recording.timer) clearTimeout(recording.timer);
    recording.timer = null;
    recording.active = false;
    recording.reason = reason;
    try {
      const stopped = (await this.tool("stop_recording", {}, ctx)).data;
      let state: Record<string, unknown> = stopped;
      for (let tries = 0; tries < 50 && state.video_active === true; tries += 1) {
        await this.sleep(200);
        state = (await this.tool("get_recording_state", {}, ctx)).data;
      }
      const candidates = [str(stopped.video_path), str(stopped.last_video_path), str(state.last_video_path), join(recording.dir, "recording.mp4")].filter((path): path is string => Boolean(path));
      for (const path of candidates) {
        if (await stat(path).then((info) => info.isFile() && info.size > 0, () => false)) {
          recording.video = path;
          break;
        }
      }
    } finally {
      if (reason === "max_duration") this.emit("event", { kind: "record.stopped", id: recording.id, reason });
    }
  }

  private async recordStop(params: Record<string, unknown>, ctx: Ctx): Promise<{ reason: string }> {
    const recording = this.recording;
    if (!recording || recording.id !== params.id) throw new HelperError("no_recording", "There is no such recording.", "no");
    try {
      await this.endRecording(recording, "stopped", ctx);
      if (!recording.video) throw new HelperError("recording_failed", "The recording left no video file.", "no");
      await rename(recording.video, recording.path).catch(async () => {
        await copyFile(recording.video!, recording.path);
      });
      return { reason: recording.reason ?? "stopped" };
    } finally {
      this.recording = null;
      await rm(recording.dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async recordDiscard(params: Record<string, unknown>, ctx: Ctx): Promise<{ discarded: boolean }> {
    const recording = this.recording;
    if (!recording || recording.id !== params.id) return { discarded: false };
    this.recording = null;
    if (recording.timer) clearTimeout(recording.timer);
    if (recording.active) await this.tool("stop_recording", {}, ctx).catch(() => undefined);
    await rm(recording.dir, { recursive: true, force: true }).catch(() => undefined);
    await rm(recording.path, { force: true }).catch(() => undefined);
    return { discarded: true };
  }

  private async mediaCheck(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const path = str(params.path);
    if (!path) throw new HelperError("invalid_params", "media.check needs a path.", "no");
    try {
      const facts = await mp4Facts(path);
      if (!facts.width || !facts.height || facts.durationMs <= 0) throw new Error("it holds no picture");
      return { frames: facts.frames, duration_ms: facts.durationMs, width: facts.width, height: facts.height, codec: facts.codec, size: facts.size };
    } catch (error) {
      throw new HelperError("recording_failed", `The recording could not be read back (${error instanceof Error ? error.message.slice(0, 160) : "unknown error"}).`, "no");
    }
  }
}
