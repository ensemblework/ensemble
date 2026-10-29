/**
 * The browser broker (ensemble-node design B10): one Playwright Chromium per profile, kept in
 * Ensemble's data folder, driven through a small typed tool set by two callers, the node's device
 * tools and a coding agent's run MCP server. There is no script evaluation and no raw CDP: an agent
 * can read a page, act on it and capture it, never its cookies or storage.
 *
 * Every tab belongs to one operation (a job attempt or a node tool operation); no other operation
 * can drive or read it. Leases end with inactivity: the janitor closes expired tabs and browsers
 * left idle. A tab marked sensitive (a sign-in or a takeover) refuses every capture and every
 * action except waiting for a URL, and its live view pauses.
 */
import { constants as fsConstants } from "node:fs";
import { open as openFile, realpath, rm, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, sep } from "node:path";
import { chromium, devices, type Browser, type BrowserContext, type Download, type Page } from "playwright-core";
import { redactRequestUrl } from "../lib/redact.js";
import { chooseVideoEncoder, findFfmpegs } from "../capture/ffmpeg.js";
import { RealtimeRecording } from "../capture/frames.js";
import { CaptureError, DEFAULT_MAX_DURATION_MS, reserveFile, slugName, stillFile, VideoEncoder, type MediaFile } from "../capture/media.js";
import { findChromium, type ChromiumChoice } from "./chromium.js";
import { scanPage, sensitiveMasks, sensitiveSnapshotRefs } from "./page-scan.js";
import { browserProfileDir, ensembleDataHome, isProfileName } from "./paths.js";
import { hasSecrets, hideSecrets, holdReason, redactSnapshot, SECRET_MIN_LENGTH, SENSITIVE_SELECTOR, siteRule, type PrivacyRules } from "./privacy.js";

export type BrowserErrorCode = "not_found" | "not_yours" | "sensitive" | "refused" | "bad_input" | "unavailable" | "busy" | "timeout" | "failed";

export class BrowserError extends Error {
  constructor(
    public readonly code: BrowserErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BrowserError";
  }
}

export type LiveFrame = {
  operation: string;
  tab: string;
  url: string;
  title: string;
  at: string;
  /** A small JPEG; absent while the view is paused. Shown to the owner only, never stored. */
  jpeg?: Buffer;
  width?: number;
  height?: number;
  paused?: "sensitive" | "private_site" | "secret_on_screen";
};

export type ConsoleEntry = { at: string; type: string; text: string; location?: string };
export type NetworkEntry = { at: string; method: string; url: string; status?: number; failure?: string; resourceType: string };

export type TabInfo = {
  tab: string;
  url: string;
  title: string;
  profile: string | null;
  headless: boolean;
  sensitive: boolean;
  recording: "video" | "trace" | null;
  expiresAt: string;
};

export type OpenOptions = {
  /** Navigate this tab instead of opening a new one. */
  tab?: string;
  /** A persistent profile (default "default"), or a private context with `private`. */
  profile?: string;
  private?: boolean;
  /** Show a window, when this computer has a display. */
  headed?: boolean;
  /** A Playwright device to emulate (private tabs only), such as "iPhone 13". */
  device?: string;
  viewport?: { width: number; height: number };
  /** Install Playwright's clock before the page loads (capture's frame-stepped video). */
  clock?: boolean;
};

export type OperationOptions = {
  /** Where screenshots, downloads, traces and videos are written (the run's evidence folder). */
  evidenceDir?: string;
  /** Folders `upload` may send files from, besides `evidenceDir` (files the owner attached). */
  uploadRoots?: string[];
  /** Live view: a small JPEG about every 3 s while the operation holds a tab. */
  onLiveFrame?: (frame: LiveFrame) => void;
  /** How long a tab lives without use (default: the broker's). */
  leaseMs?: number;
  /** The longest video `record` makes (default two minutes). */
  maxVideoMs?: number;
};

export type BrokerOptions = {
  dataHome?: string;
  /** A Chromium to use instead of the one `findChromium` picks. */
  executablePath?: string;
  leaseMs?: number;
  idleBrowserMs?: number;
  janitorMs?: number;
  liveViewMs?: number;
  snapshotChars?: number;
  maxTabsPerOperation?: number;
  privacy?: () => PrivacyRules | Promise<PrivacyRules>;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  now?: () => number;
  log?: (message: string) => void;
};

type ContextEntry = {
  key: string;
  profile: string | null;
  owner: string | null;
  context: BrowserContext;
  headless: boolean;
  idleSince: number | null;
  tracing: { operation: string; tab: string; held: string | null } | null;
};

type Recording = { kind: "video"; video: RealtimeRecording; watch: { held: string | null } } | { kind: "trace" };

type Tab = {
  id: string;
  operation: string;
  page: Page;
  entry: ContextEntry;
  lastUsed: number;
  expiresAt: number;
  sensitive: boolean;
  consoleLog: ConsoleEntry[];
  network: NetworkEntry[];
  downloads: Download[];
  recording: Recording | null;
};

type Operation = {
  id: string;
  options: OperationOptions;
  live: { timer: NodeJS.Timeout; busy: boolean; paused: LiveFrame["paused"] | null; quality: number } | null;
  lastUsed: number;
};

const LOG_LIMIT = 300;
const PRIVATE_IDLE_MS = 30_000;
const PREVIEW_REASON = "The owner asked to see captures of this site before they are sent.";
const EXPOSED_REASON = "A one-time code or card field was on screen.";
const REF = /^(?:f\d+)?e\d+$/;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const MAX_UPLOAD = 50 * 1024 * 1024;
const MAX_DOWNLOAD = 100 * 1024 * 1024;
const CREDENTIAL_NAME = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pgpass|\.git-credentials|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ovpn))$/i;

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".html": "text/html",
};

export function mimeFor(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}

