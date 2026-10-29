/**
 * `ensemble capture [status] | setup`: what this computer can capture for Ensemble Node
 * (screenshots and video of web pages, Electron and desktop apps), and installing what Ensemble can
 * install itself. The local runtime does the work (apps/hub-api/src/capture/cli.ts); this runs it
 * with the sidecar's Node against this channel's data folder, and prints the result.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { COMMAND } from "./channel.js";
import type { CliPaths } from "./paths.js";
import { localJson, type Discovery } from "./sidecar.js";

export type CaptureTarget = { screenshot: boolean; video: boolean; reason?: string };

export type CaptureReport = {
  platform: string;
  browser: { available: boolean; kind: string | null; revision: number | null; wanted: number; matches: boolean; source: string | null; installDir: string };
  video: { container: string; codec: string; ffmpeg: string } | null;
  virtualDisplay: { xvfb: string | null; windowManager: string | null; windowLookup: string[] };
  screenRecording?: string;
  targets: Record<string, CaptureTarget>;
  setup: { ensembleInstalls: string[]; systemCommand: string | null; notes: string[] };
};

export type SetupReport = { before: CaptureReport; after: CaptureReport; steps: Array<{ name: string; ok: boolean; detail: string }>; installDir: string };

export function captureScriptArgs(command: "status" | "setup", options: { dryRun?: boolean } = {}): string[] {
  return ["--import", "tsx", "src/capture/cli.ts", command, "--json", ...(options.dryRun ? ["--dry-run"] : [])];
}

/** The runtime reads its data folder from these, as when the CLI starts the runner. */
export function captureScriptEnv(paths: CliPaths, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, ENSEMBLE_REMOTE_STATE_DIR: paths.dataHome, ENSEMBLE_DATA_DIR: join(paths.dataHome, "pglite") };
}

export function runCaptureScript(input: { sidecarDir: string; paths: CliPaths; command: "status"; onProgress?: (line: string) => void }): Promise<CaptureReport>;
export function runCaptureScript(input: { sidecarDir: string; paths: CliPaths; command: "setup"; dryRun?: boolean; onProgress?: (line: string) => void }): Promise<SetupReport>;
export function runCaptureScript(input: { sidecarDir: string; paths: CliPaths; command: "status" | "setup"; dryRun?: boolean; onProgress?: (line: string) => void }): Promise<CaptureReport | SetupReport> {
  const node = join(input.sidecarDir, process.platform === "win32" ? "node.exe" : "node");
  return new Promise((resolve, reject) => {
    const child = spawn(node, captureScriptArgs(input.command, { dryRun: input.dryRun }), {
      cwd: join(input.sidecarDir, "app"),
      env: captureScriptEnv(input.paths),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr = (stderr + text).slice(-4_000);
      for (const line of text.split(/\r?\n|\r/)) if (line.trim()) input.onProgress?.(line.trimEnd());
    });
    child.on("error", reject);
    child.on("close", () => {
      const last = stdout.trim().split("\n").pop() ?? "";
      try {
        resolve(JSON.parse(last) as CaptureReport | SetupReport);
      } catch {
        reject(new Error(`The local runtime could not report capture: ${stderr.trim().split("\n").pop() || "no output"}`));
      }
    });
  });
}

const yes = (value: boolean) => (value ? "yes" : "no ");

export function formatCapture(caps: CaptureReport): string[] {
  const browser = caps.browser.available
    ? `${caps.browser.kind === "headless-shell" ? "Chromium (headless shell)" : caps.browser.kind === "system" ? "installed Chrome" : "Chromium"}${caps.browser.revision ? ` r${caps.browser.revision}` : ""}${caps.browser.matches ? "" : `, Ensemble expects r${caps.browser.wanted}`}`
    : "none";
  const lines = [`browser: ${browser}`, `video: ${caps.video ? `${caps.video.container.toUpperCase()} (${caps.video.codec})` : "none"}`];
  if (caps.platform === "linux") lines.push(`virtual display: ${caps.virtualDisplay.xvfb ? `Xvfb${caps.virtualDisplay.windowManager ? ` with ${caps.virtualDisplay.windowManager}` : ", no window manager"}` : "none"}`);
  if (caps.screenRecording) lines.push(`screen recording permission: ${caps.screenRecording}`);
  lines.push("", "            screenshots  video");
  for (const [target, value] of Object.entries(caps.targets)) lines.push(`  ${target.padEnd(10)}${yes(value.screenshot).padEnd(13)}${yes(value.video)}${value.reason ? `  ${value.reason}` : ""}`);
  for (const note of caps.setup.notes) lines.push(`note: ${note}`);
  if (caps.setup.ensembleInstalls.length) lines.push("", `\`${COMMAND} capture setup\` installs ${caps.setup.ensembleInstalls.join(" and ")} into ${caps.browser.installDir}.`);
  if (caps.setup.systemCommand) lines.push("", caps.platform === "linux" ? "For desktop apps and MP4 video, run this once:" : "For MP4 video, run this once:", `  ${caps.setup.systemCommand}`);
  return lines;
}

// ── sites the owner never wants captured, or previews first ────────────────

export type CaptureSites = { never: string[]; preview: string[] };
export type SitesChange = { action: "add" | "remove"; list: keyof CaptureSites; site: string };

/** `ensemble capture sites [list] | add|remove never|preview <site>`, or why the arguments are wrong. */
export function parseSitesArgs(args: string[]): { change: SitesChange | null } | { error: string } {
  const [action = "list", list, site, ...rest] = args;
  if (action === "list" && args.length <= 1) return { change: null };
  if ((action !== "add" && action !== "remove") || (list !== "never" && list !== "preview") || !site?.trim() || rest.length) {
    return { error: `Usage: ${COMMAND} capture sites [list] | add never|preview <site> | remove never|preview <site>` };
  }
  return { change: { action, list, site: site.trim() } };
}

/** The lists with one change applied (the local runtime checks and normalises each site). */
export function changeSites(sites: CaptureSites, change: SitesChange): CaptureSites {
  const key = change.site.toLowerCase();
  const next = { never: [...sites.never], preview: [...sites.preview] };
  next[change.list] = next[change.list].filter((site) => site.toLowerCase() !== key && site.toLowerCase() !== key.replace(/^\*\./, ""));
  if (change.action === "add") next[change.list].push(change.site);
  return next;
}

/** Reads the lists from this computer's runtime, applies the change if any, and returns what is kept. */
export async function captureSites(discovery: Discovery, change: SitesChange | null): Promise<CaptureSites> {
  const current = await localJson<{ captureSites?: CaptureSites }>(discovery, "/api/remote");
  const sites = { never: current.captureSites?.never ?? [], preview: current.captureSites?.preview ?? [] };
  if (!change) return sites;
  const saved = await localJson<{ captureSites?: CaptureSites }>(discovery, "/api/remote", { method: "PUT", body: JSON.stringify({ captureSites: changeSites(sites, change) }) });
  return { never: saved.captureSites?.never ?? [], preview: saved.captureSites?.preview ?? [] };
}

export function formatSites(sites: CaptureSites): string[] {
  const lines = (list: string[]) => (list.length ? list.map((site) => `  ${site}`) : ["  (none)"]);
  return [
    "Never captured (no screenshot, video, page reading or live view):",
    ...lines(sites.never),
    "Preview first (captures wait for you before they are sent anywhere):",
    ...lines(sites.preview),
  ];
}
