/**
 * Desktop control on macOS through cua-driver (MIT, github.com/trycua/cua; the version is pinned in
 * desktop-helper/macos/cua-driver.json), speaking the Linux helper's protocol (protocol.ts) so DesktopService
 * runs on top unchanged. cua-driver runs as `cua-driver mcp --direct --embedded`, a child of this runtime: in
 * the Ensemble app that keeps it in the app's chain of responsibility, so macOS asks about Accessibility and
 * Screen Recording for Ensemble itself. One method becomes one or a few MCP tool calls:
 *
 * - screenshots: `get_desktop_state` (the main display, PNG); crops, sizes and hashes in drivers/png.ts;
 * - elements: `list_apps`, `list_windows`, `get_window_state` (element tokens kept per look), and `click`,
 *   `set_value`, `type_text`, `press_key`, `hotkey`, `scroll` on a token, in the background;
 * - the owner's pointer and keyboard: the same tools with `scope: "desktop"` (screen pixels, the app in front);
 * - recording: `start_recording`/`stop_recording` (ScreenCaptureKit, macOS 15 or later).
 *
 * Each action's own account of what it did (`effect`) comes back with its answer; a refusal is a typed error
 * that says nothing ran. Grants are read with `check_permissions` and proven by a real screenshot; macOS keeps
 * a process's answer, so the driver is started again after a check fails.
 */
import { execFile } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { EventEmitter } from "node:events";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { keyboardFloor } from "../floor.js";
import type { HelperCommand, HelperHealth } from "../helper-process.js";
import { fit } from "../mapping.js";
import { HelperError, type CaptureResult, type Fact, type FocusInfo, type HelperApp, type HelperElement, type HelperErrorKind, type Ran, type SessionInfo, type StatusResult, type Stream, type TreeResult } from "../protocol.js";
import { McpStdioClient, type McpResult } from "./mcp-stdio.js";
import { mp4Facts } from "./mp4.js";
import { cropPixels, decodePng, encodePng, hashBytes, pngSize, shrinkPixels } from "./png.js";

export type ExecFn = (command: string, args: string[], timeoutMs: number) => Promise<string>;

