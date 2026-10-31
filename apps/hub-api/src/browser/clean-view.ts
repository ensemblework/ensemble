/**
 * Read-only views of sites that refuse the work's browser (C1, `browser_view` and `browser_shop`'s
 * fallback): an HTTP/2 or connection error, an "Access Denied" page, a page that stays empty. A clean
 * browser (browser/clean.ts: Chromium over the DevTools pipe, no page scripting) opens the address in
 * its own profile beside the work's, `<data>/browser/<profile>-clean`, takes a screenshot and reads the
 * page's HTML through the DOM domain. Nothing is typed or clicked there. One browser per profile is
 * kept warm for a few minutes after its last use, then closed.
 */
import { CleanBrowser, type CleanPage } from "./clean.js";
import { browserLook, computerLocale } from "./launch.js";
import { browserProfileDir } from "./paths.js";

export type CleanRead = {
  url: string;
  title: string;
  html: string;
  /** PNG of the viewport (or the whole page), when asked for. */
  png: Buffer | null;
  error?: string;
};

export type CleanReaderOptions = {
  executablePath: () => string;
  dataHome: () => string;
  platform?: string;
  args?: string[];
  /** How long a browser stays open after its last read (default three minutes). */
  idleMs?: number;
  log?: (message: string) => void;
};

type Warm = { browser: Promise<CleanBrowser>; timer: NodeJS.Timeout | null; reading: number };

const VIEWPORT = { width: 1280, height: 800 };

export class CleanReader {
  private readonly warm = new Map<string, Warm>();
  private closed = false;

  constructor(private readonly options: CleanReaderOptions) {}

  /** The clean profile beside a work profile. */
  static profileDir(profile: string, dataHome: string): string {
    return browserProfileDir(`${profile}-clean`, dataHome);
  }

  private async launch(profile: string): Promise<CleanBrowser> {
    const executablePath = this.options.executablePath();
    const platform = (this.options.platform ?? process.platform) as NodeJS.Platform;
    const look = browserLook({ platform, executablePath });
    const locale = computerLocale().locale;
    return CleanBrowser.launch({
      executablePath,
      userDataDir: CleanReader.profileDir(profile, this.options.dataHome()),
      headless: true,
      userAgent: look.userAgent,
      locale,
      ...(look.timezoneId ? { timezone: look.timezoneId } : {}),
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      platform,
      extraArgs: this.options.args,
    });
  }

  private entry(profile: string): Warm {
    let warm = this.warm.get(profile);
    if (!warm) {
      const browser = this.launch(profile);
      warm = { browser, timer: null, reading: 0 };
      this.warm.set(profile, warm);
      const own = warm;
      browser
        .then((started) => started.once("closed", () => this.warm.get(profile) === own && this.warm.delete(profile)))
        .catch(() => {
          if (this.warm.get(profile) === own) this.warm.delete(profile);
        });
      this.options.log?.(`clean browser for ${profile} starting`);
    }
    if (warm.timer) clearTimeout(warm.timer);
    warm.timer = null;
    return warm;
  }

  private release(profile: string, warm: Warm): void {
    warm.reading -= 1;
    if (warm.reading > 0 || this.warm.get(profile) !== warm) return;
    warm.timer = setTimeout(() => void this.close(profile), this.options.idleMs ?? 180_000);
    warm.timer.unref();
  }

  /** Opens `url` in the profile's clean browser, waits for it to settle, and reads it. Never throws. */
  async read(profile: string, url: string, input: { screenshot?: boolean; fullPage?: boolean; settleMs?: number; timeoutMs?: number; until?: (html: string) => boolean; scroll?: boolean } = {}): Promise<CleanRead> {
    if (this.closed) return { url, title: "", html: "", png: null, error: "The browser is shutting down." };
    const warm = this.entry(profile);
    warm.reading += 1;
    let page: CleanPage | null = null;
    try {
      const browser = await warm.browser;
      page = await browser.newPage();
      await page.setViewport(VIEWPORT.width, VIEWPORT.height);
      await page.goto(url, { timeoutMs: input.timeoutMs ?? 30_000 });
      if (input.scroll) {
        // Result grids fill their cards only as they come into view: the mouse wheel down a few screens, then back.
        for (let step = 0; step < 4; step += 1) {
          await page.wheel(VIEWPORT.width / 2, VIEWPORT.height / 2, 0, 700).catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
        await page.wheel(VIEWPORT.width / 2, VIEWPORT.height / 2, 0, -5_000).catch(() => undefined);
      }
      // Pages keep drawing after their load event: wait until the HTML stops growing (bounded).
      const settle = Date.now() + (input.settleMs ?? 2_500);
      let html = await page.html().catch(() => "");
      while (Date.now() < settle && !(input.until?.(html) ?? false)) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const next = await page.html().catch(() => html);
        const grew = Math.abs(next.length - html.length) > 2_000;
        html = next;
        if (!input.until && !grew && html.length > 5_000) break;
      }
      // What was waited for has come: a moment for its pictures to draw.
      if (input.until?.(html)) await new Promise((resolve) => setTimeout(resolve, 800));
      const { url: at, title } = await page.refresh();
      const png = input.screenshot ? await page.screenshot({ format: "png", fullPage: Boolean(input.fullPage) }).catch(() => null) : null;
      return { url: at || url, title, html, png };
    } catch (error) {
      return { url, title: "", html: "", png: null, error: error instanceof Error ? error.message.split("\n")[0]!.slice(0, 300) : String(error) };
    } finally {
      await page?.close().catch(() => undefined);
      this.release(profile, warm);
    }
  }

  async close(profile: string): Promise<void> {
    const warm = this.warm.get(profile);
    if (!warm) return;
    this.warm.delete(profile);
    if (warm.timer) clearTimeout(warm.timer);
    const browser = await warm.browser.catch(() => null);
    await browser?.close().catch(() => undefined);
    this.options.log?.(`clean browser for ${profile} closed`);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.warm.keys()].map((profile) => this.close(profile)));
  }

  /** Profiles with a clean browser open now. */
  open(): string[] {
    return [...this.warm.keys()];
  }
}
