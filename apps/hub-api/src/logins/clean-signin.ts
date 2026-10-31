/**
 * Signing in, or passing a human check, in a clean browser (docs/35 §8.16.1–2; browser/clean.ts). The
 * owner does it in a Chromium that Ensemble drives only with real input and the screen, never a page
 * script, so Google lets them sign in and Cloudflare's checkbox works: from the web (frames streamed
 * through a takeover's encrypted channel, takeover/session.ts) or in a window on this computer's
 * screen. It opens at the node tab's page, in its profile's own sign-in folder
 * (`<profiles>/<profile>-signin`, kept, so Google stays signed in there for the next "Sign in with
 * Google"; a private tab gets a folder for the session only), follows the popups a page opens (the
 * newest is the one shown; when it closes, its opener again), and watches for the sign-in to finish
 * (logins/watch.ts). logins/requests.ts then moves its cookies for the sites it went to (the site and
 * the identity providers) into the node's browser. A browser without a window is kept ten minutes
 * for the next sign-in; a window closes as soon as its sign-in is over.
 */
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { CleanBrowser, cookieForHost, type CleanCookie, type CleanPage, type ScreencastFrame } from "../browser/clean.js";
import { browserRoot } from "../browser/paths.js";
import { CleanKeyboard } from "../takeover/keys.js";
import { cookieOfSite, isSignInFlow, safeOrigin, siteOf } from "./detect.js";
import { cleanProbe, judge, onSite, Watch, type Judged, type LoginPurpose, type SignedInCondition } from "./watch.js";

/** A clean browser without a window waits this long for the next sign-in, then closes. */
export const CLEAN_KEEP_MS = 10 * 60_000;
const CHECK_EVERY_MS = 2_000;
const AFTER_LOAD_MS = 500;

/** How the broker says to start a clean browser for a profile (`BrowserBroker.cleanSignIn`). */
export type CleanSpec = { executablePath: string; userDataDir: string | null; userAgent?: string; locale: string; timezone?: string; args: string[]; env: NodeJS.ProcessEnv; platform: NodeJS.Platform };

/** The owner's input on the page shown, as a takeover carries it: points are fractions of the page. */
export type OwnerInput =
  | { t: "mouse"; type: "move" | "down" | "up"; x: number; y: number; button: "left" | "right" | "middle"; clicks: number }
  | { t: "wheel"; x: number; y: number; dx: number; dy: number }
  | { t: "key"; type: "down" | "up"; key: string }
  | { t: "text"; text: string }
  | { t: "ping" };

/** One picture of the page shown, and which page it is: `site` its host, `popup` a window the page opened. */
export type CleanFrame = { jpeg: Buffer; width: number; height: number; url: string; title: string; site: string; popup: boolean };

export type CleanSignInInput = {
  loginId: string;
  origin: string;
  purpose: LoginPurpose;
  condition: SignedInCondition | null;
  /** Where it opens: the node tab's page. */
  url: string;
  spec: CleanSpec;
  /** The broker's data folder: a private tab's sign-in gets a folder there for the session. */
  dataHome: string;
  /** In a window on this computer's screen, rather than streamed to the web. */
  window: boolean;
  /** The node tab's cookies for the site, so a sign-in it began (a code page) goes on here. */
  seed?: CleanCookie[];
  /** The node's tab was seen asking to sign in: a clean browser already signed in to the site is done at once. */
  asked?: boolean;
};

export class CleanBusyError extends Error {}

type Host = { dir: string; temporary: boolean; headless: boolean; browser: CleanBrowser; sessions: Set<CleanSignIn>; idle: NodeJS.Timeout | null; closing: boolean };

const hosts = new Map<string, Host>();
const starting = new Map<string, Promise<Host>>();
const settings = { windowHeadless: false, keepMs: CLEAN_KEEP_MS };

/** Tests: a "window" without a screen, and a shorter wait before an idle browser closes. */
export function cleanSignInOptionsForTests(options: Partial<typeof settings>): void {
  Object.assign(settings, options);
}

const hostOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