export type MacosCuaOptions = {
  /** How to start cua-driver here, or why it cannot run. */
  spawn: () => HelperCommand | { unavailable: string };
  /** The cua-driver version this Ensemble is built for: any other is not used. */
  version: string;
  /** A private folder for screenshots in flight and recordings before they are saved. */
  workDir: string;
  /** Where CuaDriver.app is: the fixes name it, and macOS is asked for its grants through it. */
  appPath?: string | null;
  /** macOS's major version (video needs 15 or later). */
  macosMajor: number | null;
  /** Runs ioreg, osascript, getconf and open (idle time, the lock, notices, browsers, permission prompts); tests replace it. */
  exec?: ExecFn;
  log?: (message: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  helloTimeoutMs?: number;
  maxRestarts?: number;
  restartWindowMs?: number;
  stopGraceMs?: number;
};

/** The name macOS shows for the driver (CuaDriver.app, bundle com.trycua.driver) in its privacy lists. */
const DRIVER = "Cua Driver";
/** The one display cua-driver captures and aims at: the main one. */
const MAIN = 1;
/** The long side of the small captures that tell whether the screen changed. */
const PROBE_EDGE = 400;
/** Characters typed at a time; between chunks, the window in front and the owner's input are checked. */
const TYPING_CHUNK = 8;
/** The pause after each typed chunk before the owner's input is read. */
const TYPING_PAUSE_MS = 120;
/** Idle time this much shorter than the time since the last key means someone else's input. */
const OWNER_INPUT_MARGIN_MS = 40;
/** Between chunks the window on top is checked; every this many chunks also the app in front. */
const TYPING_FULL_CHECK = 4;
/** Typing stops while this much more than one chunk's time is left, to answer before the request's end. */
const TYPING_RESERVE_MS = 500;
/** How long macOS is not asked again for the same missing grants. */
const ASK_AGAIN_MS = 10 * 60_000;
/** Cua Driver 0.56.6's private LaunchServices permission host (cli.rs `permissions grant`). */
const PERMISSIONS_HOST_REQUEST_ARG = "__permissions-host-request";
/** How long the list of apps that open https links is kept; a failed read is tried again after a minute. */
const HANDLERS_TTL_MS = 10 * 60_000;
const HANDLERS_RETRY_MS = 60_000;

const screenPane = (macosMajor: number | null) => (macosMajor !== null && macosMajor < 15 ? "Screen Recording" : "Screen & System Audio Recording");
const whereListed = (appPath: string | null) => (appPath ? ` (macOS lists it once it has asked; otherwise click +, press ⌘⇧G and paste ${appPath})` : " (macOS lists it once it has asked)");

export function accessibilityFix(appPath: string | null = null): string {
  return `System Settings › Privacy & Security › Accessibility: turn on ${DRIVER}, the desktop driver Ensemble starts${whereListed(appPath)}.`;
}

export function screenRecordingFix(macosMajor: number | null, appPath: string | null = null): string {
  return `System Settings › Privacy & Security › ${screenPane(macosMajor)}: turn on ${DRIVER}, the desktop driver Ensemble starts${whereListed(appPath)}.`;
}

/** The fix when Ensemble itself holds a grant, which everything it starts would inherit. */
export function hostGrantsFix(macosMajor: number | null): string {
  return `System Settings › Privacy & Security: turn Ensemble off under Accessibility and under ${screenPane(macosMajor)} (desktop control uses ${DRIVER}, which has grants of its own).`;
}

const ACCESSIBILITY_OFF = `Accessibility is off for ${DRIVER} on this Mac, so desktop control can read and press nothing in other apps.`;
const RECORDING_OFF = `Screen Recording is off for ${DRIVER} on this Mac, so desktop control cannot take screenshots or record the screen (reading and pressing elements works without it).`;

const ROLE_WORDS: Record<string, string> = {
  AXButton: "push button",
  AXMenuButton: "menu button",
  AXPopUpButton: "combo box",
  AXComboBox: "combo box",
  AXCheckBox: "check box",
  AXRadioButton: "radio button",
  AXTextField: "text",
  AXTextArea: "text",
  AXSearchField: "text",
  AXStaticText: "label",
  AXLink: "link",
  AXImage: "image",
  AXMenuItem: "menu item",
  AXMenuBarItem: "menu",
  AXMenu: "menu",
  AXRow: "table row",
  AXCell: "table cell",
  AXTable: "table",
  AXOutline: "tree table",
  AXList: "list",
  AXSlider: "slider",
  AXIncrementor: "spin button",
  AXStepper: "spin button",
  AXDisclosureTriangle: "toggle button",
  AXScrollArea: "scroll pane",
  AXScrollBar: "scroll bar",
  AXGroup: "panel",
  AXToolbar: "tool bar",
  AXTabGroup: "page tab list",
  AXSplitGroup: "split pane",
  AXWindow: "frame",
  AXSheet: "dialog",
  AXHeading: "heading",
  AXWebArea: "document web",
  AXDateField: "date editor",
  AXProgressIndicator: "progress bar",
  AXColorWell: "color chooser",
};
const SUBROLE_WORDS: Record<string, string> = { AXSwitch: "switch", AXToggle: "toggle button", AXTabButton: "page tab", AXSearchField: "text" };
const TEXT_INPUTS = new Set(["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXSecureTextField"]);
const CHECKABLE = /check box|switch|radio button|toggle button|page tab/;

/** The processes that show the system's password and permission prompts. */
const PROMPT_APPS = /^(?:SecurityAgent|coreautha|UserNotificationCenter|AuthenticationServicesAgent)$/i;

/** Browsers known by bundle id, with their web-app bundles (Safari's `com.apple.Safari.WebApp.*`, Chromium's `<browser>.app.*`). */
const BROWSERS: Array<{ toolkit: string; pattern: RegExp }> = [
  { toolkit: "WebKit", pattern: /^(?:com\.apple\.safari(?:$|\.webapp\.)|com\.apple\.safaritechnologypreview$|com\.kagi\.kagimacos|com\.duckduckgo\.macos\.browser)/i },
  { toolkit: "Chromium", pattern: /^(?:com\.google\.chrome|com\.microsoft\.edgemac|com\.brave\.browser|company\.thebrowser\.|com\.operasoftware\.|com\.vivaldi\.|org\.chromium\.|ai\.perplexity\.comet|ru\.yandex\.desktop\.yandex-browser|com\.sigmaos\.)/i },
  { toolkit: "Gecko", pattern: /^(?:org\.mozilla\.|org\.torproject\.|app\.zen-browser\.|net\.waterfox\.|io\.gitlab\.librewolf|one\.ablaze\.floorp|net\.mullvad\.mullvadbrowser)/i },
];

/** Every app LaunchServices would open an https link with: the browsers the list above does not know. */
const HTTPS_HANDLERS_JXA = `ObjC.import("AppKit");
const urls = $.NSWorkspace.sharedWorkspace.URLsForApplicationsToOpenURL($.NSURL.URLWithString("https://example.com"));
const ids = [];
for (let i = 0; i < urls.count; i++) {
  const bundle = $.NSBundle.bundleWithURL(urls.objectAtIndex(i));
  if (!bundle.isNil() && !bundle.bundleIdentifier.isNil()) ids.push(bundle.bundleIdentifier.js);
}
JSON.stringify(ids);`;

/** A browser's engine, `Web` for another app that opens https links, `macOS` for any other app. */
function toolkitOf(bundle: string | null, handlers: ReadonlySet<string> = new Set()): string {
  if (!bundle) return "macOS";
  return BROWSERS.find((browser) => browser.pattern.test(bundle))?.toolkit ?? (handlers.has(bundle.toLowerCase()) ? "Web" : "macOS");
}

const words = (name: string) =>
  name
    .replace(/^AX/, "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim()
    .toLowerCase();

const obj = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const arr = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value.map(obj) : []);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

type RunningApp = { pid: number; name: string; bundle: string | null; active: boolean; launchPath: string | null };
type Win = { id: number; pid: number; app: string; title: string; bounds: { x: number; y: number; width: number; height: number } | null; onScreen: boolean; minimized: boolean; z: number | null; layer: number };
type Tree = { pid: number; windowId: number; app: string; tokens: Map<string, string>; actions: Map<string, string[]> };
type Recording = { id: string; dir: string; path: string; active: boolean; reason: string | null; video: string | null; timer: NodeJS.Timeout | null; startedAt: number };
type Ctx = { until: number };
type Front = { apps: RunningApp[]; wins: Win[]; app: RunningApp | null; top: Win | null; prompt: Win | null };
/** Why typing ended before the end of the text (the service says each in its words). */
type TypingStop = "focus_moved" | "owner_input" | "out_of_time";

/** An app from `list_apps`: an installed app that is not running has pid 0. */
function appOf(item: Record<string, unknown>): RunningApp | null {
  const pid = num(item.pid) ?? 0;
  const name = str(item.name);
  if (!name || (item.running === true && pid <= 0)) return null;
  return { pid, name, bundle: str(item.bundle_id), active: item.active === true, launchPath: str(item.launch_path) };
}

function winOf(item: Record<string, unknown>): Win | null {
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
const byFront = (a: Win, b: Win) => (b.z ?? -Infinity) - (a.z ?? -Infinity);

/** The window on top of all others that show (the one the keyboard goes to unless an app without windows is in front). */
const topWindow = (wins: readonly Win[]) => wins.filter((win) => win.layer === 0 && win.onScreen && !win.minimized).sort(byFront)[0] ?? null;
const sameWindow = (a: Win | null, b: Win | null) => (a === null || b === null ? a === b : a.id === b.id && a.pid === b.pid);

function textOf(result: McpResult | null | undefined): string | null {
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

const NEEDS_SCREEN_CODES = new Set(["background_unavailable", "select_menu_would_raise_window", "window_not_key", "target_focus_unconfirmed", "foreground_required"]);
const GONE_CODES = new Set(["stale_element_token", "stale_bare_row", "window_target_not_found", "window_id_not_found", "window_owner_pid_mismatch", "element_not_found", "stale_snapshot"]);
const CONSENT_CODES = new Set(["automation_consent_required", "permission_required", "accessibility_not_granted", "screen_recording_not_granted", "accessibility_permission_missing", "screen_recording_permission_missing"]);
const NOT_FOUND_CODES = new Set(["APP_NOT_INSTALLED", "APP_NAME_AMBIGUOUS", "ambiguous_window_target", "app_not_found", "pid_not_found"]);

function kindOf(code: string | null, text: string, effects: boolean): HelperErrorKind {
  if (code && NEEDS_SCREEN_CODES.has(code)) return "needs_screen";
  if (code && GONE_CODES.has(code)) return "element_gone";
  if (code && CONSENT_CODES.has(code)) return "consent_needed";
  if (code && NOT_FOUND_CODES.has(code)) return "target_not_found";
  if (code === "invalid_arguments" || code === "desktop_scope_disabled" || code === "invalid_target") return "invalid_params";
  if (code === "no_focused_text_input" || code === "delivery_failed") return "input_failed";
  if (/(accessibility|screen recording|screen capture)/i.test(text) && /(not granted|not trusted|not allowed|permission|denied|blocked)/i.test(text)) return "consent_needed";
  return effects ? "input_failed" : "internal";
}

export class MacosCuaDriver extends EventEmitter {
  private readonly mcp: McpStdioClient;
  private session: { epoch: number; stream: Stream } | null = null;
  private epoch = 0;
  private seq = 0;
  /** Screen pixels per point on the main display, from its latest screenshot. */
  private scale = 1;
  private readonly trees = new Map<string, Tree>();
  private treeCount = 0;
  private accessibilityOn = false;
  /** The missing grants macOS was last asked about, and when. */
  private asked: { missing: string; at: number } | null = null;
  /** Bundle ids (lower case) of the apps LaunchServices opens https links with, and until when they hold. */
  private handlers: { ids: ReadonlySet<string>; at: number } | null = null;
  /** Screenshots come back in the answer rather than through a file (after the driver refused the file once). */
  private inlineShots = false;
  private recording: Recording | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly proven: Record<"capture" | "input", Fact> = {
    capture: { state: "untested", detail: "No screenshot has been taken yet." },
    input: { state: "untested", detail: "Nothing has been pressed or typed yet." },
  };

  constructor(private readonly options: MacosCuaOptions) {
    super();
    this.mcp = new McpStdioClient({
      spawn: options.spawn,
      version: options.version,
      log: options.log,
      now: options.now,
      helloTimeoutMs: options.helloTimeoutMs,
      maxRestarts: options.maxRestarts,
      restartWindowMs: options.restartWindowMs,
      stopGraceMs: options.stopGraceMs,
    });
    this.mcp.on("exit", (info: { code: number | null; signal: string | null; expected: boolean }) => this.onExit(info));
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private sleep(ms: number): Promise<void> {
    return this.options.sleep ? this.options.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms).unref?.());
  }

  health(): HelperHealth {
    return this.mcp.health();
  }

  private onExit(info: { code: number | null; signal: string | null; expected: boolean }): void {
    this.session = null;
    this.trees.clear();
    this.accessibilityOn = false;
    const recording = this.recording;
    if (recording) {
      if (recording.timer) clearTimeout(recording.timer);
      this.recording = null;
      void rm(recording.dir, { recursive: true, force: true }).catch(() => undefined);
    }
    this.emit("exit", info);
  }

  async stop(): Promise<void> {
    await this.serial(async () => {
      const recording = this.recording;
      if (recording?.active) await this.mcp.call("stop_recording", {}, { timeoutMs: 10_000 }).catch(() => undefined);
    }).catch(() => undefined);
    this.session = null;
    await this.mcp.stop();
  }

  /** One request of the helper protocol, after the one before it is done. */
  call<T>(method: string, params: Record<string, unknown>, options: { timeoutMs: number; effects?: boolean; signal?: AbortSignal }): Promise<T> {
    const ctx: Ctx = { until: this.now() + options.timeoutMs };
    if (options.signal?.aborted) return Promise.reject(new HelperError("cancelled", "The work this request was for ended.", "no"));
    return this.serial(() => this.dispatch(method, params, ctx)) as Promise<T>;
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
        return Promise.reject(new HelperError("method_not_found", `${method} is not available on macOS.`, "no"));
    }
  }

  // ── tool calls ───────────────────────────────────────────────────────────

  /** One tool call within the request's time; a failure or refusal becomes a typed error. */
  private async tool(name: string, args: Record<string, unknown>, ctx: Ctx, effects = false): Promise<{ data: Record<string, unknown>; result: McpResult }> {
    const left = ctx.until - this.now();
    if (left < 300) throw new HelperError("timeout", "Desktop control ran out of time for this request.", "no", true);
    const result = await this.mcp.call(name, args, { timeoutMs: left, effects });
    const data = obj(result?.structuredContent);
    const refused = data.effect === "refused" || data.status === "refused";
    if (!result?.isError && !refused) return { data, result };
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
    if (kind === "consent_needed") {
      this.accessibilityOn = false;
      const screen = /screen/i.test(code ?? "") || /screen recording|screen capture/i.test(text);
      const fix = screen ? this.screenFix() : this.accessFix();
      return new HelperError(kind, `${screen ? RECORDING_OFF : ACCESSIBILITY_OFF} Fix: ${fix}`, ran, false, { ...(code ? { code } : {}), fix });
    }
    const hint = kind === "needs_screen" ? " It needs the owner's screen: run it in the foreground (foreground: true asks them once)." : kind === "element_gone" ? " Look again: the element changed or is gone." : "";
    return new HelperError(kind, `${text.slice(0, 300)}${hint}`, ran, false, code ? { code } : {});
  }

  /** The schema property this cua-driver uses for screen coordinates of the main display. */
  private desktop(tool: string): Record<string, unknown> {
    if (!this.mcp.takes(tool, "scope") && this.mcp.takes(tool, "target")) return { target: { kind: "desktop", display_id: "primary" } };
    return { scope: "desktop" };
  }

  /** The owner's pointer goes where it is told even over an app that is not in front. */
  private foreground(tool: string): Record<string, unknown> {
    return this.mcp.takes(tool, "delivery_mode") ? { delivery_mode: "foreground" } : {};
  }

  private accessFix(): string {
    return accessibilityFix(this.options.appPath ?? null);
  }

  private screenFix(): string {
    return screenRecordingFix(this.options.macosMajor, this.options.appPath ?? null);
  }

  /** Cua Driver's grants (the launcher makes it its own responsible process, so they are its own and never Ensemble's). */
  private async permissions(ctx: Ctx): Promise<{ accessibility: boolean; screenRecording: boolean; capturable: boolean | null }> {
    const { data } = await this.tool("check_permissions", {}, ctx);
    const granted = { accessibility: data.accessibility === true, screenRecording: data.screen_recording === true, capturable: typeof data.screen_recording_capturable === "boolean" ? data.screen_recording_capturable : null };
    if (!granted.accessibility || !granted.screenRecording) await this.askMacOS(granted);
    return granted;
  }

  /**
   * Has macOS ask the owner for Cua Driver's next missing grant (Accessibility first), through Cua Driver's own
   * permission host started by LaunchServices, so the prompt and the System Settings entry say "Cua Driver" and
   * never Ensemble. Once for a set of missing grants every ten minutes; it waits a few seconds at most, never
   * for the owner's answer.
   */
  private async askMacOS(granted: { accessibility: boolean; screenRecording: boolean }): Promise<void> {
    const appPath = this.options.appPath;
    const missing = `${granted.accessibility ? "" : "accessibility "}${granted.screenRecording ? "" : "screen_recording"}`.trim();
    if (!appPath || !missing) return;
    if (this.asked && this.asked.missing === missing && this.now() - this.asked.at < ASK_AGAIN_MS) return;
    this.asked = { missing, at: this.now() };
    const exec = this.options.exec ?? runCommand;
    const work = (async () => {
      let file: string | null = null;
      try {
        // The host only writes into a file that already exists in its own temporary folder, named like this.
        const temp = (await exec("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], 3_000)).trim();
        if (!temp.startsWith("/")) throw new Error("macOS did not say where the user's temporary folder is");
        file = join(temp, `cua-driver-permissions-${process.pid}-${Date.now()}${randomInt(100_000, 1_000_000)}.json`);
        await writeFile(file, "", { flag: "wx", mode: 0o600 });
        await exec("/usr/bin/open", ["-n", "-W", "-g", appPath, "--args", PERMISSIONS_HOST_REQUEST_ARG, "--result-file", file], 20_000);
      } catch (error) {
        this.options.log?.(`asking macOS for Cua Driver's grants failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`);
      } finally {
        if (file) await rm(file, { force: true }).catch(() => undefined);
      }
    })();
    await Promise.race([work, new Promise((resolve) => setTimeout(resolve, 3_000).unref?.())]);
  }

  /** macOS keeps a process's answer about its grants: a fresh driver reads them again on the next request. */
  private async refresh(): Promise<void> {
    if (!this.recording) await this.mcp.stop().catch(() => undefined);
  }

  private async needAccessibility(ctx: Ctx): Promise<void> {
    if (this.accessibilityOn && this.mcp.running) return;
    const granted = await this.permissions(ctx);
    if (granted.accessibility) {
      this.accessibilityOn = true;
      return;
    }
    await this.refresh();
    throw new HelperError("consent_needed", `${ACCESSIBILITY_OFF} Fix: ${this.accessFix()}`, "no", false, { fix: this.accessFix(), permission: "accessibility" });
  }

  private needSession(): { epoch: number; stream: Stream } {
    if (!this.session) throw new HelperError("no_session", "Screen control is not on.", "no");
    return this.session;
  }

  // ── status and the session ───────────────────────────────────────────────

  private async status(ctx: Ctx): Promise<StatusResult> {
    const granted = await this.permissions(ctx);
    const idle = await this.idle();
    const major = this.options.macosMajor;
    const facts: Record<string, Fact> = {
      driver: { state: "working", detail: `${DRIVER} ${this.mcp.health().version ?? this.options.version}, started by Ensemble as its own app${this.options.appPath ? ` (${this.options.appPath})` : ""}` },
      accessibility: granted.accessibility ? { state: "working", detail: `On for ${DRIVER}.` } : { state: "needed", detail: ACCESSIBILITY_OFF, fix: this.accessFix() },
      screen_recording: granted.screenRecording ? { state: "working", detail: `On for ${DRIVER}.` } : { state: "needed", detail: RECORDING_OFF, fix: this.screenFix() },
      capture: this.proven.capture,
      input: this.proven.input,
      recorder: major !== null && major >= 15 ? { state: "working", detail: "MP4 (H.264) through ScreenCaptureKit." } : { state: "failed", detail: `Recording the screen needs macOS 15 or later${major !== null ? `; this Mac runs macOS ${major}` : ""}. Screenshots work.` },
      screen: idle.locked === null ? { state: "untested", detail: "macOS did not say whether the screen is locked.", idle_ms: idle.idle_ms } : idle.locked ? { state: "locked", detail: "The screen is locked.", fix: "Your owner unlocks it at the computer; Ensemble never types a password.", idle_ms: idle.idle_ms } : { state: "unlocked", idle_ms: idle.idle_ms },
      agent_screen: { state: "failed", detail: "macOS has no private agent screen in this version: work happens on your owner's screen, in the background where it can." },
    };
    if (!granted.accessibility || !granted.screenRecording) await this.refresh();
    const recording = this.recording;
    return {
      facts,
      session: { state: this.session ? "on" : "off", epoch: this.session?.epoch ?? this.epoch, ...(this.session ? { streams: [this.session.stream] } : {}) },
      registered: false,
      recordings: recording ? [{ id: recording.id, active: recording.active, wall_ms: this.now() - recording.startedAt }] : [],
    };
  }

  /** Screen control starts when Screen Recording is on and a real screenshot proves it. */
  private async sessionStart(ctx: Ctx): Promise<SessionInfo> {
    if (this.session) return { state: "on", epoch: this.session.epoch, streams: [this.session.stream] };
    const granted = await this.permissions(ctx);
    const fix = this.screenFix();
    if (!granted.screenRecording || granted.capturable === false) {
      await this.refresh();
      throw new HelperError("consent_needed", `${RECORDING_OFF} Fix: ${fix}`, "no", false, { fix, permission: "screen_recording" });
    }
    let shot: Awaited<ReturnType<MacosCuaDriver["grab"]>>;
    try {
      shot = await this.grab(64, ctx);
    } catch (error) {
      this.proven.capture = { state: "failed", detail: error instanceof Error ? error.message.slice(0, 200) : "The test screenshot failed.", fix };
      await this.refresh();
      const why = error instanceof Error ? ` (${error.message.slice(0, 160)})` : "";
      throw new HelperError("consent_needed", `A test screenshot failed${why}: macOS may be asking on the screen to allow ${DRIVER} to record it, or Screen Recording is off. Fix: allow it in the dialog if one shows; otherwise ${fix}`, "no", false, { fix, permission: "screen_recording" });
    }
    this.proven.capture = { state: "working", detail: `${shot.native.width}×${shot.native.height} pixels` };
    this.epoch += 1;
    this.session = { epoch: this.epoch, stream: this.streamOf(shot.native) };
    return { state: "on", epoch: this.epoch, streams: [this.session.stream] };
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

  private async idle(): Promise<{ locked: boolean | null; idle_ms: number | null }> {
    const exec = this.options.exec ?? runCommand;
    const [idle_ms, root] = await Promise.all([this.idleMs(), exec("/usr/sbin/ioreg", ["-n", "Root", "-d", "1"], 3_000).catch(() => "")]);
    const locked = /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(root) ? true : /IOConsoleUsers/.test(root) ? false : null;
    return { locked, idle_ms };
  }

  /** How long ago anyone last used the keyboard or mouse (`HIDIdleTime`). */
  private async idleMs(): Promise<number | null> {
    const exec = this.options.exec ?? runCommand;
    const hid = await exec("/usr/sbin/ioreg", ["-r", "-c", "IOHIDSystem", "-d", "1"], 3_000).catch(() => "");
    const idle = /"HIDIdleTime"\s*=\s*(\d+)/.exec(hid);
    return idle ? Math.floor(Number(idle[1]) / 1_000_000) : null;
  }

  private async notice(params: Record<string, unknown>): Promise<{ shown: boolean }> {
    const exec = this.options.exec ?? runCommand;
    const title = (str(params.title) ?? "Ensemble").slice(0, 120);
    const body = (str(params.body) ?? "").slice(0, 300);
    await exec("/usr/bin/osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body], 5_000);
    return { shown: true };
  }

  // ── screenshots ──────────────────────────────────────────────────────────

  /** The main display as a PNG, its long side at most `edge` (0: full size), and its full size in pixels. */
  private async grab(edge: number, ctx: Ctx): Promise<{ png: Buffer; size: { width: number; height: number }; native: { width: number; height: number } }> {
    const shots = join(this.options.workDir, "shots");
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
      const points = { width: num(data.screen_width), height: num(data.screen_height) };
      const width = num(data.screenshot_original_width) ?? (points.width && scale ? Math.round(points.width * scale) : size.width);
      const height = num(data.screenshot_original_height) ?? (points.height && scale ? Math.round(points.height * scale) : size.height);
      return { png, size, native: { width, height } };
    } finally {
      await rm(out, { force: true }).catch(() => undefined);
    }
  }

  /** A hash of a small screenshot without the menu bar (its clock would count as a change). */
  private async probe(ctx: Ctx): Promise<number> {
    this.needSession();
    const shot = await this.grab(PROBE_EDGE, ctx);
    const pixels = decodePng(shot.png);
    const skip = Math.ceil(pixels.height * 0.04);
    return hashBytes(pixels.data.subarray(skip * pixels.width * 4));
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

  private async apps(ctx: Ctx, running = true): Promise<Array<RunningApp & { item: Record<string, unknown> }>> {
    const { data } = await this.tool("list_apps", {}, ctx);
    const out: Array<RunningApp & { item: Record<string, unknown> }> = [];
    for (const item of arr(data.apps)) {
      if (running && item.running !== true) continue;
      const app = appOf(item);
      if (app) out.push({ ...app, item });
    }
    return out;
  }

  private async windows(ctx: Ctx, pid?: number, onScreenOnly = false): Promise<Win[]> {
    const args = { ...(pid !== undefined ? { pid } : {}), ...(onScreenOnly && this.mcp.takes("list_windows", "on_screen_only") ? { on_screen_only: true } : {}) };
    const { data } = await this.tool("list_windows", args, ctx);
    return arr(data.windows)
      .map(winOf)
      .filter((win): win is Win => win !== null);
  }

  /** The apps that open https links: browsers the bundle list does not know. Read once every ten minutes. */
  private async browsers(): Promise<ReadonlySet<string>> {
    const cached = this.handlers;
    if (cached && this.now() < cached.at) return cached.ids;
    const exec = this.options.exec ?? runCommand;
    try {
      const listed: unknown = JSON.parse((await exec("/usr/bin/osascript", ["-l", "JavaScript", "-e", HTTPS_HANDLERS_JXA], 5_000)).trim());
      if (!Array.isArray(listed)) throw new Error("not a list");
      const ids = new Set(listed.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length < 256).map((id) => id.toLowerCase()));
      this.handlers = { ids, at: this.now() + HANDLERS_TTL_MS };
    } catch (error) {
      this.options.log?.(`reading the apps that open https links failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`);
      this.handlers = { ids: cached?.ids ?? new Set(), at: this.now() + HANDLERS_RETRY_MS };
    }
    return this.handlers.ids;
  }

  private toolkit(bundle: string | null): string {
    return toolkitOf(bundle, this.handlers?.ids);
  }

  /** An app with its own windows, front first; window boxes in screen pixels, for the floor's "which window is at this point". */
  private helperApp(app: RunningApp, wins: readonly Win[]): HelperApp {
    const own = wins.filter((win) => win.pid === app.pid && win.layer === 0).sort(byFront);
    const front = own.find((win) => win.onScreen && !win.minimized);
    const s = this.scale;
    return {
      name: app.name,
      toolkit: this.toolkit(app.bundle),
      pid: app.pid,
      app_id: app.bundle,
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
    await this.browsers();
    const [apps, wins] = [await this.apps(ctx), await this.windows(ctx)];
    return { apps: apps.map((app) => this.helperApp(app, wins)), units: apps.length };
  }

  /** The app in front, its window in front (the top one that shows), and a password prompt of the system if one shows. */
  private async front(ctx: Ctx): Promise<Front> {
    await this.browsers();
    const [apps, wins] = [await this.apps(ctx), await this.windows(ctx)];
    const app = apps.find((item) => item.active) ?? null;
    const top = app ? (wins.filter((win) => win.pid === app.pid && win.layer === 0 && win.onScreen && !win.minimized).sort(byFront)[0] ?? null) : null;
    const names = new Map(apps.map((item) => [item.pid, item.name]));
    const prompt = wins.find((win) => win.onScreen && PROMPT_APPS.test(win.app || names.get(win.pid) || "")) ?? null;
    return { apps, wins, app, top, prompt };
  }

  private focusOf(front: Front, documents: boolean): FocusInfo {
    const { apps, wins, app, top, prompt } = front;
    const pages: NonNullable<FocusInfo["documents"]> = [];
    if (documents) {
      // cua-driver does not read a browser's address, so every window of a browser is a page that cannot be read:
      // also one that is minimised, hidden or on another Space, where an element can still be pressed. Which one
      // the keyboard reaches comes from what shows in front.
      for (const browser of apps.filter((item) => this.toolkit(item.bundle) !== "macOS")) {
        const own = wins.filter((win) => win.pid === browser.pid && win.layer === 0).sort(byFront);
        const shown = own.find((win) => win.onScreen && !win.minimized) ?? null;
        for (const win of own) pages.push({ app: browser.name, url: null, window: win.title, active: browser === app && win === shown });
      }
    }
    return {
      app: app ? { name: app.name, toolkit: this.toolkit(app.bundle), pid: app.pid, app_id: app.bundle } : null,
      window: top ? { index: 0, title: top.title, role: "window" } : null,
      shell: false,
      prompt: prompt ? { title: prompt.title || "Authentication" } : null,
      // macOS does not say here which element has the keyboard.
      focused: null,
      documents: pages,
    };
  }

  private async focus(params: Record<string, unknown>, ctx: Ctx): Promise<FocusInfo> {
    return this.focusOf(await this.front(ctx), params.documents === true);
  }

  private resolve(apps: readonly RunningApp[], ref: unknown): RunningApp | null {
    if (typeof ref === "number" || (typeof ref === "string" && /^\d+$/.test(ref.trim()))) return apps.find((app) => app.pid === Number(ref)) ?? null;
    const wanted = typeof ref === "string" ? ref.trim().toLowerCase() : "";
    if (!wanted) return null;
    return apps.find((app) => app.bundle?.toLowerCase() === wanted) ?? apps.find((app) => app.name.toLowerCase() === wanted) ?? apps.find((app) => app.name.toLowerCase().includes(wanted)) ?? null;
  }

  private async tree(params: Record<string, unknown>, ctx: Ctx): Promise<TreeResult> {
    await this.needAccessibility(ctx);
    await this.browsers();
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
    for (const key of [...this.trees.keys()].slice(0, Math.max(0, this.trees.size - 8))) this.trees.delete(key);
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

  /** One accessibility element in the helper's words: AT-SPI-like roles, a name, states, actions and its box inside the window (points). */
  private element(item: Record<string, unknown>, id: string, origin: { x: number; y: number }): HelperElement | null {
    const role = str(item.role) ?? "AXUnknown";
    const subrole = str(item.subrole) ?? "";
    const secure = item.is_password === true || /SecureTextField/.test(role) || /SecureTextField/.test(subrole);
    const input = secure || TEXT_INPUTS.has(role);
    const named = secure ? "password text" : SUBROLE_WORDS[subrole] ?? ROLE_WORDS[role] ?? (words(role) || "unknown");
    const label = str(item.label);
    const name = str(item.title) ?? str(item.description) ?? (input ? str(item.placeholder) : label ?? str(item.placeholder)) ?? "";
    const value = !secure && typeof item.value === "string" && item.value !== name ? item.value.slice(0, 500) : undefined;
    const acts = (Array.isArray(item.actions) ? item.actions : []).filter((action): action is string => typeof action === "string").map((action) => (action.startsWith("AX") ? words(action) : action.replace(/_/g, " ").toLowerCase()));
    if (!name && value === undefined && !acts.length && !input) return null;
    const states: string[] = [];
    if (item.enabled !== false) states.push("enabled", "sensitive");
    if (input && item.enabled !== false) states.push("editable");
    if (item.selected === true) states.push("selected");
    if (CHECKABLE.test(named) && (item.value === "1" || item.selected === true)) states.push("checked");
    const frame = obj(item.frame);
    const [x, y, w, h] = [num(frame.x), num(frame.y), num(frame.w), num(frame.h)];
    return {
      id,
      role: named,
      name: name.slice(0, 300),
      states,
      actions: acts,
      ...(value !== undefined ? { value } : {}),
      ...(x !== null && y !== null && w !== null && h !== null ? { box: [Math.round(x - origin.x), Math.round(y - origin.y), Math.round(w), Math.round(h)] as [number, number, number, number] } : {}),
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
      case "insert_text":
        answer = await this.tool("type_text", { element_token: token, text }, ctx, true);
        break;
      case "scroll_to":
        answer = await this.tool("scroll", { element_token: token, direction: "down", amount: 1 }, ctx, true);
        break;
      case "key": {
        const { modifiers, key } = parseCombo(String(params.keys ?? ""));
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
        throw new HelperError("unsupported_here", "On macOS an element takes the keyboard when it is pressed or typed into: press it, or type or set_text on it.", "no");
      default:
        throw new HelperError("invalid_params", `Unknown element action ${action}.`, "no");
    }
    this.proven.input = { state: "working", detail: "Accessibility actions go through." };
    const effect = str(answer.data.effect) ?? "unverifiable";
    return { done: effect !== "suspected_noop", via: str(answer.data.route) ?? "accessibility", verified: effect === "confirmed" ? true : effect === "partial" ? false : null, states_before: [], states_after: [], effect };
  }

  private noSecretWhileRecording(): HelperError {
    return new HelperError("unsupported_here", "A saved secret is never filled in while the screen is being recorded on macOS (the recording keeps notes of what each action sent): save or discard the recording first.", "no");
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
    await this.browsers();
    const ref = String(params.id ?? "").trim();
    const apps = await this.apps(ctx, false);
    const lower = ref.toLowerCase();
    const found = apps.find((app) => app.bundle?.toLowerCase() === lower) ?? apps.find((app) => app.name.toLowerCase() === lower) ?? apps.find((app) => app.launchPath === ref) ?? null;
    const started = this.now();
    const { data } = await this.tool("launch_app", found?.bundle ? { bundle_id: found.bundle } : { name: found?.launchPath ?? ref }, ctx, true).catch((error: unknown) => {
      if (error instanceof HelperError && error.kind === "target_not_found") throw new HelperError("launch_failed", `${ref} could not be opened: ${error.message}`, "no");
      throw error;
    });
    const pid = num(data.pid);
    const state = obj(data.launch_state);
    let wins = arr(data.windows)
      .map(winOf)
      .filter((win): win is Win => win !== null && win.layer === 0);
    const waitMs = Math.min(20_000, Math.max(0, num(params.wait_ms) ?? 8_000));
    while (pid !== null && !wins.length && this.now() - started < waitMs && ctx.until - this.now() > 2_000) {
      await this.sleep(300);
      wins = (await this.windows(ctx, pid)).filter((win) => win.pid === pid && win.layer === 0);
    }
    const app: RunningApp | null = pid !== null ? { pid, name: str(data.name) ?? found?.name ?? ref, bundle: str(data.bundle_id) ?? found?.bundle ?? null, active: false, launchPath: found?.launchPath ?? null } : null;
    return {
      app: { id: app?.bundle ?? found?.bundle ?? ref, name: app?.name ?? found?.name ?? ref, running: app ? this.helperApp(app, wins) : null },
      stages: { accepted: true, started: pid !== null && state.process_running !== false, window: wins.length > 0 || state.window_ready === true, focused: false },
      waited_ms: this.now() - started,
    };
  }

  private async bringToFront(params: Record<string, unknown>, ctx: Ctx): Promise<{ focused: boolean; via: string | null }> {
    const app = this.resolve(await this.apps(ctx), params.app);
    if (!app) return { focused: false, via: null };
    const win = (await this.windows(ctx, app.pid)).filter((item) => item.pid === app.pid && item.layer === 0 && !item.minimized).sort(byFront)[0];
    const { data } = await this.tool("bring_to_front", { pid: app.pid, ...(win ? { window_id: win.id } : {}) }, ctx, true);
    return { focused: data.activated === true, via: "activate" };
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
    if (action !== "click") throw new HelperError("unsupported_here", `Pointer ${action} is not available on macOS.`, "no");
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
    const { modifiers, key } = parseCombo(String(params.keys ?? ""));
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
   * the last key (`owner_input`: macOS's idle time is shorter than the time since it), and while one more chunk
   * would not fit in the request's time (`out_of_time`). Once anything was typed, a failure says how much.
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
        // A pause after the last key: input during it is not the driver's. The clock is read before macOS is
        // asked, so a slow answer never looks like input.
        await this.sleep(TYPING_PAUSE_MS);
        const checkedAt = this.now();
        const idle = await this.idleMs();
        if (idle !== null && idle + OWNER_INPUT_MARGIN_MS < checkedAt - lastKeyAt) return answer("owner_input");
        slowest = Math.max(slowest, this.now() - began);
      }
    } catch (error) {
      if (typed === 0) throw error;
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
    if (!sameWindow(top, startTop) || wins.some((win) => win.onScreen && PROMPT_APPS.test(win.app))) return true;
    return keyboardFloor(this.focusOf({ ...start, wins, top: top && top.pid === start.app?.pid ? top : start.top, prompt: null }, true)) !== null;
  }

  // ── recording ────────────────────────────────────────────────────────────

  private async recordStart(params: Record<string, unknown>, ctx: Ctx): Promise<Record<string, unknown>> {
    this.needSession();
    if (this.recording) throw new HelperError("recording_active", "The screen is being recorded already.", "no");
    const major = this.options.macosMajor;
    if (major === null || major < 15) throw new HelperError("unsupported_here", `Recording the screen needs macOS 15 or later${major !== null ? `; this Mac runs macOS ${major}` : ""}. Screenshots work.`, "no");
    const path = str(params.path);
    if (!path) throw new HelperError("invalid_params", "A recording needs a path.", "no");
    const id = `rec_${randomBytes(6).toString("hex")}`;
    const dir = join(this.options.workDir, "recordings", id);
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
    recording.timer = setTimeout(() => void this.serial(() => this.endRecording(recording, "max_duration", { until: this.now() + 30_000 })).catch(() => undefined), maxMs);
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

const MODIFIERS: Record<string, string> = { ctrl: "ctrl", control: "ctrl", alt: "option", option: "option", opt: "option", shift: "shift", super: "cmd", cmd: "cmd", command: "cmd", meta: "cmd", win: "cmd", fn: "fn" };
const KEY_NAMES: Record<string, string> = {
  return: "return",
  enter: "return",
  kp_enter: "return",
  escape: "escape",
  esc: "escape",
  tab: "tab",
  backspace: "delete",
  delete: "forwarddelete",
  del: "forwarddelete",
  space: "space",
  page_up: "pageup",
  pageup: "pageup",
  prior: "pageup",
  page_down: "pagedown",
  pagedown: "pagedown",
  next: "pagedown",
  home: "home",
  end: "end",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  plus: "=",
  minus: "-",
  comma: ",",
  period: ".",
  slash: "/",
};

/** `cmd+shift+t`, `Return`, `ctrl+a` in cua-driver's key names (macOS's Command is cmd, or super). */
export function parseCombo(combo: string): { modifiers: string[]; key: string } {
  const parts = combo
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (combo.trim().endsWith("++")) parts.push("+");
  const last = parts.pop();
  if (!last) throw new HelperError("invalid_params", "No key was named.", "no");
  const modifiers = parts.map((part) => {
    const name = MODIFIERS[part.toLowerCase()];
    if (!name) throw new HelperError("invalid_params", `${part} is not a modifier key (cmd, ctrl, option, shift, fn).`, "no");
    return name;
  });
  const lower = last.toLowerCase();
  const key = KEY_NAMES[lower] ?? (/^f(?:[1-9]|1[0-2])$/.test(lower) ? lower : [...last].length === 1 ? lower : null);
  if (!key) throw new HelperError("invalid_params", `${last} is not a key name cua-driver knows on macOS (return, escape, tab, delete, space, arrows, home, end, pageup, pagedown, f1 to f12, or one character).`, "no");
  return { modifiers: [...new Set(modifiers)], key };
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" } }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
  });
}
