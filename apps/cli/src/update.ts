import { readJsonFile, writeJsonFile, type CliPaths } from "./paths.js";
import { realPathOrSelf } from "./launcher.js";
import { VERSION } from "./version.js";
import type { FetchLike } from "./http.js";

export type InstallMethod = "homebrew" | "scoop" | "winget" | "linux-package" | "install-script" | "npm" | "unknown";

export function detectInstallMethod(input: {
  bundlePath: string;
  platform?: string;
  env?: NodeJS.ProcessEnv;
  sidecarAvailable?: boolean;
  home?: string;
}): InstallMethod {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const home = input.home ?? env.HOME ?? env.USERPROFILE ?? "";
  const real = realPathOrSelf(input.bundlePath);
  const normalized = platform === "win32" ? real.replaceAll("/", "\\").toLowerCase() : real.replaceAll("\\", "/");
  const comparable = normalized.toLowerCase();
  if (platform !== "win32" && comparable.includes("/cellar/ensemble/")) return "homebrew";
  if (platform === "win32" && normalized.includes("\\scoop\\apps\\ensemble\\")) return "scoop";
  if (platform === "win32" && normalized.includes("\\winget\\packages\\")) return "winget";
  if (platform !== "win32" && comparable.startsWith("/opt/ensemble-cli/")) return "linux-package";
  if (platform !== "win32" && home && comparable.startsWith(`${home.replaceAll("\\", "/").toLowerCase()}/.local/share/ensemble-cli/`)) return "install-script";
  const localPrograms = env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Programs\\Ensemble`.toLowerCase() : "";
  if (platform === "win32" && localPrograms && normalized.startsWith(localPrograms)) return "install-script";
  if (!input.sidecarAvailable && /(?:^|[\\/])node_modules[\\/]/.test(real)) return "npm";
  return "unknown";
}

export function upgradeInstruction(method: InstallMethod): string {
  return method === "homebrew" ? "brew upgrade ensemble" : "Choose Update Ensemble to install the latest version. Your work and settings are kept.";
}

type Release = {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
};

type UpdateCache = {
  checkedAt: string;
  latest: string | null;
};

export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => value.replace(/^cli-v/, "").split(".").map((part) => Number(part.replace(/\D.*/, "")) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function dailyUpdateNotice(input: {
  paths: CliPaths;
  currentVersion?: string;
  fetchImpl?: FetchLike;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<string | null> {
  const env = input.env ?? process.env;
  if (env.ENSEMBLE_NO_UPDATE_CHECK === "1" || env.CI) return null;
  const now = input.now ?? new Date();
  const cached = await readJsonFile<UpdateCache>(input.paths.updateCacheFile);
  if (cached && Date.parse(cached.checkedAt) > now.getTime() - 86_400_000) {
    return noticeFor(cached.latest, input.currentVersion ?? VERSION);
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  let latest = cached?.latest ?? null;
  try {
    const response = await fetchImpl("https://api.github.com/repos/ensemblework/ensemble/releases?per_page=30", {
      headers: { accept: "application/vnd.github+json", "user-agent": `ensemble-cli/${input.currentVersion ?? VERSION}` },
      signal: AbortSignal.timeout(input.timeoutMs ?? 2000),
    });
    if (response.ok) {
      const releases = (await response.json()) as Release[];
      latest =
        releases
          .filter((release) => release.tag_name?.startsWith("cli-v") && !release.draft && !release.prerelease)
          .map((release) => release.tag_name!)
          .sort((a, b) => compareVersions(b, a))[0] ?? latest;
    }
  } catch {
    // Offline, slow or rate limited: keep the last answer and try again tomorrow.
  }
  await writeJsonFile(input.paths.updateCacheFile, { checkedAt: now.toISOString(), latest }, 0o600);
  return noticeFor(latest, input.currentVersion ?? VERSION);
}

function noticeFor(latest: string | null | undefined, current: string): string | null {
  if (!latest) return null;
  return compareVersions(latest, `cli-v${current}`) > 0 ? `A newer Ensemble CLI is available (${latest.replace(/^cli-v/, "")}). Choose Update Ensemble in the app.` : null;
}


declare const __ENSEMBLE_INSTALL_SH__: string;
declare const __ENSEMBLE_INSTALL_PS1__: string;

let installingUpdate: Promise<string> | undefined;
export function installCliUpdate(bundlePath: string): Promise<string> {
  return installingUpdate ??= performCliUpdate(bundlePath).finally(() => { installingUpdate = undefined; });
}
async function performCliUpdate(bundlePath: string): Promise<string> {
  let latest: string;
  try {
    const response = await fetch("https://api.github.com/repos/ensemblework/ensemble/releases?per_page=30", { headers: { accept: "application/vnd.github+json", "user-agent": `Ensemble/${VERSION}` }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("unavailable");
    const releases = await response.json() as Release[];
    latest = releases.filter(row => !row.draft && !row.prerelease && /^cli-v\d+\.\d+\.\d+$/.test(row.tag_name ?? "")).map(row => row.tag_name!).sort((a,b) => compareVersions(b,a))[0] ?? "";
    if (!latest) throw new Error("unavailable");
  } catch { throw new Error("Could not check for updates right now. Try again in a moment."); }
  if (compareVersions(latest, VERSION) <= 0) return `Ensemble ${VERSION} is up to date.`;
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { runningRunner, stopRunner, resolveSidecarDir, sidecarAvailable } = await import("./sidecar.js");
  const { LocalApi } = await import("./tui/local.js");
  const { resolveCliPaths } = await import("./paths.js");
  const { homedir, tmpdir } = await import("node:os");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const paths = resolveCliPaths();
  const runner = await runningRunner(paths);
  if (runner) {
    const workspace = await new LocalApi(runner).workspace();
    if (workspace.running.length || workspace.waiting.length || workspace.queued.length) throw new Error("Finish or stop your active tasks, then update again.");
  }
  const method = detectInstallMethod({ bundlePath, home: homedir(), sidecarAvailable: await sidecarAvailable(resolveSidecarDir(import.meta.url)) });
  if (method === "unknown" || method === "winget" || method === "linux-package" || method === "npm") {
    const { openBrowser } = await import("./browser.js");
    await openBrowser("https://ensemblework.com/download");
    return "Choose the current installer in Downloads. Your work and settings are kept.";
  }
  const temp = await mkdtemp(join(tmpdir(), "ensemble-update-"));
  try {
    const options = { timeout: 300_000, maxBuffer: 2_000_000, windowsHide: true, env: { ...process.env, ENSEMBLE_VERSION: latest.replace(/^cli-v/, "") } };
    if (method === "homebrew") await run("brew", ["upgrade", "ensemble"], options);
    else if (method === "scoop") await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "scoop update ensemble"], options);
    else {
      const windows = process.platform === "win32";
      const script = join(temp, windows ? "install.ps1" : "install.sh");
      const contents = windows ? (typeof __ENSEMBLE_INSTALL_PS1__ === "string" ? __ENSEMBLE_INSTALL_PS1__ : null) : (typeof __ENSEMBLE_INSTALL_SH__ === "string" ? __ENSEMBLE_INSTALL_SH__ : null);
      if (!contents) throw new Error("Update this development install from Downloads.");
      await writeFile(script, contents, { mode: 0o600 });
      await run(windows ? "powershell.exe" : "/bin/sh", windows ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script] : [script], options);
    }
    if (runner && runner.owner !== "desktop") await stopRunner(paths);
    return "Update installed. Reopen Ensemble to use the new version. Your work and settings are kept.";
  } catch { throw new Error(method === "homebrew" ? "Could not update automatically. You can also use brew upgrade ensemble." : "Could not install the update right now. Try again in a moment."); }
  finally { await rm(temp, { recursive: true, force: true }); }
}
