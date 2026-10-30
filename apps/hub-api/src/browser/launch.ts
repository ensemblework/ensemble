/**
 * How Ensemble's browser presents itself to web sites: as the Chrome it is, on this computer, not as
 * an automated browser. Shops and search engines block automated browsing (a 503, "Robot or human?")
 * on the signals Playwright leaves by default: the `HeadlessChrome` user agent, `navigator.webdriver`,
 * the `--enable-automation` switch, and a language and time zone that do not match the computer.
 * This changes how the browser looks only; what it may do (no script evaluation, no raw CDP for
 * agents, the owner's privacy rules) is unchanged. A human check it still meets goes to the owner
 * (browser/human-check.ts).
 */
import { spawnSync } from "node:child_process";
import { playwrightRevisions } from "./chromium.js";

/** Chromium switches for every launch: no `AutomationControlled` blink feature (it sets `navigator.webdriver`). */
export const LAUNCH_ARGS = ["--disable-blink-features=AutomationControlled"];
/** Playwright's defaults left out: `--enable-automation` marks the browser as automated. */
export const IGNORED_DEFAULT_ARGS = ["--enable-automation"];
/** Runs before any page script, in every frame: `navigator.webdriver` reads as a person's browser does. */
export const HIDE_WEBDRIVER = "Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true });";

const versions = new Map<string, string | null>();

/** The browser's version (`131.0.6778.33`) from `--version`; null where it prints none (Windows). */
export function chromiumVersion(executablePath: string, run: (path: string) => string = (path) => spawnSync(path, ["--version"], { encoding: "utf8", timeout: 5_000, windowsHide: true }).stdout ?? ""): string | null {
  if (!versions.has(executablePath)) {
    let version: string | null = null;
    try {
      version = /(\d+\.\d+\.\d+\.\d+)/.exec(run(executablePath))?.[1] ?? null;
    } catch {
      version = null;
    }
    versions.set(executablePath, version);
  }
  return versions.get(executablePath) ?? null;
}

/**
 * The user agent Chrome of this version sends on this system, as Chrome reduces it (the major version
 * only); never "HeadlessChrome". Null without a version.
 */
export function userAgentFor(version: string | null, platform: string): string | null {
  const major = version ? /^(\d+)\./.exec(version)?.[1] : null;
  if (!major) return null;
  const system = platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : platform === "win32" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64";
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** This computer's language and time zone, as the browser should report them. */
export function computerLocale(resolved: { locale?: string; timeZone?: string } = Intl.DateTimeFormat().resolvedOptions()): { locale: string; timezoneId: string | null; acceptLanguage: string } {
  const locale = resolved.locale && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(resolved.locale) ? resolved.locale : "en-US";
  const language = locale.split("-")[0]!;
  return { locale, timezoneId: resolved.timeZone || null, acceptLanguage: language === locale ? locale : `${locale},${language};q=0.9` };
}

export type BrowserLook = { userAgent?: string; locale: string; timezoneId?: string; extraHTTPHeaders: Record<string, string> };

/** The context options that make the browser look like this computer's Chrome: its version from the browser, else its executable. */
export function browserLook(input: { platform: string; version?: string | null; executablePath?: string; resolved?: { locale?: string; timeZone?: string } }): BrowserLook {
  const version = input.version !== undefined ? input.version : ((input.executablePath ? chromiumVersion(input.executablePath) : null) ?? playwrightRevisions().chromiumVersion);
  const userAgent = userAgentFor(version, input.platform);
  const { locale, timezoneId, acceptLanguage } = computerLocale(input.resolved);
  return { ...(userAgent ? { userAgent } : {}), locale, ...(timezoneId ? { timezoneId } : {}), extraHTTPHeaders: { "Accept-Language": acceptLanguage } };
}
