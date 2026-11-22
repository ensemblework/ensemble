/**
 * Desktop control on Windows through cua-driver (MIT, github.com/trycua/cua; the version is pinned in
 * desktop-helper/windows/cua-driver.json), on the shared adapter (cua-adapter.ts) that speaks the Linux helper's
 * protocol, so DesktopService runs on top unchanged. `cua-driver.exe mcp --direct --no-overlay` owns its runtime
 * on this runtime's pipes: no daemon, named pipe or port, and no cursor of its own drawn on the screen. Windows
 * asks for no grant: UI Automation and input work for any program in the owner's session.
 *
 * What cua-driver does not say comes from the session probe (desktop-helper/windows/probe.ps1, PowerShell 5.1
 * with a little C#), a child process speaking the same line protocol: idle time (`GetLastInputInfo`), the desktop
 * that gets input (the lock screen and User Account Control's secure desktop take it, and nothing can type or
 * click there), whether consent.exe runs, the session (a service's session 0 has no screen), UI Automation, the
 * monitors and their DPI, and notices.
 *
 * Elements are UI Automation's: Invoke, Toggle, SelectionItem and ExpandCollapse by `click` on a token, Value by
 * `set_value` and `type_text` (which adds to the end of the element's text), keys by `press_key`/`hotkey` posted to
 * the element's window: none of them moves the owner's pointer or takes the focus. Windows and screenshots are in
 * screen pixels of the main display (cua-driver is per-monitor DPI aware). Apps are known by their program file
 * (`list_windows` names it), which tells browsers apart; the address of a page is read where an app's elements
 * show a web document with one. Video goes through ffmpeg (gdigrab), which is not part of Ensemble: without it
 * recording is unavailable and readiness says so.
 */
import type { HelperHealth } from "../helper-process.js";
import { HelperError, type Fact, type HelperElement, type SessionInfo, type StatusResult } from "../protocol.js";
import { CuaAdapter, num, obj, str, type CuaAdapterOptions, type Ctx, type IdleState, type RunningApp, type Win } from "./cua-adapter.js";
import { decodePng } from "./png.js";

/** The session probe (HelperProcess in the runtime, a stand-in in tests). */
export type WindowsProbe = {
  call<T>(method: string, params: Record<string, unknown>, options: { timeoutMs: number }): Promise<T>;
  stop(): Promise<void>;
  health(): HelperHealth;
};

export type ProbeIdle = { idle_ms: number | null; input_desktop: string | null; locked: boolean; uac: boolean; lock_screen?: boolean };
export type ProbeState = ProbeIdle & {
  session: { id: number; service: boolean; connect: string | null; visible: boolean };
  uia: boolean;
  uia_error?: string;
  dpi: number;
  monitors: Array<{ x: number; y: number; width: number; height: number; primary: boolean; dpi: number }>;
  os?: string;
};

export type WindowsCuaOptions = CuaAdapterOptions & {
  probe: WindowsProbe;
  /** Where ffmpeg is (cua-driver records video through it), or null when it is not installed. */
  ffmpeg?: () => string | null;
};

const DRIVER = "Cua Driver";
export const UAC_PROMPT = "User Account Control";
export const UAC_TEXT = "A User Account Control prompt is open on Windows' secure desktop: only your owner can answer it (nothing can type or click there). Hand it to them with desktop_handoff, saying what it is for, and wait.";
export const LOCKED_TEXT = "The computer's screen is locked: only your owner can unlock it. Ask them, or hand it over with desktop_handoff.";
export const NO_FFMPEG = "Recording the screen on Windows needs ffmpeg, which Cua Driver records through and Ensemble does not include. Fix: install it (winget install Gyan.FFmpeg), then restart Ensemble. Screenshots work.";
const NO_AGENT_SCREEN = "Windows has no private agent screen in this version: work happens on your owner's screen, in the background where it can.";

/** Windows' own password and permission prompts: User Account Control, credentials, the lock screen. */
const PROMPT_APPS = /^(?:consent|credentialuibroker|logonui|credwiz|lockapp)(?:\.exe)?$/i;

/** Browsers by their program file; a window of one is a page that cannot be read (it may show Ensemble). */
const BROWSERS: Array<{ toolkit: string; pattern: RegExp }> = [
  { toolkit: "Chromium", pattern: /^(?:chrome|msedge|brave|opera|opera_gx|launcher|vivaldi|arc|chromium|thorium|browser|comet|dia|yandex|whale|sidekick|island|epic|cent|maxthon|coccoc)$/i },
  { toolkit: "Gecko", pattern: /^(?:firefox|librewolf|waterfox|floorp|zen|mullvadbrowser|tor|palemoon|basilisk|seamonkey)$/i },
  { toolkit: "Web", pattern: /^(?:iexplore|msedgewebview2?)$/i },
];