async function launchHost(dir: string, input: { headless: boolean; temporary: boolean; spec: CleanSpec; cookies?: CleanCookie[] }): Promise<Host> {
  const spec = input.spec;
  const browser = await CleanBrowser.launch({
    executablePath: spec.executablePath,
    userDataDir: dir,
    headless: input.headless,
    ...(spec.userAgent ? { userAgent: spec.userAgent } : {}),
    locale: spec.locale,
    ...(spec.timezone ? { timezone: spec.timezone } : {}),
    extraArgs: spec.args,
    platform: spec.platform,
    env: spec.env,
  });
  if (input.cookies?.length) await browser.setCookies(input.cookies).catch(() => undefined);
  const host: Host = { dir, temporary: input.temporary, headless: input.headless, browser, sessions: new Set(), idle: null, closing: false };
  hosts.set(dir, host);
  browser.once("closed", () => {
    if (hosts.get(dir) === host) hosts.delete(dir);
    if (host.idle) clearTimeout(host.idle);
    for (const session of [...host.sessions]) void session.close("closed");
    if (host.temporary) void rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  return host;
}

async function closeHost(host: Host): Promise<void> {
  if (host.closing) return;
  host.closing = true;
  if (hosts.get(host.dir) === host) hosts.delete(host.dir);
  if (host.idle) clearTimeout(host.idle);
  host.idle = null;
  for (const session of [...host.sessions]) await session.close("closed");
  await host.browser.close().catch(() => undefined);
  if (host.temporary) await rm(host.dir, { recursive: true, force: true }).catch(() => undefined);
}

/** The clean browser for a sign-in: the profile's own, started (or restarted with a window) as needed. */
async function hostFor(input: CleanSignInInput): Promise<Host> {
  const headless = !input.window || settings.windowHeadless;
  if (!input.spec.userDataDir) {
    const root = browserRoot(input.dataHome);
    await mkdir(root, { recursive: true, mode: 0o700 });
    // A leading dot: never a profile name an agent could open.
    return launchHost(await mkdtemp(join(root, ".private-signin-")), { headless, temporary: true, spec: input.spec });
  }
  const dir = input.spec.userDataDir;
  for (let pending = starting.get(dir); pending; pending = starting.get(dir)) await pending.catch(() => undefined);
  const work = (async () => {
    let host = hosts.get(dir);
    if (host && (host.browser.closed || host.closing)) {
      hosts.delete(dir);
      host = undefined;
    }
    if (host && !headless && host.headless) {
      if (host.sessions.size) throw new CleanBusyError("Someone is signing in with this browser from the web right now. Finish there first.");
      // To a window: its session cookies come along (cookies with an expiry stay in the folder).
      const carried = (await host.browser.cookies().catch(() => [])).filter((cookie) => cookie.expires < 0);
      await closeHost(host);
      host = await launchHost(dir, { headless: false, temporary: false, spec: input.spec, cookies: carried });
    }
    host ??= await launchHost(dir, { headless, temporary: false, spec: input.spec });
    if (host.idle) clearTimeout(host.idle);
    host.idle = null;
    return host;
  })();
  starting.set(dir, work);
  try {
    return await work;
  } finally {
    if (starting.get(dir) === work) starting.delete(dir);
  }
}

/** Closes every clean sign-in browser (this computer stopped taking work, or the runtime ends). */
export async function closeCleanBrowsers(): Promise<void> {
  for (const host of [...hosts.values()]) await closeHost(host);
}

/** One sign-in in a clean browser: its pages, what is shown, the owner's input, and the watch. Events: `frame` (CleanFrame), `done` (status), `closed` (reason). */
export class CleanSignIn extends EventEmitter {
  /** Every host its pages went to: the site, and the identity providers it passed through. */
  readonly visited = new Set<string>();
  /** Its pages: the sign-in's own first, then the windows they opened, newest last. */
  readonly pages: CleanPage[] = [];
  closed = false;
  private shown: CleanPage | null = null;
  private casting = false;
  private readonly keyboards = new Map<string, CleanKeyboard>();
  private readonly sizes = new Map<string, { width: number; height: number }>();
  /** Its listeners on each page, taken off when it ends (a kept page serves the next sign-in). */
  private readonly pageListeners = new Map<CleanPage, { navigated: (url: string) => void; load: () => void }>();
  private readonly watch: Watch;
  private timer: NodeJS.Timeout | null = null;
  private soonTimer: NodeJS.Timeout | null = null;
  private soonAt = 0;
  private looking = false;
  private buttons = 0;
  private pointer: { x: number; y: number } | null = null;
  /** What the last look saw, for the owner's card when they say they are done too early. */
  lastJudged: Judged | null = null;

  private readonly onPage = (page: CleanPage) => {
    // A window one of its pages opened (a "Sign in with Google" popup) is its own, and is shown.
    if (this.closed || !page.openerId || !this.pages.some((own) => own.targetId === page.openerId)) return;
    this.adopt(page);
    void this.show(page);
  };

  private readonly onPageClosed = (page: CleanPage) => {
    const index = this.pages.indexOf(page);
    if (index < 0) return;
    this.pages.splice(index, 1);
    this.keyboards.delete(page.targetId);
    this.sizes.delete(page.targetId);
    if (!this.pages.length) return void this.close("closed");
    if (this.shown === page) {
      this.shown = null;
      void this.show(this.pages.at(-1)!);
    }
    this.soon();
  };

  private constructor(
    readonly setup: CleanSignInInput,
    private readonly host: Host,
  ) {
    super();
    this.watch = new Watch({ origin: setup.origin, purpose: setup.purpose, condition: setup.condition, requireChallenge: false, askedElsewhere: setup.asked === true });
    host.browser.on("page", this.onPage);
    host.browser.on("pageClosed", this.onPageClosed);
  }

  /** Opens a sign-in at its page. Throws when the browser cannot start, or (`CleanBusyError`) is busy with a sign-in from the web. */
  static async open(input: CleanSignInInput): Promise<CleanSignIn> {
    const host = await hostFor(input);
    const taken = new Set([...host.sessions].flatMap((session) => session.pages.map((page) => page.targetId)));
    const session = new CleanSignIn(input, host);
    host.sessions.add(session);
    try {
      const root = host.browser.pages().find((page) => !taken.has(page.targetId) && (page.url === "about:blank" || page.url === "")) ?? (await host.browser.newPage());
      session.adopt(root);
      session.shown = root;
      if (input.seed?.length) await host.browser.setCookies(input.seed).catch(() => undefined);
      await root.navigate(input.url).catch(() => undefined);
      if (!host.headless) await root.bringToFront();
      session.timer = setInterval(() => void session.look(), CHECK_EVERY_MS);
      session.timer.unref();
      session.soon(root.loaded ? AFTER_LOAD_MS : CHECK_EVERY_MS);
    } catch (error) {
      await session.close("failed");
      throw error;
    }
    return session;
  }

  /** It is a window on this computer's screen. */
  get window(): boolean {
    return !this.host.headless;
  }

  private adopt(page: CleanPage): void {
    if (this.pages.includes(page)) return;
    this.pages.push(page);
    const host = hostOf(page.url);
    if (host) this.visited.add(host);
    const listeners = {
      navigated: (url: string) => {
        const visited = hostOf(url);
        if (visited) this.visited.add(visited);
      },
      load: () => this.soon(),
    };
    page.on("navigated", listeners.navigated);
    page.on("load", listeners.load);
    this.pageListeners.set(page, listeners);
  }

  /** The page the owner sees and types into. */
  get current(): CleanPage | null {
    return this.shown && !this.shown.closed ? this.shown : (this.pages.at(-1) ?? null);
  }

  private async show(page: CleanPage): Promise<void> {
    if (this.closed || this.shown === page) return;
    const previous = this.shown;
    this.shown = page;
    if (this.casting) {
      if (previous && !previous.closed) await previous.stopScreencast().catch(() => undefined);
      await page.bringToFront();
      await page.startScreencast((frame) => this.frame(page, frame)).catch(() => undefined);
    } else if (!this.host.headless) {
      await page.bringToFront();
    }
  }

  private frame(page: CleanPage, raw: ScreencastFrame): void {
    if (this.closed || page !== this.shown) return;
    const width = Math.round(raw.width) || this.sizes.get(page.targetId)?.width || 0;
    const height = Math.round(raw.height) || this.sizes.get(page.targetId)?.height || 0;
    if (width && height) this.sizes.set(page.targetId, { width, height });
    this.emit("frame", { jpeg: Buffer.from(raw.data, "base64"), width, height, url: page.url, title: page.title, site: hostOf(page.url) ?? "", popup: page !== this.pages[0] } satisfies CleanFrame);
  }

  /** Starts streaming the page shown (`frame` events); its size in CSS pixels. */
  async startStreaming(): Promise<{ width: number; height: number }> {
    const page = this.current;
    if (!page) throw new Error("The sign-in's page closed.");
    this.casting = true;
    this.shown = page;
    await page.bringToFront();
    const size = await page.viewport();
    if (size.width && size.height) this.sizes.set(page.targetId, size);
    await page.startScreencast((frame) => this.frame(page, frame));
    return size.width && size.height ? size : { width: 1280, height: 800 };
  }

  async stopStreaming(): Promise<void> {
    this.casting = false;
    await this.shown?.stopScreencast().catch(() => undefined);
  }

  /** The owner's input, on the page shown. */
  async input(event: OwnerInput): Promise<void> {
    await Promise.all(this.dispatch(event));
  }

  /**
   * Several inputs at once: every DevTools command is sent at once, in order, and then waited for.
   * Chromium applies them in the order they were sent, so a burst of keys costs one round trip, not one each.
   */
  async inputs(events: readonly OwnerInput[]): Promise<void> {
    const sent = events.flatMap((event) => this.dispatch(event));
    const results = await Promise.allSettled(sent);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  /** Sends one input's commands now, in order, without waiting for them; their answers. */
  private dispatch(event: OwnerInput): Array<Promise<unknown>> {
    const page = this.current;
    if (!page || page.closed || event.t === "ping") return [];
    if (event.t === "text") return [page.insertText(event.text)];
    let keyboard = this.keyboards.get(page.targetId);
    if (!keyboard) {
      keyboard = new CleanKeyboard(this.setup.spec.platform);
      this.keyboards.set(page.targetId, keyboard);
    }
    if (event.t === "key") {
      const { events, insert } = keyboard.events(event.type, event.key);
      const sent: Array<Promise<unknown>> = [];
      if (insert) sent.push(page.insertText(insert));
      for (const item of events) sent.push(page.key(item.type, item));
      if (event.key === "Enter") this.soon(1_500);
      return sent;
    }
    const size = this.sizes.get(page.targetId) ?? { width: 1280, height: 800 };
    const x = Math.round(event.x * (size.width || 1280));
    const y = Math.round(event.y * (size.height || 800));
    const modifiers = keyboard.modifiersHeld();
    if (event.t === "wheel") {
      this.pointer = { x, y };
      return [page.mouse("mouseMoved", x, y, { buttons: this.buttons, modifiers }), page.wheel(x, y, event.dx, event.dy)];
    }
    const bit = event.button === "right" ? 2 : event.button === "middle" ? 4 : 1;
    if (event.type === "move") {
      this.pointer = { x, y };
      return [page.mouse("mouseMoved", x, y, { buttons: this.buttons, modifiers })];
    }
    const sent: Array<Promise<unknown>> = [];
    if (!this.pointer || this.pointer.x !== x || this.pointer.y !== y) sent.push(page.mouse("mouseMoved", x, y, { buttons: this.buttons, modifiers }));
    this.pointer = { x, y };
    if (event.type === "down") {
      this.buttons |= bit;
      sent.push(page.mouse("mousePressed", x, y, { button: event.button, clickCount: event.clicks, buttons: this.buttons, modifiers }));
    } else {
      this.buttons &= ~bit;
      sent.push(page.mouse("mouseReleased", x, y, { button: event.button, clickCount: event.clicks, buttons: this.buttons, modifiers }));
      this.soon(1_500);
    }
    return sent;
  }

  /** Looks in `ms`, or sooner when a look is already due sooner. */
  private soon(ms = AFTER_LOAD_MS): void {
    if (this.closed) return;
    const at = Date.now() + ms;
    if (this.soonTimer && this.soonAt <= at) return;
    if (this.soonTimer) clearTimeout(this.soonTimer);
    this.soonAt = at;
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null;
      void this.look();
    }, ms);
    this.soonTimer.unref();
  }

  /** One look: the windows it opened can only show the sign-in is under way; its own page decides. */
  private async look(): Promise<void> {
    if (this.closed || !this.pages.length) return;
    if (this.looking) return this.soon(AFTER_LOAD_MS);
    this.looking = true;
    try {
      let jar: Promise<CleanCookie[]> | null = null;
      const cookies = () => (jar ??= this.host.browser.cookies());
      let askedAside = false;
      for (const page of this.pages.slice(1)) if (await this.watch.observeAside(cleanProbe(page, cookies)).catch(() => false)) askedAside = true;
      const root = this.pages[0];
      if (!root || this.closed) return;
      const seen = await this.watch.observe(cleanProbe(root, cookies), askedAside);
      this.lastJudged = seen.judged;
      if (seen.done && !this.closed) this.emit("done", seen.status);
    } catch {
      // A page closed or navigated during the look: the next one sees it.
    } finally {
      this.looking = false;
    }
  }

  /** Asked now (I'm done): what its own page shows, without the watch's history. */
  async check(): Promise<Judged> {
    const root = this.pages[0];
    if (!root) return { ok: false, asking: false, challenge: null, reason: "Its window closed." };
    const probe = cleanProbe(root, () => this.host.browser.cookies());
    const signs = await probe.signs();
    const condition = this.setup.condition;
    return judge(signs, { origin: this.setup.origin, purpose: this.setup.purpose, condition, selectorVisible: condition?.selector ? await probe.visible(condition.selector) : null });
  }

  /** The cookies to move into the node's browser: the site's, and those of every host its pages went to. */
  async cookiesToCarry(): Promise<CleanCookie[]> {
    const all = await this.host.browser.cookies();
    const site = siteOf(this.setup.origin);
    const hostsSeen = [...this.visited];
    return all.filter((cookie) => (site !== null && cookieOfSite(cookie.domain, site)) || hostsSeen.some((host) => cookieForHost(cookie, host)));
  }

  /** The site's local storage, read through a page on it (no page script). */
  async storageOf(origin: string): Promise<Array<[string, string]>> {
    const page = this.pages.find((item) => safeOrigin(item.url) === origin) ?? this.pages[0];
    return page ? page.localStorage(origin) : [];
  }

  /** Where its own page ended, when that is the site (not a step of signing in): the node's tab goes there. */
  landing(): string | null {
    const root = this.pages[0];
    return root && onSite(root.url, this.setup.origin) && !isSignInFlow(root.url, this.setup.origin) ? root.url : null;
  }

  /** Ends it: its pages close (a window closes; a browser without one stays ten minutes for the next sign-in). */
  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.soonTimer) clearTimeout(this.soonTimer);
    this.host.browser.off("page", this.onPage);
    this.host.browser.off("pageClosed", this.onPageClosed);
    for (const [page, listeners] of this.pageListeners) {
      page.off("navigated", listeners.navigated);
      page.off("load", listeners.load);
    }
    this.pageListeners.clear();
    const host = this.host;
    host.sessions.delete(this);
    if (this.casting) await this.shown?.stopScreencast().catch(() => undefined);
    for (const page of this.pages) {
      const keyboard = this.keyboards.get(page.targetId);
      if (keyboard && !page.closed) await keyboard.release(page).catch(() => undefined);
    }
    if (!host.browser.closed && !host.closing) {
      if (!host.sessions.size && (!host.headless || host.temporary)) {
        await closeHost(host);
      } else {
        const others = host.browser.pages().filter((page) => !this.pages.includes(page));
        const open = this.pages.filter((page) => !page.closed);
        // The browser keeps one page: without any it would end.
        const keep = others.length ? null : (open[0] ?? null);
        for (const page of open) if (page !== keep) await page.close();
        if (keep) await keep.navigate("about:blank").catch(() => undefined);
        if (!host.sessions.size) {
          host.idle = setTimeout(() => void closeHost(host), settings.keepMs);
          host.idle.unref();
        }
      }
    }
    this.emit("closed", reason);
  }
}
