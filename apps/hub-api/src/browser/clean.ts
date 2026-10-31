/**
 * A clean browser: Chromium driven over the DevTools pipe with the fewest commands, and no page
 * scripting. Playwright makes every page it drives detectable (it enables the Runtime domain, adds
 * bindings and init scripts), so Google refuses to sign in there ("This browser or app may not be
 * secure"), Cloudflare's check never clears and some shops answer with HTTP/2 errors. A clean browser
 * only navigates, streams the screen (`Page.startScreencast`), sends real input (`Input.*`), and reads
 * cookies and the DOM through the browser's own protocol; nothing runs in the page. It is for the
 * moments a person must act on a site (signing in, passing a human check) and for read-only captures
 * of sites that block automation. The pipe (`--remote-debugging-pipe`, as Playwright uses) opens no
 * port another program could reach.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";

export type CleanLaunch = {
  executablePath: string;
  userDataDir: string;
  headless: boolean;
  /** The user agent to send (a headless Chrome otherwise says "HeadlessChrome"). */
  userAgent?: string;
  /** `en-US`: the browser's language. */
  locale?: string;
  /** IANA time zone, through `TZ`. */
  timezone?: string;
  width?: number;
  height?: number;
  /** An X display for a window on Linux (`:0`). */
  display?: string;
  extraArgs?: string[];
  platform?: NodeJS.Platform;
};

/** Chromium's switches for a clean browser: no automation switches, no first-run screens, no keychain prompts. */
export function cleanArgs(input: CleanLaunch): string[] {
  const platform = input.platform ?? process.platform;
  const width = input.width ?? 1280;
  const height = input.height ?? 860;
  return [
    "--remote-debugging-pipe",
    `--user-data-dir=${input.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--password-store=basic",
    "--use-mock-keychain",
    `--window-size=${width},${height}`,
    // As Playwright does on Linux: Ubuntu's AppArmor refuses Chromium's own sandbox to unprivileged users.
    ...(platform === "linux" ? ["--no-sandbox"] : []),
    ...(input.headless ? ["--headless=new", "--hide-scrollbars", "--mute-audio"] : []),
    ...(input.userAgent ? [`--user-agent=${input.userAgent}`] : []),
    ...(input.locale ? [`--lang=${input.locale}`] : []),
    ...(input.extraArgs ?? []),
    "about:blank",
  ];
}

export class CleanBrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleanBrowserError";
  }
}

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; method: string };
type Message = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string }; sessionId?: string };

/** One DevTools connection over the pipe: commands by id, events by name and session. */
class Connection extends EventEmitter {
  private next = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  closed = false;

  constructor(
    private readonly out: Writable,
    input: Readable,
  ) {
    super();
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => this.read(chunk));
    input.on("close", () => this.shut("The browser closed."));
    out.on("error", () => this.shut("The browser closed."));
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let end = this.buffer.indexOf("\0");
    while (end >= 0) {
      const text = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      end = this.buffer.indexOf("\0");
      let message: Message;
      try {
        message = JSON.parse(text) as Message;
      } catch {
        continue;
      }
      if (message.id !== undefined) {
        const waiting = this.pending.get(message.id);
        if (!waiting) continue;
        this.pending.delete(message.id);
        if (message.error) waiting.reject(new CleanBrowserError(`${waiting.method}: ${message.error.message ?? "failed"}`));
        else waiting.resolve(message.result ?? {});
      } else if (message.method) {
        this.emit(message.method, message.params ?? {}, message.sessionId ?? null);
        this.emit("*", message.method, message.params ?? {}, message.sessionId ?? null);
      }
    }
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string | null, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new CleanBrowserError("The browser closed."));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new CleanBrowserError(`${method}: no answer in ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.out.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  shut(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiting of this.pending.values()) waiting.reject(new CleanBrowserError(reason));
    this.pending.clear();
    this.emit("closed");
  }
}

export type CleanCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Seconds since the epoch; -1 for a session cookie. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
};

export type ScreencastFrame = { data: string; width: number; height: number };

/** A tab of a clean browser. Input coordinates are CSS pixels of its viewport. */
export class CleanPage extends EventEmitter {
  url = "about:blank";
  title = "";
  closed = false;
  private casting: ((frame: ScreencastFrame) => void) | null = null;