/** A program file's name without its folder and `.exe`, in lower case. */
export function programName(path: string | null | undefined): string | null {
  const base = (path ?? "").trim().split(/[\\/]/).pop() ?? "";
  const name = base.replace(/\.exe$/i, "").toLowerCase();
  return name || null;
}

/** UI Automation's control types in AT-SPI's words. */
const ROLE_WORDS: Record<string, string> = {
  Button: "push button",
  SplitButton: "push button",
  CheckBox: "check box",
  RadioButton: "radio button",
  ComboBox: "combo box",
  Edit: "text",
  Document: "document text",
  Hyperlink: "link",
  Image: "image",
  List: "list",
  ListItem: "list item",
  Menu: "menu",
  MenuBar: "menu bar",
  MenuItem: "menu item",
  ProgressBar: "progress bar",
  ScrollBar: "scroll bar",
  Slider: "slider",
  Spinner: "spin button",
  StatusBar: "status bar",
  Tab: "page tab list",
  TabItem: "page tab",
  Text: "label",
  ToolBar: "tool bar",
  ToolTip: "tool tip",
  Tree: "tree",
  TreeItem: "tree item",
  Group: "panel",
  Pane: "panel",
  Window: "frame",
  TitleBar: "title bar",
  DataGrid: "table",
  DataItem: "table row",
  Table: "table",
  Header: "header",
  HeaderItem: "column header",
  Separator: "separator",
  Calendar: "calendar",
  AppBar: "tool bar",
  Thumb: "thumb",
  SemanticZoom: "panel",
};
const ACTION_WORDS: Record<string, string> = { invoke: "press", toggle: "toggle", select: "select", expand: "expand", set_value: "set value", text: "text", scroll: "scroll" };
const TEXT_INPUTS = new Set(["Edit", "Document", "ComboBox"]);
const CHECKABLE = /check box|radio button|toggle button|page tab/;
const URL_VALUE = /^(?:https?|file):\/\/\S+$/i;

