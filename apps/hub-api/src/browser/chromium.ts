/**
 * Finding a Chromium for the broker, and Playwright's ffmpeg for capture. Playwright expects one
 * browser revision per release (`playwright-core/browsers.json`); `ensemble capture setup` installs
 * that revision into Ensemble's data folder. Until then a Playwright download already on the
 * computer, of the same or another revision, or an installed Chrome is used, and the capability
 * report says which.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensembleDataHome, playwrightBrowsersDir } from "./paths.js";

const require = createRequire(import.meta.url);

export type PlaywrightRevisions = {
  version: string;
  chromium: number;
  headlessShell: number;
  ffmpeg: number;
  chromiumVersion: string | null;
};

type BrowsersJson = { browsers: Array<{ name: string; revision: string; browserVersion?: string }> };

let revisions: PlaywrightRevisions | null = null;

/** The browser revisions the bundled playwright-core drives. */
export function playwrightRevisions(): PlaywrightRevisions {
  if (revisions) return revisions;
  // browsers.json is not in the package's exports; it sits next to package.json.
  const packageDir = dirname(require.resolve("playwright-core/package.json"));
  const browsers = (JSON.parse(readFileSync(join(packageDir, "browsers.json"), "utf8")) as BrowsersJson).browsers;
  const find = (name: string) => browsers.find((entry) => entry.name === name);
  revisions = {
    version: (JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { version: string }).version,
    chromium: Number(find("chromium")?.revision ?? 0),
    headlessShell: Number(find("chromium-headless-shell")?.revision ?? find("chromium")?.revision ?? 0),
    ffmpeg: Number(find("ffmpeg")?.revision ?? 0),
    chromiumVersion: find("chromium")?.browserVersion ?? null,
  };
  return revisions;
}

/** The playwright-core command-line entry, for `install`. */
export function playwrightCliPath(): string {
  return join(dirname(require.resolve("playwright-core/package.json")), "cli.js");
}

export type FileProbe = { exists(path: string): boolean; list(dir: string): string[] };

export const realFiles: FileProbe = {
  exists: (path) => existsSync(path),
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
};

export type Host = { platform: string; arch: string; env: NodeJS.ProcessEnv; home: string };

export const thisHost = (): Host => ({ platform: process.platform, arch: process.arch, env: process.env, home: homedir() });

/** Playwright's default download folder on this computer. */
export function playwrightCacheDir(host: Host): string {
  if (host.platform === "win32") return join(host.env.LOCALAPPDATA?.trim() || join(host.home, "AppData", "Local"), "ms-playwright");
  if (host.platform === "darwin") return join(host.home, "Library", "Caches", "ms-playwright");
  return join(host.env.XDG_CACHE_HOME?.trim() || join(host.home, ".cache"), "ms-playwright");
}

/** Folders that may hold Playwright downloads, Ensemble's own first. */
export function browserSearchRoots(host: Host, dataHome: string = ensembleDataHome(host.env, host.platform, host.home)): string[] {
  const roots = [playwrightBrowsersDir(dataHome)];
  const configured = host.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (configured && configured !== "0") roots.push(configured);
  roots.push(playwrightCacheDir(host));
  return [...new Set(roots)];
}

type Layout = { chromium: string[][]; shell: string[][]; ffmpeg: string };

/** Executable paths inside a download folder; older revisions used the `chrome-linux` layouts. */
function layout(platform: string, arch: string): Layout | null {
  if (platform === "linux") {
    const tag = arch === "arm64" ? "linux-arm64" : "linux64";
    return {
      chromium: [[`chrome-${tag}`, "chrome"], ["chrome-linux", "chrome"]],
      shell: [[`chrome-headless-shell-${tag}`, "chrome-headless-shell"], ["chrome-linux", "headless_shell"]],
      ffmpeg: "ffmpeg-linux",
    };
  }
  if (platform === "darwin") {
    const tag = arch === "arm64" ? "mac-arm64" : "mac-x64";
    return {
      chromium: [[`chrome-${tag}`, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"], ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"]],
      shell: [[`chrome-headless-shell-${tag}`, "chrome-headless-shell"], ["chrome-mac", "headless_shell"]],
      ffmpeg: "ffmpeg-mac",
    };
  }
  if (platform === "win32") {
    return {
      chromium: [["chrome-win64", "chrome.exe"], ["chrome-win", "chrome.exe"]],
      shell: [["chrome-headless-shell-win64", "chrome-headless-shell.exe"], ["chrome-win", "headless_shell.exe"]],
      ffmpeg: "ffmpeg-win64.exe",
    };
  }
  return null;
}

export type BrowserBuild = {
  kind: "chromium" | "headless-shell";
  revision: number;
  executablePath: string;
  root: string;
};

