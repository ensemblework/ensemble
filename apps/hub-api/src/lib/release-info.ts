import { ENSEMBLE_VERSION } from "@ensemble/shared-types";
import { deployedCommit } from "./health.js";

type Release = { tag_name?: string; draft?: boolean; prerelease?: boolean; assets?: Array<{ name: string; browser_download_url: string }> };
type Published = { version: string; assets: Array<{ name: string; url: string }> };
export function compareRelease(a: string, b: string): number {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { const diff = (left[i] ?? 0) - (right[i] ?? 0); if (diff) return diff; }
  return 0;
}
export function publishedVersions(input: Release[]) {
  const latest = (prefix: string): Published | null => {
    const release = input.filter(row => !row.draft && !row.prerelease && new RegExp(`^${prefix}\\d+\\.\\d+\\.\\d+$`).test(row.tag_name ?? "")).sort((a, b) => compareRelease(b.tag_name!.slice(prefix.length), a.tag_name!.slice(prefix.length)))[0];
    return release ? { version: release.tag_name!.slice(prefix.length), assets: (release.assets ?? []).filter(asset => asset.browser_download_url.startsWith("https://github.com/ensemblework/ensemble/releases/download/")).map(asset => ({ name: asset.name, url: asset.browser_download_url })) } : null;
  };
  return { desktop: latest("desktop-v"), cli: latest("cli-v") };
}
let cached: { until: number; releases: ReturnType<typeof publishedVersions> | null } | undefined;
let loading: Promise<ReturnType<typeof publishedVersions> | null> | undefined;
async function checkPublished() {
  if (cached && cached.until > Date.now()) return cached.releases;
  loading ??= (async () => {
    try {
      const response = await fetch("https://api.github.com/repos/ensemblework/ensemble/releases?per_page=50", { headers: { accept: "application/vnd.github+json", "user-agent": `Ensemble/${ENSEMBLE_VERSION}` }, signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error("unavailable");
      const releases = publishedVersions(await response.json() as Release[]);
      cached = { releases, until: Date.now() + 300_000 }; return releases;
    } catch { cached = { releases: null, until: Date.now() + 30_000 }; return null; }
  })().finally(() => { loading = undefined; });
  return loading;
}
export async function releaseInfo(updates = false) {
  const releases = updates ? await checkPublished() : null;
  return { version: ENSEMBLE_VERSION, commit: deployedCommit() ?? null, mode: process.env.ENSEMBLE_DESKTOP === "1" ? "local" as const : "web" as const, checked: Boolean(releases), releases };
}

let desktopManifest: { until: number; version: string; data: Record<string, unknown> } | undefined;
export async function desktopUpdate(target: string, arch: string, current: string) {
  const releases = await checkPublished();
  if (!releases) throw new Error("Updates are unavailable right now. Try again later.");
  const latest = releases.desktop;
  if (!latest || compareRelease(latest.version, current) <= 0) return null;
  if (!desktopManifest || desktopManifest.until < Date.now() || desktopManifest.version !== latest.version) {
    const asset = latest.assets.find(row => row.name === "latest.json");
    if (!asset) throw new Error("This update is still being prepared. Try again later.");
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("Updates are unavailable right now. Try again later.");
    const data = await response.json() as Record<string, unknown>;
    if (data.version !== latest.version) throw new Error("This update is still being prepared. Try again later.");
    desktopManifest = { until: Date.now() + 300_000, version: latest.version, data };
  }
  const data = desktopManifest.data;
  const entry = (data.platforms as Record<string, { url?: string; signature?: string }> | undefined)?.[`${target}-${arch}`];
  if (!entry?.signature || !entry.url?.startsWith(`https://github.com/ensemblework/ensemble/releases/download/desktop-v${latest.version}/`)) return null;
  return { version: latest.version, notes: data.notes, pub_date: data.pub_date, url: entry.url, signature: entry.signature };
}