/** Where `ffmpeg.exe` is: on the PATH, from winget (its package folder and links), Chocolatey or C:\tools; null when none. */
export function findFfmpeg(env: NodeJS.ProcessEnv, exists: (path: string) => boolean, list: (dir: string) => string[] = () => []): string | null {
  const path = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const local = Object.entries(env).find(([key]) => key.toUpperCase() === "LOCALAPPDATA")?.[1] ?? "";
  const dirs = path.split(";").map((dir) => dir.trim().replace(/^"|"$/g, "")).filter(Boolean);
  const candidates = dirs.map((dir) => `${dir.replace(/[\\/]+$/, "")}\\ffmpeg.exe`);
  if (local) {
    candidates.push(`${local}\\Microsoft\\WinGet\\Links\\ffmpeg.exe`);
    const packages = `${local}\\Microsoft\\WinGet\\Packages`;
    for (const name of list(packages).filter((entry) => entry.startsWith("Gyan.FFmpeg"))) {
      for (const inner of list(`${packages}\\${name}`)) candidates.push(`${packages}\\${name}\\${inner}\\bin\\ffmpeg.exe`);
    }
  }
  candidates.push("C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe", "C:\\tools\\ffmpeg\\bin\\ffmpeg.exe");
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/** Why screen control cannot work in this session now, or null. */
export function sessionProblem(state: ProbeState | null, lock = true): string | null {
  if (!state) return null;
  if (state.session.service) return "Ensemble runs in Windows' session 0 here (as a service), which has no screen: run the Ensemble app, or `ensemble` in a terminal, signed in to Windows as the owner.";
  if (!state.session.visible) return "Ensemble runs in a Windows session whose screen is not shown (a non-interactive window station): run the Ensemble app, or `ensemble` in a terminal, signed in to Windows as the owner.";
  if (state.session.connect && state.session.connect !== "active") return `This Windows session is ${state.session.connect === "disconnected" ? "disconnected (a remote desktop closed without signing out)" : state.session.connect}, so its screen shows nothing: your owner signs in to it again.`;
  if (lock && state.uac) return UAC_TEXT;
  if (lock && state.locked) return LOCKED_TEXT;
  return null;
}

export class WindowsCuaDriver extends CuaAdapter {
  protected readonly system = "Windows";
  /** The session was seen interactive (UI Automation can work); checked again after the driver restarts. */
  private sessionOk = false;

  constructor(private readonly options: WindowsCuaOptions) {
    super({ ...options, label: "The Windows desktop driver" });
  }

  override async stop(): Promise<void> {
    await super.stop();
    await this.options.probe.stop().catch(() => undefined);
  }

  protected override onExit(info: { code: number | null; signal: string | null; expected: boolean }): void {
    this.sessionOk = false;
    super.onExit(info);
  }

  private async probeIdle(): Promise<ProbeIdle | null> {
    try {
      return await this.options.probe.call<ProbeIdle>("idle", {}, { timeoutMs: 5_000 });
    } catch (error) {
      this.base.log?.(`the Windows session probe did not answer: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`);
      return null;
    }
  }

  private async probeState(): Promise<{ state: ProbeState | null; error: string | null }> {
    try {
      return { state: await this.options.probe.call<ProbeState>("state", {}, { timeoutMs: 20_000 }), error: null };
    } catch (error) {
      return { state: null, error: error instanceof Error ? error.message.slice(0, 300) : "The Windows session probe did not answer." };
    }
  }

  private ffmpeg(): string | null {
    return this.options.ffmpeg?.() ?? null;
  }

  // ── status and the session ───────────────────────────────────────────────

  protected async status(ctx: Ctx): Promise<StatusResult> {
    const { state, error } = await this.probeState();
    const rights = await this.tool("check_permissions", {}, ctx).then(({ data }) => data, () => ({}) as Record<string, unknown>);
    const level = str(rights.integrity_level);
    const problem = sessionProblem(state, false);
    const primary = state?.monitors.find((monitor) => monitor.primary) ?? state?.monitors[0] ?? null;
    const scale = primary ? Math.round((primary.dpi / 96) * 100) : null;
    const idle = state ? { locked: state.locked, idle_ms: state.idle_ms, uac: state.uac } : { locked: null, idle_ms: null, uac: false };
    const ffmpeg = this.ffmpeg();
    const facts: Record<string, Fact> = {
      driver: { state: "working", detail: `${DRIVER} ${this.mcp.health().version ?? this.base.version} (cua-driver.exe), started by Ensemble${level ? `, ${level} integrity` : ""}${rights.elevated === true ? ": it runs as administrator, like the Ensemble that started it" : ""}.` },
      session: !state ? { state: "untested", detail: `The Windows session probe did not answer (${error ?? "no answer"}), so idle time, the lock and User Account Control prompts cannot be read.`, fix: "Your owner checks that Windows PowerShell 5.1 can run here (an organisation's policy may block it)." } : problem ? { state: "failed", detail: problem, session: state.session } : { state: "working", detail: `Session ${state.session.id}, interactive.`, session: state.session },
      uia: !state ? { state: "untested" } : state.uia ? { state: "working", detail: "UI Automation answers." } : { state: "failed", detail: `UI Automation did not answer${state.uia_error ? ` (${state.uia_error.slice(0, 160)})` : ""}.` },
      dpi: primary ? { state: "working", detail: `${state!.monitors.length} monitor(s); the main one ${primary.width}×${primary.height} pixels at ${scale}% (${primary.dpi} dpi). Screenshots and clicks are in its pixels; windows on other monitors are reached through their elements.`, scale: primary.dpi / 96, monitors: state!.monitors } : { state: "untested" },
      capture: this.proven.capture,
      input: this.proven.input,
      recorder: ffmpeg ? { state: "working", detail: `MP4 (H.264) through ffmpeg (${ffmpeg}).` } : { state: "failed", detail: NO_FFMPEG, fix: "winget install Gyan.FFmpeg" },
      screen: idle.locked === null ? { state: "untested", detail: "Windows did not say whether the screen is locked.", idle_ms: idle.idle_ms } : idle.uac ? { state: "locked", detail: UAC_TEXT, idle_ms: idle.idle_ms } : idle.locked ? { state: "locked", detail: "The screen is locked.", fix: "Your owner unlocks it at the computer; Ensemble never types a password.", idle_ms: idle.idle_ms } : { state: "unlocked", idle_ms: idle.idle_ms },
      agent_screen: { state: "failed", detail: NO_AGENT_SCREEN },
    };
    return { facts, session: this.sessionView(), registered: false, recordings: this.recordingsView() };
  }

  /** Screen control starts in an interactive, unlocked session once a real screenshot that is not blank proves it. */
  protected async sessionStart(ctx: Ctx): Promise<SessionInfo> {
    if (this.session) return { state: "on", epoch: this.session.epoch, streams: [this.session.stream] };
    const { state } = await this.probeState();
    const problem = sessionProblem(state);
    if (problem) throw new HelperError("no_session", problem, "no");
    try {
      const shot = await this.grab(64, ctx);
      const pixels = decodePng(shot.png);
      let lit = false;
      for (let at = 0; at < pixels.data.length && !lit; at += 4) lit = pixels.data[at]! > 8 || pixels.data[at + 1]! > 8 || pixels.data[at + 2]! > 8;
      if (!lit) throw new HelperError("capture_failed", "the picture was black", "no");
      return this.begin(shot.native);
    } catch (error) {
      const why = error instanceof Error ? error.message.slice(0, 160) : "it failed";
      this.proven.capture = { state: "failed", detail: `A test screenshot failed (${why}).` };
      throw new HelperError("capture_failed", `A test screenshot failed (${why}): the screen may be locked or showing a secure desktop, or this session's screen is not shown. Look again in a moment, or ask your owner.`, "no");
    }
  }

  /** UI Automation works in the owner's interactive session; a service's session has no screen. */
  protected async needAccessibility(): Promise<void> {
    if (this.sessionOk && this.mcp.running) return;
    const { state } = await this.probeState();
    const problem = sessionProblem(state, false);
    if (problem) throw new HelperError("no_session", problem, "no");
    this.sessionOk = true;
  }

  protected async idle(): Promise<IdleState> {
    const idle = await this.probeIdle();
    return idle ? { locked: idle.locked, idle_ms: idle.idle_ms, ...(idle.uac ? { why: UAC_TEXT } : {}) } : { locked: null, idle_ms: null };
  }

  protected async idleMs(): Promise<number | null> {
    return (await this.probeIdle())?.idle_ms ?? null;
  }

  protected async notice(params: Record<string, unknown>): Promise<{ shown: boolean }> {
    const title = (str(params.title) ?? "Ensemble").slice(0, 120);
    const body = (str(params.body) ?? "").slice(0, 300);
    return this.options.probe.call<{ shown: boolean }>("notify", { title, body }, { timeoutMs: 5_000 }).catch(() => ({ shown: false }));
  }

  // ── what Windows says about the screen and apps ──────────────────────────

  protected nativeSize(data: Record<string, unknown>, size: { width: number; height: number }): { width: number; height: number } {
    return { width: num(data.screenshot_original_width) ?? size.width, height: num(data.screenshot_original_height) ?? size.height };
  }

  /** Window bounds are screen pixels already. */
  protected boundsScale(): number {
    return 1;
  }

  /** The clock is in the task bar, at the bottom by default. */
  protected override probeRows(height: number): { top: number; bottom: number } {
    return { top: 0, bottom: Math.ceil(height * 0.06) };
  }

  /** The app's program file: from its windows (`list_windows` names it), else from where it was launched from. */
  private program(app: RunningApp, wins: readonly Win[]): string | null {
    const own = wins.find((win) => win.pid === app.pid && win.app);
    return programName(own?.app) ?? (app.launchPath && /\.exe"?(?:\s|$)/i.test(app.launchPath) ? programName(app.launchPath.replace(/^"([^"]+)".*$/, "$1").replace(/\.exe\s.*$/i, ".exe")) : null) ?? (/\.exe$/i.test(app.name) ? programName(app.name) : null);
  }

  /** A browser's engine, `Prompt` for Windows' own prompts (the floor refuses them), `Windows` for any other app. */
  protected toolkitOf(app: RunningApp, wins: readonly Win[]): string {
    const program = this.program(app, wins);
    if (program && PROMPT_APPS.test(program)) return "Prompt";
    return (program && BROWSERS.find((browser) => browser.pattern.test(program))?.toolkit) ?? "Windows";
  }

  /** The id the app's installed entry has (what desktop_apps lists and the asks use), else its program file. */
  protected appIdOf(app: RunningApp, wins: readonly Win[]): string | null {
    const program = this.program(app, wins);
    return app.bundle ?? (program ? `${program}.exe` : null);
  }

  protected promptApp(app: string): boolean {
    return PROMPT_APPS.test(app.trim());
  }

  /** A prompt window on the owner's desktop, else User Account Control's secure desktop (no window to see). */
  protected override async promptOf(apps: readonly RunningApp[], wins: readonly Win[]): Promise<{ title: string } | null> {
    const shown = await super.promptOf(apps, wins);
    if (shown) return shown;
    const idle = await this.probeIdle();
    return idle?.uac ? { title: UAC_PROMPT } : idle?.locked ? { title: "the lock screen" } : null;
  }

  protected override async promptShown(wins: readonly Win[]): Promise<boolean> {
    if (await super.promptShown(wins)) return true;
    const idle = await this.probeIdle();
    return Boolean(idle?.uac || idle?.locked);
  }

  /** The address of a web document among the elements (Chromium, Edge and WebView2 give it as the document's value). */
  protected override pageOf(elements: ReadonlyArray<Record<string, unknown>>): string | null {
    for (const item of elements) {
      const value = str(item.value)?.trim();
      if (str(item.role) === "Document" && value && URL_VALUE.test(value)) return value;
    }
    return null;
  }

  protected recordingUnavailable(): string | null {
    return this.ffmpeg() ? null : NO_FFMPEG;
  }

  protected launchArgs(found: RunningApp | null, ref: string): Record<string, unknown> {
    // A packaged app starts through its AppUserModelID, so the answer names its own process (not a launcher's).
    const aumid = /^shell:appsfolder\\(.+!.+)$/i.exec(found?.launchPath ?? "")?.[1];
    if (aumid && this.mcp.takes("launch_app", "aumid")) return { aumid };
    if (found?.launchPath && this.mcp.takes("launch_app", "launch_path")) return { launch_path: found.launchPath };
    if (found?.bundle && found.bundle.includes("!")) return { bundle_id: found.bundle };
    const path = found?.launchPath ?? ref;
    if (/[\\/]|\.exe$/i.test(path) && this.mcp.takes("launch_app", "path")) return { path };
    return { name: found?.name ?? ref };
  }

  protected parseKeys(combo: string): { modifiers: string[]; key: string } {
    return parseWindowsCombo(combo);
  }

  /** One UI Automation element in the helper's words: AT-SPI-like roles, a name, states, actions and its box inside the window. */
  protected element(item: Record<string, unknown>, id: string, origin: { x: number; y: number }): HelperElement | null {
    const type = str(item.role) ?? "Custom";
    const raw = (Array.isArray(item.actions) ? item.actions : []).filter((action): action is string => typeof action === "string");
    const secure = item.is_password === true;
    const input = secure || (TEXT_INPUTS.has(type) && (type === "Edit" || raw.includes("set_value") || raw.includes("text")));
    const named = secure ? "password text" : type === "Document" && item.in_web_content === true ? "document web" : type === "Button" && raw.includes("toggle") ? "toggle button" : ROLE_WORDS[type] ?? (type.toLowerCase() || "unknown");
    const name = str(item.label) ?? "";
    const value = !secure && typeof item.value === "string" && item.value !== name ? item.value.slice(0, 500) : undefined;
    const acts = [...new Set(raw.map((action) => ACTION_WORDS[action] ?? action.replace(/_/g, " ").toLowerCase()))];
    if (!name && value === undefined && !acts.length && !input) return null;
    const states: string[] = [];
    if (item.enabled !== false) states.push("enabled", "sensitive");
    if (input && item.enabled !== false) states.push("editable");
    if (item.selected === true) states.push(CHECKABLE.test(named) ? "checked" : "selected");
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
}

const MODIFIERS: Record<string, string> = { ctrl: "ctrl", control: "ctrl", cmd: "ctrl", command: "ctrl", alt: "alt", option: "alt", opt: "alt", shift: "shift", win: "win", windows: "win", super: "win", meta: "win" };
const KEY_NAMES: Record<string, string> = {
  return: "return",
  enter: "return",
  kp_enter: "return",
  escape: "escape",
  esc: "escape",
  tab: "tab",
  backspace: "backspace",
  delete: "delete",
  del: "delete",
  insert: "insert",
  ins: "insert",
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

/** `ctrl+shift+t`, `Return`, `alt+F4` in cua-driver's key names on Windows (a Mac's cmd is ctrl here, super is the Windows key). */
export function parseWindowsCombo(combo: string): { modifiers: string[]; key: string } {
  const parts = combo
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (combo.trim().endsWith("++")) parts.push("+");
  const last = parts.pop();
  if (!last) throw new HelperError("invalid_params", "No key was named.", "no");
  const modifiers = parts.map((part) => {
    const name = MODIFIERS[part.toLowerCase()];
    if (!name) throw new HelperError("invalid_params", `${part} is not a modifier key (ctrl, alt, shift, win).`, "no");
    return name;
  });
  const lower = last.toLowerCase();
  const key = KEY_NAMES[lower] ?? (/^f(?:[1-9]|1[0-2])$/.test(lower) ? lower : [...last].length === 1 ? lower : null);
  if (!key) throw new HelperError("invalid_params", `${last} is not a key name cua-driver knows on Windows (return, escape, tab, backspace, delete, space, arrows, home, end, pageup, pagedown, f1 to f12, or one character).`, "no");
  return { modifiers: [...new Set(modifiers)], key };
}
