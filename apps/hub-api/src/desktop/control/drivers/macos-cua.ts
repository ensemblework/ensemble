/**
 * Desktop control on macOS through cua-driver (MIT, github.com/trycua/cua; the version is pinned in
 * desktop-helper/macos/cua-driver.json), on the shared adapter (cua-adapter.ts) that speaks the Linux helper's
 * protocol, so DesktopService runs on top unchanged. cua-driver runs as `cua-driver mcp --direct` through
 * `ensemble-disclaim`, its own responsible process, so macOS asks about Accessibility and Screen Recording for Cua
 * Driver itself. What is macOS's own here: the grants (read with `check_permissions`, asked through Cua Driver's
 * permission host, proven by a real screenshot; macOS keeps a process's answer, so the driver is started again
 * after a check fails), idle time and the lock (`ioreg`), notices (`osascript`), browsers (bundle ids and the apps
 * LaunchServices opens https links with), AX roles, key names, the system's password prompts, points, and video
 * (ScreenCaptureKit, macOS 15 or later).
 */
import { execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HelperCommand } from "../helper-process.js";
import { HelperError, type Fact, type HelperElement, type Ran, type SessionInfo, type StatusResult } from "../protocol.js";
import { CuaAdapter, num, obj, str, type Ctx, type IdleState, type RunningApp, type Shot } from "./cua-adapter.js";

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


export class MacosCuaDriver extends CuaAdapter {
  protected readonly system = "macOS";
  private accessibilityOn = false;
  /** The missing grants macOS was last asked about, and when. */
  private asked: { missing: string; at: number } | null = null;
  /** Bundle ids (lower case) of the apps LaunchServices opens https links with, and until when they hold. */
  private handlers: { ids: ReadonlySet<string>; at: number } | null = null;

  constructor(private readonly options: MacosCuaOptions) {
    super({ ...options, label: "The macOS desktop driver" });
  }

  protected override onExit(info: { code: number | null; signal: string | null; expected: boolean }): void {
    this.accessibilityOn = false;
    super.onExit(info);
  }