const BUILD_DIR = /^(chromium|chromium_headless_shell)-(\d+)$/;

/** Complete Playwright Chromium downloads under the roots (a download without its marker is skipped). */
export function listBrowserBuilds(roots: string[], host: Host, files: FileProbe = realFiles): BrowserBuild[] {
  const paths = layout(host.platform, host.arch);
  if (!paths) return [];
  const builds: BrowserBuild[] = [];
  for (const root of roots) {
    for (const name of files.list(root)) {
      const match = BUILD_DIR.exec(name);
      if (!match) continue;
      const dir = join(root, name);
      if (!files.exists(join(dir, "INSTALLATION_COMPLETE"))) continue;
      const kind = match[1] === "chromium" ? "chromium" : "headless-shell";
      const executablePath = (kind === "chromium" ? paths.chromium : paths.shell).map((parts) => join(dir, ...parts)).find((path) => files.exists(path));
      if (executablePath) builds.push({ kind, revision: Number(match[2]), executablePath, root });
    }
  }
  return builds;
}

const SYSTEM_CHROME: Record<string, string[]> = {
  linux: ["/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
};

export type ChromiumChoice = {
  executablePath: string;
  kind: "chromium" | "headless-shell" | "system";
  revision: number | null;
  /** The revision this playwright-core was built for. */
  matches: boolean;
  source: "explicit" | "ensemble" | "playwright" | "system";
};

/**
 * The Chromium to launch. Headless prefers the small headless shell; headed needs full Chromium.
 * The matching revision wins over any other, Ensemble's download over Playwright's shared cache,
 * then the newest other revision, then an installed Chrome. `ENSEMBLE_CHROMIUM` names one exactly.
 */
export function findChromium(options: { headless: boolean; host?: Host; dataHome?: string; files?: FileProbe }): ChromiumChoice | null {
  const host = options.host ?? thisHost();
  const files = options.files ?? realFiles;
  const explicit = host.env.ENSEMBLE_CHROMIUM?.trim();
  if (explicit) return files.exists(explicit) ? { executablePath: explicit, kind: "chromium", revision: null, matches: false, source: "explicit" } : null;
  const roots = browserSearchRoots(host, options.dataHome);
  const ensembleRoot = roots[0];
  const builds = listBrowserBuilds(roots, host, files);
  const wanted = playwrightRevisions();
  const order: Array<BrowserBuild["kind"]> = options.headless ? ["headless-shell", "chromium"] : ["chromium"];
  const pick = (build: BrowserBuild): ChromiumChoice => ({
    executablePath: build.executablePath,
    kind: build.kind,
    revision: build.revision,
    matches: build.revision === (build.kind === "chromium" ? wanted.chromium : wanted.headlessShell),
    source: build.root === ensembleRoot ? "ensemble" : "playwright",
  });
  for (const kind of order) {
    const exact = builds.find((build) => build.kind === kind && build.revision === (kind === "chromium" ? wanted.chromium : wanted.headlessShell));
    if (exact) return pick(exact);
  }
  for (const kind of order) {
    const newest = builds.filter((build) => build.kind === kind).sort((a, b) => b.revision - a.revision)[0];
    if (newest) return pick(newest);
  }
  const system = (SYSTEM_CHROME[host.platform] ?? []).find((path) => files.exists(path));
  if (system) return { executablePath: system, kind: "system", revision: null, matches: false, source: "system" };
  if (host.platform === "win32") {
    for (const base of [host.env.PROGRAMFILES, host.env["PROGRAMFILES(X86)"], host.env.LOCALAPPDATA]) {
      const path = base ? join(base, "Google", "Chrome", "Application", "chrome.exe") : null;
      if (path && files.exists(path)) return { executablePath: path, kind: "system", revision: null, matches: false, source: "system" };
    }
  }
  return null;
}

export type FfmpegBuild = { path: string; revision: number; root: string };

/** Playwright's own ffmpeg downloads (LGPL, VP8 or VP9 into WebM), newest first. */
export function listPlaywrightFfmpeg(roots: string[], host: Host, files: FileProbe = realFiles): FfmpegBuild[] {
  const paths = layout(host.platform, host.arch);
  if (!paths) return [];
  const found: FfmpegBuild[] = [];
  for (const root of roots) {
    for (const name of files.list(root)) {
      const match = /^ffmpeg-(\d+)$/.exec(name);
      if (!match) continue;
      const path = join(root, name, paths.ffmpeg);
      if (files.exists(join(root, name, "INSTALLATION_COMPLETE")) && files.exists(path)) found.push({ path, revision: Number(match[1]), root });
    }
  }
  return found.sort((a, b) => b.revision - a.revision);
}