  constructor(
    private readonly conn: Connection,
    readonly targetId: string,
    readonly sessionId: string,
    /** The tab that opened this one (a sign-in popup), if any. */
    readonly openerId: string | null,
  ) {
    super();
    conn.on("Page.frameNavigated", (params: { frame?: { parentId?: string; url?: string } }, session: string | null) => {
      if (session !== this.sessionId || params.frame?.parentId) return;
      this.url = params.frame?.url ?? this.url;
      this.emit("navigated", this.url);
    });
    conn.on("Page.navigatedWithinDocument", (params: { url?: string }, session: string | null) => {
      if (session !== this.sessionId || !params.url) return;
      this.url = params.url;
      this.emit("navigated", this.url);
    });
    conn.on("Page.loadEventFired", (_params: unknown, session: string | null) => {
      if (session === this.sessionId) this.emit("load");
    });
    conn.on("Page.screencastFrame", (params: { data: string; sessionId: number; metadata?: { deviceWidth?: number; deviceHeight?: number } }, session: string | null) => {
      if (session !== this.sessionId) return;
      void conn.send("Page.screencastFrameAck", { sessionId: params.sessionId }, this.sessionId).catch(() => undefined);
      this.casting?.({ data: params.data, width: params.metadata?.deviceWidth ?? 0, height: params.metadata?.deviceHeight ?? 0 });
    });
  }

  private send(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.conn.send(method, params, this.sessionId, timeoutMs);
  }

  /** Page and Network events, no Runtime: navigation, load and lifecycle are all a clean tab needs. */
  async init(): Promise<void> {
    await this.send("Page.enable");
    await this.send("Page.setLifecycleEventsEnabled", { enabled: true }).catch(() => undefined);
  }

  async goto(url: string, options: { timeoutMs?: number } = {}): Promise<void> {
    const loaded = this.waitFor("load", options.timeoutMs ?? 30_000).catch(() => undefined);
    const answer = await this.send("Page.navigate", { url }, options.timeoutMs ?? 30_000);
    if (typeof answer.errorText === "string" && answer.errorText) throw new CleanBrowserError(`Could not open ${url}: ${answer.errorText}`);
    await loaded;
    await this.refresh();
  }

  /** The tab's current address and title, from its history (no page script). */
  async refresh(): Promise<{ url: string; title: string }> {
    const history = (await this.send("Page.getNavigationHistory").catch(() => ({}))) as { currentIndex?: number; entries?: Array<{ url?: string; title?: string }> };
    const entry = history.entries?.[history.currentIndex ?? (history.entries?.length ?? 1) - 1];
    if (entry?.url) this.url = entry.url;
    if (typeof entry?.title === "string") this.title = entry.title;
    return { url: this.url, title: this.title };
  }