  protected override consentError(code: string | null, text: string, ran: Ran): HelperError {
    this.accessibilityOn = false;
    const screen = /screen/i.test(code ?? "") || /screen recording|screen capture/i.test(text);
    const fix = screen ? this.screenFix() : this.accessFix();
    return new HelperError("consent_needed", `${screen ? RECORDING_OFF : ACCESSIBILITY_OFF} Fix: ${fix}`, ran, false, { ...(code ? { code } : {}), fix });
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

  protected async needAccessibility(ctx: Ctx): Promise<void> {
    if (this.accessibilityOn && this.mcp.running) return;
    const granted = await this.permissions(ctx);
    if (granted.accessibility) {
      this.accessibilityOn = true;
      return;
    }
    await this.refresh();
    throw new HelperError("consent_needed", `${ACCESSIBILITY_OFF} Fix: ${this.accessFix()}`, "no", false, { fix: this.accessFix(), permission: "accessibility" });
  }

  // ── status and the session ───────────────────────────────────────────────

  protected async status(ctx: Ctx): Promise<StatusResult> {
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
    return { facts, session: this.sessionView(), registered: false, recordings: this.recordingsView() };
  }

  /** Screen control starts when Screen Recording is on and a real screenshot proves it. */
  protected async sessionStart(ctx: Ctx): Promise<SessionInfo> {
    if (this.session) return { state: "on", epoch: this.session.epoch, streams: [this.session.stream] };
    const granted = await this.permissions(ctx);
    const fix = this.screenFix();
    if (!granted.screenRecording || granted.capturable === false) {
      await this.refresh();
      throw new HelperError("consent_needed", `${RECORDING_OFF} Fix: ${fix}`, "no", false, { fix, permission: "screen_recording" });
    }
    let shot: Shot;
    try {
      shot = await this.grab(64, ctx);
    } catch (error) {
      this.proven.capture = { state: "failed", detail: error instanceof Error ? error.message.slice(0, 200) : "The test screenshot failed.", fix };
      await this.refresh();
      const why = error instanceof Error ? ` (${error.message.slice(0, 160)})` : "";
      throw new HelperError("consent_needed", `A test screenshot failed${why}: macOS may be asking on the screen to allow ${DRIVER} to record it, or Screen Recording is off. Fix: allow it in the dialog if one shows; otherwise ${fix}`, "no", false, { fix, permission: "screen_recording" });
    }
    return this.begin(shot.native);
  }

  protected async idle(): Promise<IdleState> {
    const exec = this.options.exec ?? runCommand;
    const [idle_ms, root] = await Promise.all([this.idleMs(), exec("/usr/sbin/ioreg", ["-n", "Root", "-d", "1"], 3_000).catch(() => "")]);
    const locked = /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(root) ? true : /IOConsoleUsers/.test(root) ? false : null;
    return { locked, idle_ms };
  }

  /** How long ago anyone last used the keyboard or mouse (`HIDIdleTime`). */
  protected async idleMs(): Promise<number | null> {
    const exec = this.options.exec ?? runCommand;
    const hid = await exec("/usr/sbin/ioreg", ["-r", "-c", "IOHIDSystem", "-d", "1"], 3_000).catch(() => "");
    const idle = /"HIDIdleTime"\s*=\s*(\d+)/.exec(hid);
    return idle ? Math.floor(Number(idle[1]) / 1_000_000) : null;
  }

  protected async notice(params: Record<string, unknown>): Promise<{ shown: boolean }> {
    const exec = this.options.exec ?? runCommand;
    const title = (str(params.title) ?? "Ensemble").slice(0, 120);
    const body = (str(params.body) ?? "").slice(0, 300);
    await exec("/usr/bin/osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body], 5_000);
    return { shown: true };
  }

  // ── what macOS says about the screen and apps ────────────────────────────

  protected nativeSize(data: Record<string, unknown>, size: { width: number; height: number }): { width: number; height: number } {
    const scale = num(data.scale_factor);
    const points = { width: num(data.screen_width), height: num(data.screen_height) };
    const width = num(data.screenshot_original_width) ?? (points.width && scale ? Math.round(points.width * scale) : size.width);
    const height = num(data.screenshot_original_height) ?? (points.height && scale ? Math.round(points.height * scale) : size.height);
    return { width, height };
  }

  /** Window bounds are in points. */
  protected boundsScale(): number {
    return this.scale;
  }

  /** The apps that open https links: browsers the bundle list does not know. Read once every ten minutes. */
  protected override async beforeApps(): Promise<void> {
    const cached = this.handlers;
    if (cached && this.now() < cached.at) return;
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
  }

  protected toolkitOf(app: RunningApp): string {
    return toolkitOf(app.bundle, this.handlers?.ids);
  }

  protected appIdOf(app: RunningApp): string | null {
    return app.bundle;
  }

  protected promptApp(app: string): boolean {
    return PROMPT_APPS.test(app);
  }

  protected recordingUnavailable(): string | null {
    const major = this.options.macosMajor;
    return major === null || major < 15 ? `Recording the screen needs macOS 15 or later${major !== null ? `; this Mac runs macOS ${major}` : ""}. Screenshots work.` : null;
  }

  protected launchArgs(found: RunningApp | null, ref: string): Record<string, unknown> {
    return found?.bundle ? { bundle_id: found.bundle } : { name: found?.launchPath ?? ref };
  }

  protected parseKeys(combo: string): { modifiers: string[]; key: string } {
    return parseCombo(combo);
  }

  /** One accessibility element in the helper's words: AT-SPI-like roles, a name, states, actions and its box inside the window (points). */
  protected element(item: Record<string, unknown>, id: string, origin: { x: number; y: number }): HelperElement | null {
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
