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
  switch (method) {
    case "homebrew":
      return "brew upgrade ensemble";
    case "scoop":
      return "scoop update ensemble";
    case "winget":
      return "winget upgrade EnsembleWork.EnsembleCLI";
    case "linux-package":
      return "Upgrade with your package manager, for example: sudo apt update && sudo apt install ensemble-cli, or sudo dnf upgrade ensemble-cli";
    case "install-script":
      return "Re-run the Ensemble install script from https://ensemblework.com/download";
    case "npm":
      return "npm i -g ensemblework@latest";
    case "unknown":
      return "Install method is unknown. Download the latest CLI from https://ensemblework.com/download";
  }
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
  return compareVersions(latest, `cli-v${current}`) > 0 ? `A newer Ensemble CLI is available (${latest.replace(/^cli-v/, "")}). Run \`ensemble update\`.` : null;
}