  waitFor(event: "load" | "navigated", timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(event, done);
        reject(new CleanBrowserError(`Still waiting for the page after ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      timer.unref?.();
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once(event, done);
    });
  }

  async screenshot(options: { format?: "png" | "jpeg"; quality?: number; fullPage?: boolean } = {}): Promise<Buffer> {
    const answer = await this.send("Page.captureScreenshot", { format: options.format ?? "png", ...(options.format === "jpeg" ? { quality: options.quality ?? 80 } : {}), ...(options.fullPage ? { captureBeyondViewport: true } : {}) }, 45_000);
    return Buffer.from(String(answer.data ?? ""), "base64");
  }

  /** The page's HTML, read through the DOM domain (no page script). */
  async html(): Promise<string> {
    const doc = (await this.send("DOM.getDocument", { depth: 0 })) as { root?: { nodeId?: number } };
    if (!doc.root?.nodeId) return "";
    const outer = await this.send("DOM.getOuterHTML", { nodeId: doc.root.nodeId });
    return String(outer.outerHTML ?? "");
  }

  async startScreencast(onFrame: (frame: ScreencastFrame) => void, options: { quality?: number; maxWidth?: number; maxHeight?: number } = {}): Promise<void> {
    this.casting = onFrame;
    await this.send("Page.startScreencast", { format: "jpeg", quality: options.quality ?? 60, maxWidth: options.maxWidth ?? 1280, maxHeight: options.maxHeight ?? 1280, everyNthFrame: 1 });
  }

  async stopScreencast(): Promise<void> {
    this.casting = null;
    await this.send("Page.stopScreencast").catch(() => undefined);
  }

  async mouse(type: "mouseMoved" | "mousePressed" | "mouseReleased", x: number, y: number, options: { button?: "left" | "right" | "middle" | "none"; clickCount?: number } = {}): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type, x, y, button: options.button ?? (type === "mouseMoved" ? "none" : "left"), clickCount: options.clickCount ?? (type === "mouseMoved" ? 0 : 1) });
  }

  async wheel(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
  }

  async key(type: "keyDown" | "keyUp" | "rawKeyDown" | "char", key: { key: string; code?: string; keyCode?: number; text?: string; modifiers?: number }): Promise<void> {
    await this.send("Input.dispatchKeyEvent", { type, key: key.key, ...(key.code ? { code: key.code } : {}), ...(key.keyCode ? { windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode } : {}), ...(key.text !== undefined ? { text: key.text, unmodifiedText: key.text } : {}), ...(key.modifiers ? { modifiers: key.modifiers } : {}) });
  }

  async insertText(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  async bringToFront(): Promise<void> {
    await this.send("Page.bringToFront").catch(() => undefined);
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.conn.send("Target.closeTarget", { targetId: this.targetId }).catch(() => undefined);
  }
}

/** A clean Chromium process and its tabs. */
export class CleanBrowser extends EventEmitter {
  private readonly pagesById = new Map<string, CleanPage>();
  closed = false;

  private constructor(
    private readonly child: ChildProcess,
    private readonly conn: Connection,
  ) {
    super();
    conn.on("Target.targetCreated", (params: { targetInfo?: { targetId?: string; type?: string; openerId?: string } }) => {
      const info = params.targetInfo;
      if (info?.type !== "page" || !info.targetId || this.pagesById.has(info.targetId)) return;
      void this.attach(info.targetId, info.openerId ?? null)
        .then((page) => this.emit("page", page))
        .catch(() => undefined);
    });
    conn.on("Target.targetDestroyed", (params: { targetId?: string }) => this.dropPage(params.targetId));
    conn.on("Target.detachedFromTarget", (params: { targetId?: string }) => this.dropPage(params.targetId));
    conn.on("Target.targetInfoChanged", (params: { targetInfo?: { targetId?: string; url?: string; title?: string } }) => {
      const page = params.targetInfo?.targetId ? this.pagesById.get(params.targetInfo.targetId) : undefined;
      if (!page) return;
      if (params.targetInfo?.url) page.url = params.targetInfo.url;
      if (typeof params.targetInfo?.title === "string") page.title = params.targetInfo.title;
    });
    conn.on("closed", () => this.markClosed());
    child.once("exit", () => {
      conn.shut("The browser closed.");
      this.markClosed();
    });
  }

  private dropPage(targetId: string | undefined): void {
    const page = targetId ? this.pagesById.get(targetId) : undefined;
    if (!page) return;
    this.pagesById.delete(page.targetId);
    page.closed = true;
    page.emit("closed");
    this.emit("pageClosed", page);
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const page of this.pagesById.values()) {
      page.closed = true;
      page.emit("closed");
    }
    this.pagesById.clear();
    this.emit("closed");
  }

  static async launch(input: CleanLaunch, options: { spawnFn?: typeof spawn; timeoutMs?: number } = {}): Promise<CleanBrowser> {
    await mkdir(input.userDataDir, { recursive: true, mode: 0o700 });
    const env = { ...process.env, ...(input.timezone ? { TZ: input.timezone } : {}), ...(input.display ? { DISPLAY: input.display } : {}) };
    const child = (options.spawnFn ?? spawn)(input.executablePath, cleanArgs(input), { env, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], detached: false, windowsHide: true });
    const out = child.stdio[3] as Writable | null;
    const read = child.stdio[4] as Readable | null;
    if (!out || !read) {
      child.kill("SIGKILL");
      throw new CleanBrowserError("The browser did not open its DevTools pipe.");
    }
    const browser = new CleanBrowser(child, new Connection(out, read));
    const failed = new Promise<never>((_, reject) => {
      child.once("error", (error) => reject(new CleanBrowserError(`The browser did not start: ${error.message}`)));
      child.once("exit", (code) => reject(new CleanBrowserError(`The browser stopped as it started (exit ${code ?? "unknown"}).`)));
    });
    failed.catch(() => undefined);
    try {
      await Promise.race([browser.conn.send("Target.setDiscoverTargets", { discover: true }, null, options.timeoutMs ?? 30_000), failed]);
      // The first tab (about:blank) exists already; discovery reports it.
      const targets = (await browser.conn.send("Target.getTargets")) as { targetInfos?: Array<{ targetId: string; type: string; openerId?: string }> };
      for (const info of targets.targetInfos ?? []) if (info.type === "page" && !browser.pagesById.has(info.targetId)) await browser.attach(info.targetId, info.openerId ?? null);
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
    return browser;
  }

  private async attach(targetId: string, openerId: string | null): Promise<CleanPage> {
    const known = this.pagesById.get(targetId);
    if (known) return known;
    const attached = (await this.conn.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId?: string };
    if (!attached.sessionId) throw new CleanBrowserError("Could not attach to the tab.");
    const again = this.pagesById.get(targetId);
    if (again) return again;
    const page = new CleanPage(this.conn, targetId, attached.sessionId, openerId);
    this.pagesById.set(targetId, page);
    await page.init().catch(() => undefined);
    return page;
  }

  pages(): CleanPage[] {
    return [...this.pagesById.values()].filter((page) => !page.closed);
  }

  /** A new tab at `url` (about:blank by default). */
  async newPage(url = "about:blank"): Promise<CleanPage> {
    const created = (await this.conn.send("Target.createTarget", { url: "about:blank" })) as { targetId?: string };
    if (!created.targetId) throw new CleanBrowserError("Could not open a tab.");
    const page = await this.attach(created.targetId, null);
    if (url !== "about:blank") await page.goto(url);
    return page;
  }

  /** Every cookie the browser holds, session cookies too (`Storage.getCookies`, no page involved). */
  async cookies(): Promise<CleanCookie[]> {
    const answer = (await this.conn.send("Storage.getCookies")) as { cookies?: Array<Record<string, unknown>> };
    return (answer.cookies ?? []).map(fromCdpCookie).filter((cookie): cookie is CleanCookie => cookie !== null);
  }

  async setCookies(cookies: readonly CleanCookie[]): Promise<void> {
    if (!cookies.length) return;
    await this.conn.send("Storage.setCookies", { cookies: cookies.map((cookie) => ({ ...cookie, ...(cookie.expires < 0 ? { expires: undefined } : {}) })) });
  }

  async close(): Promise<void> {
    if (!this.closed) await this.conn.send("Browser.close", {}, null, 5_000).catch(() => undefined);
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 5_000);
      timer.unref?.();
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.markClosed();
  }
}

/** A cookie as the DevTools protocol reports it, in the shape both Playwright and `Storage.setCookies` take. */
export function fromCdpCookie(raw: Record<string, unknown>): CleanCookie | null {
  if (typeof raw.name !== "string" || typeof raw.value !== "string" || typeof raw.domain !== "string") return null;
  const sameSite = raw.sameSite === "Strict" || raw.sameSite === "Lax" || raw.sameSite === "None" ? raw.sameSite : undefined;
  const session = raw.session === true || typeof raw.expires !== "number" || raw.expires <= 0;
  return {
    name: raw.name,
    value: raw.value,
    domain: raw.domain,
    path: typeof raw.path === "string" ? raw.path : "/",
    expires: session ? -1 : Math.floor(raw.expires as number),
    httpOnly: raw.httpOnly === true,
    secure: raw.secure === true,
    ...(sameSite ? { sameSite } : {}),
  };
}

/** Whether a cookie belongs to a site (its registrable host or a subdomain of it), for moving a sign-in's cookies. */
export function cookieForHost(cookie: Pick<CleanCookie, "domain">, host: string): boolean {
  const domain = cookie.domain.replace(/^\./, "").toLowerCase();
  const target = host.toLowerCase();
  return target === domain || target.endsWith(`.${domain}`) || domain.endsWith(`.${target}`);
}