/** Only web pages: `file:`, `chrome:`, `javascript:` and the like would reach past the browser. */
export function checkUrl(url: string): string {
  if (url === "about:blank") return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BrowserError("bad_input", `"${url.slice(0, 200)}" is not a full URL. Give one starting with http:// or https://.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new BrowserError("refused", `The browser opens http and https pages only, not ${parsed.protocol} addresses.`);
  return parsed.toString();
}

/** A snapshot reference, or else a CSS selector. */
export function elementSelector(target: string): string {
  if (!target || target.length > 500) throw new BrowserError("bad_input", "Give an element reference from a snapshot, or a CSS selector.");
  return REF.test(target) ? `aria-ref=${target}` : `css=${target}`;
}

function checkRef(ref: string): string {
  if (!REF.test(ref)) throw new BrowserError("bad_input", `"${String(ref).slice(0, 40)}" is not an element reference. Use a [ref=…] value from the latest snapshot.`);
  return ref;
}

/** A display the browser can show a window on. */
export function hasDisplay(env: NodeJS.ProcessEnv, platform: string): boolean {
  if (platform === "darwin" || platform === "win32") return true;
  return Boolean(env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim());
}

export class BrowserBroker {
  private readonly options: Required<Pick<BrokerOptions, "leaseMs" | "idleBrowserMs" | "janitorMs" | "liveViewMs" | "snapshotChars" | "maxTabsPerOperation">> & BrokerOptions;
  private readonly contexts = new Map<string, ContextEntry>();
  private readonly launching = new Map<string, Promise<ContextEntry>>();
  private readonly tabs = new Map<string, Tab>();
  private readonly pageTabs = new WeakMap<Page, Tab>();
  private readonly operations = new Map<string, Operation>();
  private privateBrowser: Promise<Browser> | null = null;
  private janitor: NodeJS.Timeout | null = null;
  private counter = 0;
  private closed = false;

  constructor(options: BrokerOptions = {}) {
    this.options = {
      leaseMs: 10 * 60_000,
      idleBrowserMs: 5 * 60_000,
      janitorMs: 15_000,
      liveViewMs: 3_000,
      snapshotChars: 24_000,
      maxTabsPerOperation: 50,
      ...options,
    };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private log(message: string): void {
    this.options.log?.(`browser: ${message}`);
  }

  private async rules(): Promise<PrivacyRules> {
    return (await this.options.privacy?.()) ?? {};
  }

  /** The owner's privacy rules, as the broker applies them (capture uses the same). */
  privacyRules(): Promise<PrivacyRules> {
    return this.rules();
  }

  private dataHome(): string {
    return this.options.dataHome ?? ensembleDataHome(this.options.env);
  }

  /** The Chromium the broker launches, or why there is none. */
  chromium(headless: boolean): ChromiumChoice | null {
    if (this.options.executablePath) return { executablePath: this.options.executablePath, kind: "chromium", revision: null, matches: false, source: "explicit" };
    return findChromium({ headless, dataHome: this.dataHome() });
  }

  private executable(headless: boolean): string {
    const choice = this.chromium(headless) ?? (headless ? null : this.chromium(true));
    if (!choice) throw new BrowserError("unavailable", "No Chromium on this computer. Run `ensemble capture setup` to install Playwright's Chromium.");
    return choice.executablePath;
  }

  private startJanitor(): void {
    if (this.janitor || this.closed) return;
    this.janitor = setInterval(() => void this.sweep().catch((error: unknown) => this.log(`janitor: ${String(error)}`)), this.options.janitorMs);
    this.janitor.unref();
  }

  // ── operations ────────────────────────────────────────────────────────────

  /** The tool set for one operation. Options given here replace earlier ones for that operation. */
  operation(id: string, options?: OperationOptions): BrowserOperation {
    if (!id || id.length > 200) throw new BrowserError("bad_input", "An operation id is required.");
    let op = this.operations.get(id);
    if (!op) {
      op = { id, options: {}, live: null, lastUsed: this.now() };
      this.operations.set(id, op);
    }
    if (options) {
      op.options = { ...op.options, ...options };
      if (!options.onLiveFrame && op.live && "onLiveFrame" in options) this.stopLive(op);
    }
    this.updateLive(op);
    return new BrowserOperation(this, id, op.options);
  }

  /** The operation's record, made again with the facade's options if the janitor forgot it while it was idle. */
  private op(id: string, revive?: OperationOptions): Operation {
    let op = this.operations.get(id);
    if (!op) {
      if (!revive) throw new BrowserError("not_found", "Unknown operation.");
      op = { id, options: { ...revive }, live: null, lastUsed: this.now() };
      this.operations.set(id, op);
    }
    op.lastUsed = this.now();
    return op;
  }

  /** For the facade: keeps the operation known, with the options it was given. */
  keep(id: string, options: OperationOptions): void {
    const op = this.op(id, options);
    this.updateLive(op);
  }

  private tabsOf(operation: string): Tab[] {
    return [...this.tabs.values()].filter((tab) => tab.operation === operation);
  }

  /** The tab, if this operation owns it. Using it renews its lease. */
  private tab(operation: string, id: string, purpose: "act" | "observe" | "close" | "wait" = "act"): Tab {
    const tab = this.tabs.get(id);
    if (!tab || tab.page.isClosed()) throw new BrowserError("not_found", `There is no tab ${id}. Open one with browser_open.`);
    if (tab.operation !== operation) throw new BrowserError("not_yours", `Tab ${id} belongs to other work. Open your own tab.`);
    if (tab.sensitive && purpose !== "close" && purpose !== "wait") {
      throw new BrowserError("sensitive", `Tab ${id} is in a sign-in or takeover step. It cannot be read, captured or driven until the owner finishes.`);
    }
    const op = this.op(operation);
    tab.lastUsed = this.now();
    tab.expiresAt = tab.lastUsed + (op.options.leaseMs ?? this.options.leaseMs);
    return tab;
  }

  private evidenceDir(operation: string): string {
    const dir = this.op(operation).options.evidenceDir;
    if (!dir) throw new BrowserError("unavailable", "This work has no evidence folder, so nothing can be saved from the browser.");
    return dir;
  }

  private info(tab: Tab): TabInfo {
    return {
      tab: tab.id,
      url: tab.page.isClosed() ? "" : tab.page.url(),
      title: "",
      profile: tab.entry.profile,
      headless: tab.entry.headless,
      sensitive: tab.sensitive,
      recording: tab.recording?.kind ?? (tab.entry.tracing?.tab === tab.id ? "trace" : null),
      expiresAt: new Date(tab.expiresAt).toISOString(),
    };
  }

  private async describe(tab: Tab): Promise<TabInfo> {
    const info = this.info(tab);
    info.title = tab.sensitive || tab.page.isClosed() ? "" : await tab.page.title().catch(() => "");
    return info;
  }

  // ── contexts ──────────────────────────────────────────────────────────────

  private async contextFor(operation: string, input: { profile: string | null; headed: boolean; device?: string; viewport?: { width: number; height: number } }): Promise<{ entry: ContextEntry; note?: string }> {
    const wantHeadless = !input.headed || !hasDisplay(this.options.env ?? process.env, this.options.platform ?? process.platform);
    const note = input.headed && wantHeadless ? "There is no display on this computer, so the browser runs without a window." : undefined;
    if (input.profile === null) {
      const key = `private:${operation}`;
      const existing = this.contexts.get(key);
      if (existing) return { entry: existing, note };
      const pending = this.launching.get(key) ?? this.launchPrivate(key, operation, input.device, input.viewport);
      this.launching.set(key, pending);
      try {
        return { entry: await pending, note };
      } finally {
        this.launching.delete(key);
      }
    }
    if (input.device) throw new BrowserError("bad_input", "Device emulation needs a private tab (private: true); the profile's browser keeps its own settings.");
    const key = `profile:${input.profile}`;
    const existing = this.contexts.get(key);
    if (existing) {
      if (existing.tracing && existing.tracing.operation !== operation) throw new BrowserError("busy", "Other work is recording a trace in this browser profile. Try again when it ends, or use a private tab.");
      if (existing.headless === wantHeadless) return { entry: existing, note };
      // Switching between a window and none restarts the browser, so only when no tab is open in it.
      const open = [...this.tabs.values()].some((tab) => tab.entry === existing);
      if (open) return { entry: existing, note: `The browser is already open ${existing.headless ? "without" : "with"} a window, so this tab opens there.` };
      await this.closeContext(existing);
    }
    const pending = this.launching.get(key) ?? this.launchProfile(key, input.profile, wantHeadless);
    this.launching.set(key, pending);
    try {
      return { entry: await pending, note };
    } finally {
      this.launching.delete(key);
    }
  }

  private async launchProfile(key: string, profile: string, headless: boolean): Promise<ContextEntry> {
    const platform = this.options.platform ?? process.platform;
    const args = !headless && platform === "linux" ? ["--ozone-platform-hint=auto"] : [];
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(browserProfileDir(profile, this.dataHome()), {
        executablePath: this.executable(headless),
        headless,
        viewport: DEFAULT_VIEWPORT,
        acceptDownloads: true,
        args,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
    } catch (error) {
      if (error instanceof BrowserError) throw error;
      const message = error instanceof Error ? error.message.split("\n")[0]! : String(error);
      throw new BrowserError("unavailable", /ProcessSingleton|SingletonLock|profile.*in use/i.test(message) ? `The browser profile "${profile}" is open in another Chromium. Close it first.` : `The browser did not start: ${message}`);
    }
    const entry: ContextEntry = { key, profile, owner: null, context, headless, idleSince: this.now(), tracing: null };
    this.watchContext(entry);
    this.log(`started profile ${profile} (${headless ? "headless" : "with a window"})`);
    return entry;
  }

  private async launchPrivate(key: string, operation: string, device?: string, viewport?: { width: number; height: number }): Promise<ContextEntry> {
    let emulation = {};
    if (device) {
      const descriptor = devices[device];
      if (!descriptor) throw new BrowserError("bad_input", `Unknown device "${device}". Use a Playwright device name such as "iPhone 13" or "Pixel 7".`);
      const { defaultBrowserType: _ignored, ...rest } = descriptor;
      emulation = rest;
    }
    this.privateBrowser ??= chromium.launch({ executablePath: this.executable(true), headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    let browser: Browser;
    try {
      browser = await this.privateBrowser;
    } catch (error) {
      this.privateBrowser = null;
      if (error instanceof BrowserError) throw error;
      throw new BrowserError("unavailable", `The browser did not start: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
    const context = await browser.newContext({ viewport: DEFAULT_VIEWPORT, acceptDownloads: true, ...emulation, ...(viewport ? { viewport } : {}) });
    const entry: ContextEntry = { key, profile: null, owner: operation, context, headless: true, idleSince: this.now(), tracing: null };
    this.watchContext(entry);
    return entry;
  }

  private watchContext(entry: ContextEntry): void {
    this.contexts.set(entry.key, entry);
    entry.context.on("close", () => {
      if (this.contexts.get(entry.key) === entry) this.contexts.delete(entry.key);
      for (const tab of [...this.tabs.values()]) if (tab.entry === entry) this.forgetTab(tab);
    });
    this.startJanitor();
  }

  private async closeContext(entry: ContextEntry): Promise<void> {
    this.contexts.delete(entry.key);
    for (const tab of [...this.tabs.values()]) if (tab.entry === entry) await this.closeTab(tab);
    if (entry.tracing) await entry.context.tracing.stop().catch(() => undefined);
    await entry.context.close().catch(() => undefined);
  }

  // ── tabs ──────────────────────────────────────────────────────────────────

  private register(page: Page, operation: string, entry: ContextEntry): Tab {
    const known = this.pageTabs.get(page);
    if (known) return known;
    this.counter += 1;
    const now = this.now();
    const op = this.op(operation);
    const tab: Tab = {
      id: `t${this.counter}`,
      operation,
      page,
      entry,
      lastUsed: now,
      expiresAt: now + (op.options.leaseMs ?? this.options.leaseMs),
      sensitive: false,
      consoleLog: [],
      network: [],
      downloads: [],
      recording: null,
    };
    this.tabs.set(tab.id, tab);
    this.pageTabs.set(page, tab);
    entry.idleSince = null;
    const push = <T>(list: T[], item: T) => {
      if (tab.sensitive) return;
      list.push(item);
      if (list.length > LOG_LIMIT) list.splice(0, list.length - LOG_LIMIT);
    };
    const at = () => new Date(this.now()).toISOString();
    page.on("console", (message) => {
      const location = message.location();
      push(tab.consoleLog, { at: at(), type: message.type(), text: message.text().slice(0, 4_000), location: location.url ? `${redactRequestUrl(location.url)}:${location.lineNumber}` : undefined });
    });
    page.on("pageerror", (error) => push(tab.consoleLog, { at: at(), type: "pageerror", text: `${error.name}: ${error.message}`.slice(0, 4_000) }));
    page.on("requestfailed", (request) => {
      push(tab.network, { at: at(), method: request.method(), url: redactRequestUrl(request.url()).slice(0, 2_000), failure: request.failure()?.errorText ?? "failed", resourceType: request.resourceType() });
    });
    page.on("response", (response) => {
      if (response.status() < 400) return;
      const request = response.request();
      push(tab.network, { at: at(), method: request.method(), url: redactRequestUrl(response.url()).slice(0, 2_000), status: response.status(), resourceType: request.resourceType() });
    });
    page.on("download", (download) => {
      tab.downloads.push(download);
      if (tab.downloads.length > 10) tab.downloads.shift();
    });
    page.on("popup", (popup) => {
      if (this.tabsOf(operation).length < this.options.maxTabsPerOperation) this.register(popup, operation, entry);
      else void popup.close().catch(() => undefined);
    });
    page.on("close", () => this.forgetTab(tab));
    this.updateLive(op);
    return tab;
  }

  private forgetTab(tab: Tab): void {
    if (this.tabs.get(tab.id) !== tab) return;
    this.tabs.delete(tab.id);
    if (tab.recording?.kind === "video") void tab.recording.video.stop().catch(() => undefined);
    if (![...this.tabs.values()].some((other) => other.entry === tab.entry)) tab.entry.idleSince = this.now();
    const op = this.operations.get(tab.operation);
    if (op) this.updateLive(op);
  }

  private async closeTab(tab: Tab): Promise<void> {
    if (tab.recording?.kind === "video") await tab.recording.video.stop().catch(() => undefined);
    if (tab.entry.tracing?.tab === tab.id) {
      await tab.entry.context.tracing.stop().catch(() => undefined);
      tab.entry.tracing = null;
    }
    tab.recording = null;
    this.forgetTab(tab);
    await tab.page.close().catch(() => undefined);
  }

  async open(operation: string, url: string, input: OpenOptions = {}): Promise<TabInfo & { status: number | null; error?: string; note?: string }> {
    const target = checkUrl(url);
    this.op(operation);
    let tab: Tab;
    let note: string | undefined;
    if (input.tab) {
      tab = this.tab(operation, input.tab);
    } else {
      const profile = input.private ? null : (input.profile ?? "default");
      if (profile !== null && !isProfileName(profile)) throw new BrowserError("bad_input", `"${profile}" is not a browser profile name.`);
      if (this.tabsOf(operation).length >= this.options.maxTabsPerOperation) throw new BrowserError("busy", `This work already has ${this.options.maxTabsPerOperation} tabs open. Close some first.`);
      const found = await this.contextFor(operation, { profile, headed: Boolean(input.headed), device: input.device, viewport: input.viewport });
      note = found.note;
      const blank = found.entry.context.pages().find((page) => !this.pageTabs.has(page) && page.url() === "about:blank");
      tab = this.register(blank ?? (await found.entry.context.newPage()), operation, found.entry);
      if (input.viewport && profile !== null) await tab.page.setViewportSize(input.viewport);
    }
    let status: number | null = null;
    let error: string | undefined;
    // Capture's frame-stepped video controls the page's time from its first script.
    if (input.clock) await tab.page.clock.install();
    if (target !== "about:blank") {
      try {
        const response = await tab.page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
        status = response?.status() ?? null;
      } catch (failure) {
        error = (failure instanceof Error ? failure.message : String(failure)).split("\n")[0]!.replace(/^page\.goto: /, "");
      }
    }
    return { ...(await this.describe(tab)), status, ...(error ? { error } : {}), ...(note ? { note } : {}) };
  }

  async list(operation: string): Promise<TabInfo[]> {
    this.op(operation);
    return Promise.all(this.tabsOf(operation).map((tab) => this.describe(tab)));
  }

  async close(operation: string, id: string): Promise<{ closed: string }> {
    await this.closeTab(this.tab(operation, id, "close"));
    return { closed: id };
  }

  async snapshot(operation: string, id: string, input: { maxChars?: number } = {}): Promise<{ tab: string; url: string; title: string; snapshot: string; truncated: boolean }> {
    const tab = this.tab(operation, id, "observe");
    const rules = await this.rules();
    if (siteRule(tab.page.url(), rules) === "never") throw new BrowserError("refused", "The owner marked this site as never captured, so it cannot be read either.");
    let raw: string;
    try {
      raw = await tab.page.ariaSnapshot({ mode: "ai", timeout: 15_000 });
    } catch (error) {
      throw new BrowserError("failed", `Could not read the page: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
    const { refs, unchecked } = await sensitiveSnapshotRefs(tab.page, raw);
    for (const ref of unchecked) refs.add(ref);
    let text = redactSnapshot(raw, refs, rules);
    const limit = Math.min(Math.max(1_000, input.maxChars ?? this.options.snapshotChars), 100_000);
    let truncated = false;
    if (text.length > limit) {
      const cut = text.lastIndexOf("\n", limit);
      const rest = text.slice(cut > 0 ? cut : limit).split("\n").filter(Boolean).length;
      text = `${text.slice(0, cut > 0 ? cut : limit)}\n- note: ${rest} more lines not shown; the page is longer than this snapshot`;
      truncated = true;
    }
    return { tab: tab.id, url: tab.page.url(), title: hideSecrets(await tab.page.title().catch(() => ""), rules), snapshot: text, truncated };
  }

  private async settle(page: Page): Promise<void> {
    await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
  }

  /** A Playwright failure as the error an agent can act on. */
  private actionError(error: unknown, ref?: string): BrowserError {
    if (error instanceof BrowserError) return error;
    const message = error instanceof Error ? error.message.split("\n")[0]! : String(error);
    if (/timeout/i.test(message)) return new BrowserError("timeout", ref ? `Element ${ref} was not ready in time. Take a new snapshot; the page may have changed.` : message);
    return new BrowserError("failed", ref && /aria-ref|not found|No element/i.test(message) ? `Element ${ref} is not on the page any more. Take a new snapshot.` : message);
  }

  async click(operation: string, id: string, ref: string, input: { button?: "left" | "right" | "middle"; double?: boolean } = {}): Promise<TabInfo> {
    const tab = this.tab(operation, id);
    const locator = tab.page.locator(`aria-ref=${checkRef(ref)}`);
    try {
      if (input.double) await locator.dblclick({ button: input.button, timeout: 10_000 });
      else await locator.click({ button: input.button, timeout: 10_000 });
    } catch (error) {
      throw this.actionError(error, ref);
    }
    await this.settle(tab.page);
    return this.describe(tab);
  }

  async type(operation: string, id: string, ref: string, text: string, input: { submit?: boolean; slowly?: boolean } = {}): Promise<TabInfo> {
    const tab = this.tab(operation, id);
    if (text.length > 20_000) throw new BrowserError("bad_input", "That text is too long to type (20,000 characters at most).");
    const rules = await this.rules();
    if ((rules.secretValues ?? []).some((value) => value.length >= SECRET_MIN_LENGTH && text.includes(value))) {
      throw new BrowserError("refused", "That text contains one of the owner's saved secrets. Secrets are filled in by Ensemble, never typed by an agent.");
    }
    const locator = tab.page.locator(`aria-ref=${checkRef(ref)}`);
    try {
      if (input.slowly) {
        await locator.fill("", { timeout: 10_000 });
        await locator.pressSequentially(text, { delay: 25, timeout: 30_000 });
      } else {
        await locator.fill(text, { timeout: 10_000 });
      }
      if (input.submit) await locator.press("Enter", { timeout: 10_000 });
    } catch (error) {
      throw this.actionError(error, ref);
    }
    await this.settle(tab.page);
    return this.describe(tab);
  }

  async press(operation: string, id: string, key: string): Promise<TabInfo> {
    const tab = this.tab(operation, id);
    if (!/^[\x20-\x7e]{1,40}$/.test(key)) throw new BrowserError("bad_input", "Give one key or chord, such as Enter, Escape, ArrowDown or Control+A.");
    try {
      await tab.page.keyboard.press(key);
    } catch (error) {
      throw this.actionError(error);
    }
    await this.settle(tab.page);
    return this.describe(tab);
  }

  async wait(operation: string, id: string, condition: { selector?: string; text?: string; url?: string; timeoutMs?: number; state?: "visible" | "hidden" | "attached" | "detached" }): Promise<{ tab: string; waitedMs: number; url: string }> {
    const given = [condition.selector, condition.text, condition.url].filter((value) => value !== undefined && value !== "").length;
    if (given > 1) throw new BrowserError("bad_input", "Wait for one thing: a selector, a text or a URL.");
    const tab = this.tab(operation, id, condition.selector || condition.text ? "observe" : "wait");
    const timeout = Math.min(Math.max(0, condition.timeoutMs ?? 10_000), 120_000);
    const started = Date.now();
    try {
      if (condition.selector) {
        await tab.page.locator(elementSelector(condition.selector)).first().waitFor({ state: condition.state ?? "visible", timeout });
      } else if (condition.text) {
        await tab.page.getByText(condition.text).first().waitFor({ state: condition.state ?? "visible", timeout });
      } else if (condition.url) {
        await tab.page.waitForURL(condition.url, { timeout, waitUntil: "domcontentloaded" });
      } else {
        await new Promise((resolve) => setTimeout(resolve, timeout));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0]! : String(error);
      throw new BrowserError(/timeout/i.test(message) ? "timeout" : "failed", /timeout/i.test(message) ? `Still waiting after ${timeout} ms.` : message);
    }
    return { tab: tab.id, waitedMs: Date.now() - started, url: tab.page.url() };
  }

  /** Masked, scanned screenshot of a tab, written to the operation's evidence folder. */
  async screenshot(operation: string, id: string, input: { fullPage?: boolean; element?: string; viewport?: { width: number; height: number }; name?: string; format?: "png" | "jpeg" } = {}): Promise<MediaFile> {
    const tab = this.tab(operation, id, "observe");
    const dir = this.evidenceDir(operation);
    const { page } = tab;
    const rules = await this.rules();
    const scan = await scanPage(page, rules);
    if (scan.site === "never" || siteRule(page.url(), rules) === "never") throw new BrowserError("refused", "The owner marked this site as never captured.");
    const previous = page.viewportSize();
    const format = input.format ?? "png";
    const path = await reserveFile(dir, slugName(input.name, `screenshot-${tab.id}`), format === "png" ? "png" : "jpg");
    try {
      if (input.viewport) await page.setViewportSize(input.viewport);
      const masks = sensitiveMasks(page);
      const masked = await page.locator(SENSITIVE_SELECTOR).count().catch(() => 0);
      const options = { path, type: format, mask: masks, caret: "hide" as const, timeout: 20_000, ...(format === "jpeg" ? { quality: 90 } : {}) };
      if (input.element) await page.locator(elementSelector(input.element)).first().screenshot(options);
      else await page.screenshot({ ...options, fullPage: Boolean(input.fullPage) });
      const still = await stillFile(path);
      const reason = scan.site === "preview" ? PREVIEW_REASON : holdReason(scan.hits);
      return { ...still, kind: "image", held: Boolean(reason), ...(reason ? { reason } : {}), masked, url: page.url(), title: hideSecrets(await page.title().catch(() => ""), rules) };
    } catch (error) {
      await rm(path, { force: true });
      throw this.actionError(error, input.element);
    } finally {
      if (input.viewport && previous) await page.setViewportSize(previous).catch(() => undefined);
    }
  }

  async consoleMessages(operation: string, id: string, input: { level?: "error" | "warning" | "all"; clear?: boolean } = {}): Promise<{ tab: string; messages: ConsoleEntry[] }> {
    const tab = this.tab(operation, id, "observe");
    const level = input.level ?? "all";
    const errors = new Set(["error", "pageerror"]);
    const messages = tab.consoleLog.filter((entry) => level === "all" || errors.has(entry.type) || (level === "warning" && entry.type === "warning"));
    if (input.clear) tab.consoleLog.length = 0;
    const rules = await this.rules();
    return { tab: tab.id, messages: messages.map((entry) => ({ ...entry, text: hideSecrets(entry.text, rules) })) };
  }

  networkErrors(operation: string, id: string, input: { clear?: boolean } = {}): { tab: string; errors: NetworkEntry[] } {
    const tab = this.tab(operation, id, "observe");
    const errors = [...tab.network];
    if (input.clear) tab.network.length = 0;
    return { tab: tab.id, errors };
  }

  /** Sends a file to a file field. Only regular files inside the evidence folder or an allowed folder. */
  async upload(operation: string, id: string, ref: string, file: string): Promise<{ tab: string; file: string; size: number }> {
    const tab = this.tab(operation, id);
    const op = this.op(operation);
    if (!isAbsolute(file)) throw new BrowserError("bad_input", "Give the file's full path.");
    if (CREDENTIAL_NAME.test(basename(file))) throw new BrowserError("refused", "Files of keys, credentials and environment settings are never uploaded.");
    const roots = await Promise.all([op.options.evidenceDir, ...(op.options.uploadRoots ?? [])].filter((root): root is string => Boolean(root)).map((root) => realpath(root).catch(() => null)));
    const real = await realpath(file).catch(() => null);
    if (!real || !roots.some((root) => root && within(root, real))) throw new BrowserError("refused", "Upload files from this work's evidence folder or a file the owner attached.");
    let buffer: Buffer;
    const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
    try {
      const handle = await openFile(file, fsConstants.O_RDONLY | noFollow);
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new BrowserError("refused", "Only regular files can be uploaded.");
        if (info.nlink > 1) throw new BrowserError("refused", "A file with several names (a hard link) is not uploaded.");
        if (info.size > MAX_UPLOAD) throw new BrowserError("refused", "That file is larger than 50 MB.");
        // The file opened must be the one checked above, not one swapped in since.
        const checked = await stat(real);
        if (checked.ino !== info.ino || checked.dev !== info.dev) throw new BrowserError("refused", "The file changed while it was being checked.");
        buffer = await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof BrowserError) throw error;
      throw new BrowserError("refused", (error as NodeJS.ErrnoException).code === "ELOOP" ? "Links are not followed for uploads." : `Could not read that file: ${(error as Error).message}`);
    }
    const rules = await this.rules();
    if ((rules.secretValues ?? []).some((value) => value.length >= SECRET_MIN_LENGTH && buffer.includes(value))) throw new BrowserError("refused", "That file contains one of the owner's saved secrets.");
    const payload = { name: basename(file), mimeType: mimeFor(file), buffer };
    const locator = tab.page.locator(`aria-ref=${checkRef(ref)}`);
    try {
      const isFileInput = await locator.evaluate((element) => {
        const field = element as unknown as { tagName?: string; type?: string };
        return field.tagName === "INPUT" && (field.type ?? "").toLowerCase() === "file";
      }, undefined, { timeout: 10_000 });
      if (isFileInput) await locator.setInputFiles(payload, { timeout: 10_000 });
      else {
        const [chooser] = await Promise.all([tab.page.waitForEvent("filechooser", { timeout: 10_000 }), locator.click({ timeout: 10_000 })]);
        await chooser.setFiles(payload, { timeout: 10_000 });
      }
    } catch (error) {
      throw this.actionError(error, ref);
    }
    return { tab: tab.id, file: payload.name, size: buffer.length };
  }

  /** Saves a download into the evidence folder: the one a click on `ref` starts, else the latest or the next. */
  async download(operation: string, id: string, input: { ref?: string; timeoutMs?: number } = {}): Promise<{ tab: string; path: string; name: string; size: number; mime: string; url: string }> {
    const tab = this.tab(operation, id);
    const dir = this.evidenceDir(operation);
    const timeout = Math.min(Math.max(1_000, input.timeoutMs ?? 30_000), 300_000);
    let download: Download;
    try {
      if (input.ref) {
        const locator = tab.page.locator(`aria-ref=${checkRef(input.ref)}`);
        [download] = await Promise.all([tab.page.waitForEvent("download", { timeout }), locator.click({ timeout: 10_000 })]);
        tab.downloads = tab.downloads.filter((item) => item !== download);
      } else {
        download = tab.downloads.pop() ?? (await tab.page.waitForEvent("download", { timeout }));
        tab.downloads = tab.downloads.filter((item) => item !== download);
      }
    } catch (error) {
      throw this.actionError(error, input.ref);
    }
    const suggested = basename(download.suggestedFilename().replace(/[\\/]/g, "_")).replace(/[\x00-\x1f]/g, "") || "download";
    const extension = extname(suggested).slice(1).replace(/[^\w]/g, "").slice(0, 10) || "bin";
    const path = await reserveFile(dir, slugName(basename(suggested, extname(suggested)), "download"), extension);
    try {
      const failure = await download.failure();
      if (failure) throw new BrowserError("failed", `The download failed: ${failure}`);
      await download.saveAs(path);
      const size = (await stat(path)).size;
      if (size > MAX_DOWNLOAD) throw new BrowserError("refused", "The download is larger than 100 MB, so it was not kept.");
      return { tab: tab.id, path, name: suggested, size, mime: mimeFor(suggested), url: redactRequestUrl(download.url()) };
    } catch (error) {
      await rm(path, { force: true });
      if (error instanceof BrowserError) throw error;
      throw new BrowserError("failed", error instanceof Error ? error.message.split("\n")[0]! : String(error));
    }
  }

  /** Starts or stops a video (screencast) or a Playwright trace of a tab. */
  async record(operation: string, id: string, input: { kind: "video" | "trace"; action: "start" | "stop"; fps?: number; name?: string }): Promise<{ tab: string; recording: "video" | "trace" | null; file?: MediaFile }> {
    const tab = this.tab(operation, id, input.action === "start" ? "observe" : "close");
    const op = this.op(operation);
    if (input.action === "start") {
      if (tab.recording || tab.entry.tracing?.tab === tab.id) throw new BrowserError("busy", `Tab ${tab.id} is already recording.`);
      const rules = await this.rules();
      const scan = await scanPage(tab.page, rules);
      if (scan.site === "never") throw new BrowserError("refused", "The owner marked this site as never captured.");
      const dir = this.evidenceDir(operation);
      if (input.kind === "video") {
        const choice = chooseVideoEncoder(await findFfmpegs());
        if (!choice) throw new BrowserError("unavailable", "No video encoder on this computer. Run `ensemble capture setup`.");
        const viewport = tab.page.viewportSize() ?? DEFAULT_VIEWPORT;
        const size = { width: Math.min(viewport.width, 1920), height: Math.min(viewport.height, 1920) };
        const fps = Math.min(30, Math.max(5, Math.round(input.fps ?? 25)));
        const maxDurationMs = op.options.maxVideoMs ?? DEFAULT_MAX_DURATION_MS;
        const output = await reserveFile(dir, slugName(input.name, `video-${tab.id}`), choice.extension);
        const encoder = new VideoEncoder({ choice, output, fps, width: size.width, height: size.height, maxDurationMs, poster: { frame: "last" } });
        // Screencast frames cannot be masked, so anything sensitive seen while recording holds the video.
        const watch = { held: holdReason(scan.hits) ?? (scan.site === "preview" ? PREVIEW_REASON : scan.exposedFields ? EXPOSED_REASON : null) };
        const check = async () => {
          if (tab.page.isClosed() || tab.sensitive || watch.held) return;
          const now = await scanPage(tab.page, await this.rules()).catch(() => null);
          if (!now) return;
          if (now.site) watch.held = now.site === "never" ? "The recording reached a site the owner never wants captured." : PREVIEW_REASON;
          else if (hasSecrets(now.hits)) watch.held = holdReason(now.hits);
          else if (now.exposedFields) watch.held = EXPOSED_REASON;
        };
        let video: RealtimeRecording;
        try {
          video = await RealtimeRecording.start(tab.page, encoder, { fps, maxDurationMs, size, paused: () => tab.sensitive, check });
        } catch (error) {
          await encoder.abort();
          throw new BrowserError("failed", `Could not start recording: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        }
        tab.recording = { kind: "video", video, watch };
        return { tab: tab.id, recording: "video" };
      }
      const others = [...this.tabs.values()].some((other) => other.entry === tab.entry && other.operation !== operation);
      if (others || tab.entry.tracing) throw new BrowserError("busy", "A trace covers the whole browser profile, and other work is using it. Use a private tab (private: true) or record a video.");
      // Without DOM snapshots a trace of the shared profile holds no page source or network data.
      await tab.entry.context.tracing.start({ screenshots: true, snapshots: tab.entry.profile === null, sources: false, title: `Tab ${tab.id}` });
      tab.entry.tracing = { operation, tab: tab.id, held: holdReason(scan.hits) };
      tab.recording = { kind: "trace" };
      return { tab: tab.id, recording: "trace" };
    }
    if (input.kind === "video") {
      if (tab.recording?.kind !== "video") throw new BrowserError("not_found", `Tab ${tab.id} is not recording a video.`);
      const recording = tab.recording;
      tab.recording = null;
      let file: MediaFile;
      try {
        file = await recording.video.stop();
      } catch (error) {
        throw new BrowserError("failed", error instanceof CaptureError ? error.message : `The video could not be finished: ${String(error)}`);
      }
      if (recording.watch.held) Object.assign(file, { held: true, reason: recording.watch.held });
      return { tab: tab.id, recording: null, file: { ...file, url: tab.page.isClosed() ? undefined : tab.page.url() } };
    }
    if (tab.entry.tracing?.tab !== tab.id) throw new BrowserError("not_found", `Tab ${tab.id} is not recording a trace.`);
    const dir = this.evidenceDir(operation);
    const path = await reserveFile(dir, slugName(input.name, `trace-${tab.id}`), "zip");
    const tracing = tab.entry.tracing;
    tab.entry.tracing = null;
    tab.recording = null;
    await tab.entry.context.tracing.stop({ path });
    const rules = await this.rules();
    const scan = tab.page.isClosed() ? null : await scanPage(tab.page, rules).catch(() => null);
    const held = tracing.held ?? (scan ? holdReason(scan.hits) : null);
    const size = (await stat(path)).size;
    return { tab: tab.id, recording: null, file: { path, kind: "trace", mime: "application/zip", size, held: Boolean(held), ...(held ? { reason: held } : {}) } };
  }

  // ── sensitive state and live view ────────────────────────────────────────

  /**
   * Marks a tab as in a sign-in or takeover step, or back. While on, the tab refuses snapshots,
   * screenshots, recording and actions, its live view pauses, a video drops its frames and a trace
   * is stopped and deleted. For the broker's own login flow and the owner, not for agents.
   */
  async markSensitive(id: string, on: boolean): Promise<TabInfo> {
    const tab = this.tabs.get(id);
    if (!tab) throw new BrowserError("not_found", `There is no tab ${id}.`);
    tab.sensitive = on;
    if (on && tab.entry.tracing?.tab === id) {
      tab.entry.tracing = null;
      tab.recording = null;
      await tab.entry.context.tracing.stop().catch(() => undefined);
      this.log(`trace of ${id} discarded for a sensitive step`);
    }
    const op = this.operations.get(tab.operation);
    if (op) this.updateLive(op);
    return this.info(tab);
  }

  private updateLive(op: Operation): void {
    const wanted = Boolean(op.options.onLiveFrame) && this.tabsOf(op.id).length > 0 && !this.closed;
    if (wanted && !op.live) {
      const live = { timer: setInterval(() => void this.liveTick(op), this.options.liveViewMs), busy: false, paused: null, quality: 50 };
      live.timer.unref();
      op.live = live;
      setTimeout(() => void this.liveTick(op), 50).unref();
    } else if (!wanted && op.live) this.stopLive(op);
  }

  private stopLive(op: Operation): void {
    if (op.live) clearInterval(op.live.timer);
    op.live = null;
  }

  private async liveTick(op: Operation): Promise<void> {
    const live = op.live;
    const send = op.options.onLiveFrame;
    if (!live || !send || live.busy) return;
    const tab = this.tabsOf(op.id).sort((a, b) => b.lastUsed - a.lastUsed)[0];
    if (!tab || tab.page.isClosed()) return;
    live.busy = true;
    try {
      const base = { operation: op.id, tab: tab.id, url: tab.sensitive ? "" : tab.page.url(), title: "", at: new Date(this.now()).toISOString() };
      const pause = (reason: NonNullable<LiveFrame["paused"]>) => {
        if (live.paused !== reason) send({ ...base, paused: reason });
        live.paused = reason;
      };
      if (tab.sensitive) return pause("sensitive");
      const scan = await scanPage(tab.page, await this.rules());
      if (tab.sensitive) return pause("sensitive");
      if (scan.site === "never") return pause("private_site");
      if (hasSecrets(scan.hits)) return pause("secret_on_screen");
      const jpeg = await tab.page.screenshot({ type: "jpeg", quality: live.quality, scale: "css", mask: sensitiveMasks(tab.page), caret: "hide", timeout: 5_000 });
      if (tab.sensitive || op.live !== live) return;
      // Keep frames small: about 60 KB.
      live.quality = jpeg.length > 80_000 ? Math.max(20, live.quality - 10) : jpeg.length < 30_000 ? Math.min(60, live.quality + 5) : live.quality;
      const size = tab.page.viewportSize();
      live.paused = null;
      send({ ...base, title: await tab.page.title().catch(() => ""), jpeg, width: size?.width, height: size?.height });
    } catch (error) {
      this.log(`live view of ${tab.id}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    } finally {
      live.busy = false;
    }
  }

  // ── leases and the janitor ──────────────────────────────────────────────

  /** Extends every tab of the operation (and the operation itself) by its lease. */
  renew(operation: string): void {
    const op = this.op(operation);
    for (const tab of this.tabsOf(operation)) tab.expiresAt = this.now() + (op.options.leaseMs ?? this.options.leaseMs);
  }

  /** Ends an operation: its recordings are finished, its tabs and private browser closed. */
  async release(operation: string): Promise<{ closed: number }> {
    const op = this.operations.get(operation);
    const tabs = this.tabsOf(operation);
    for (const tab of tabs) await this.closeTab(tab);
    const own = this.contexts.get(`private:${operation}`);
    if (own) await this.closeContext(own);
    if (op) this.stopLive(op);
    this.operations.delete(operation);
    return { closed: tabs.length };
  }

  /** The janitor's pass: closes expired tabs, then browsers idle past their time. */
  async sweep(): Promise<{ closedTabs: string[]; closedContexts: string[] }> {
    const now = this.now();
    const closedTabs: string[] = [];
    const closedContexts: string[] = [];
    for (const tab of [...this.tabs.values()]) {
      if (tab.expiresAt <= now) {
        closedTabs.push(tab.id);
        this.log(`lease of ${tab.id} ended; closing it`);
        await this.closeTab(tab);
      }
    }
    for (const entry of [...this.contexts.values()]) {
      const used = [...this.tabs.values()].some((tab) => tab.entry === entry);
      if (used) continue;
      entry.idleSince ??= now;
      // A private context is its operation's alone: it goes soon after its last tab.
      if (now - entry.idleSince >= (entry.profile === null ? Math.min(PRIVATE_IDLE_MS, this.options.idleBrowserMs) : this.options.idleBrowserMs)) {
        closedContexts.push(entry.key);
        await this.closeContext(entry);
      }
    }
    if (this.privateBrowser && ![...this.contexts.values()].some((entry) => entry.profile === null)) {
      const browser = this.privateBrowser;
      this.privateBrowser = null;
      await (await browser.catch(() => null))?.close().catch(() => undefined);
    }
    for (const op of [...this.operations.values()]) {
      if (!this.tabsOf(op.id).length && now - op.lastUsed >= this.options.leaseMs) {
        this.stopLive(op);
        this.operations.delete(op.id);
      }
    }
    if (!this.contexts.size && !this.tabs.size && this.janitor && !this.operations.size) {
      clearInterval(this.janitor);
      this.janitor = null;
    }
    return { closedTabs, closedContexts };
  }

  status(): { contexts: Array<{ key: string; profile: string | null; headless: boolean; tabs: number }>; tabs: number; operations: number } {
    return {
      contexts: [...this.contexts.values()].map((entry) => ({ key: entry.key, profile: entry.profile, headless: entry.headless, tabs: [...this.tabs.values()].filter((tab) => tab.entry === entry).length })),
      tabs: this.tabs.size,
      operations: this.operations.size,
    };
  }

  /** The page behind a tab, for capture's own use (frame-stepped video, checks). Never for agents. */
  pageFor(operation: string, id: string): Page {
    return this.tab(operation, id, "observe").page;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.janitor) clearInterval(this.janitor);
    this.janitor = null;
    for (const op of this.operations.values()) this.stopLive(op);
    for (const entry of [...this.contexts.values()]) await this.closeContext(entry);
    const browser = this.privateBrowser;
    this.privateBrowser = null;
    if (browser) await (await browser.catch(() => null))?.close().catch(() => undefined);
    this.operations.clear();
  }
}

/** The broker's tool set for one operation: what both callers expose to an agent. */
export class BrowserOperation {
  constructor(
    private readonly owner: BrowserBroker,
    readonly id: string,
    private readonly options: OperationOptions = {},
  ) {}

  /** The broker, with this operation known to it again if the janitor forgot it while idle. */
  private get broker(): BrowserBroker {
    this.owner.keep(this.id, this.options);
    return this.owner;
  }

  open(url: string, options?: OpenOptions) {
    return this.broker.open(this.id, url, options);
  }
  tabs() {
    return this.broker.list(this.id);
  }
  close(tab: string) {
    return this.broker.close(this.id, tab);
  }
  snapshot(tab: string, options?: { maxChars?: number }) {
    return this.broker.snapshot(this.id, tab, options);
  }
  click(tab: string, ref: string, options?: { button?: "left" | "right" | "middle"; double?: boolean }) {
    return this.broker.click(this.id, tab, ref, options);
  }
  type(tab: string, ref: string, text: string, options?: { submit?: boolean; slowly?: boolean }) {
    return this.broker.type(this.id, tab, ref, text, options);
  }
  press(tab: string, key: string) {
    return this.broker.press(this.id, tab, key);
  }
  wait(tab: string, condition: { selector?: string; text?: string; url?: string; timeoutMs?: number; state?: "visible" | "hidden" | "attached" | "detached" }) {
    return this.broker.wait(this.id, tab, condition);
  }
  screenshot(tab: string, options?: { fullPage?: boolean; element?: string; viewport?: { width: number; height: number }; name?: string; format?: "png" | "jpeg" }) {
    return this.broker.screenshot(this.id, tab, options);
  }
  console(tab: string, options?: { level?: "error" | "warning" | "all"; clear?: boolean }) {
    return this.broker.consoleMessages(this.id, tab, options);
  }
  networkErrors(tab: string, options?: { clear?: boolean }) {
    return this.broker.networkErrors(this.id, tab, options);
  }
  upload(tab: string, ref: string, file: string) {
    return this.broker.upload(this.id, tab, ref, file);
  }
  download(tab: string, options?: { ref?: string; timeoutMs?: number }) {
    return this.broker.download(this.id, tab, options);
  }
  record(tab: string, options: { kind: "video" | "trace"; action: "start" | "stop"; fps?: number; name?: string }) {
    return this.broker.record(this.id, tab, options);
  }
  renew() {
    this.broker.renew(this.id);
  }
  release() {
    return this.owner.release(this.id);
  }
}
