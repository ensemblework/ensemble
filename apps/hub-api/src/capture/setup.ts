/**
 * `ensemble capture setup` (ensemble-node design E§8.6): installs what Ensemble can install without
 * administrator rights, Playwright's Chromium and Playwright's ffmpeg, into the data folder
 * (`<data>/playwright`), and names the one command for system packages. It never runs sudo.
 */
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { playwrightCliPath } from "../browser/chromium.js";
import { ensembleDataHome, playwrightBrowsersDir } from "../browser/paths.js";
import { computeCapabilities, realProbe, type CaptureCapabilities } from "./capabilities.js";
import { findFfmpegs } from "./ffmpeg.js";

export type SetupStep = { name: string; ok: boolean; detail: string };
export type SetupResult = { before: CaptureCapabilities; after: CaptureCapabilities; steps: SetupStep[]; installDir: string };

/** What Playwright should install: its Chromium (with the headless shell) when ours is missing or another revision, its ffmpeg when nothing encodes video. */
export function plannedInstalls(caps: CaptureCapabilities): Array<"chromium" | "ffmpeg"> {
  const items: Array<"chromium" | "ffmpeg"> = [];
  if (!caps.browser.matches) items.push("chromium");
  if (!caps.video) items.push("ffmpeg");
  return items;
}

/** The arguments for Playwright's own installer. */
export function installArgs(items: Array<"chromium" | "ffmpeg">, dryRun = false): string[] {
  return [playwrightCliPath(), "install", ...(dryRun ? ["--dry-run"] : []), ...items];
}

/** Runs Playwright's installer with Ensemble's folder as its browsers path, passing its progress on. */
export function runInstaller(items: Array<"chromium" | "ffmpeg">, options: { installDir: string; dryRun?: boolean; onOutput?: (line: string) => void; timeoutMs?: number }): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    // Downloads are unpacked next to their destination rather than in a small /tmp.
    const tmp = join(options.installDir, ".download");
    void mkdir(tmp, { recursive: true }).then(() => {
      const child = spawn(process.execPath, installArgs(items, options.dryRun), {
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: options.installDir, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let output = "";
      const take = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (output.length < 20_000) output += text;
        for (const line of text.split(/\r?\n|\r/)) if (line.trim()) options.onOutput?.(line.trimEnd());
      };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 30 * 60_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ code: null, output: `${output}\n${error.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        void rm(tmp, { recursive: true, force: true }).finally(() => resolve({ code, output }));
      });
    });
  });
}

export async function captureSetup(options: { dataHome?: string; dryRun?: boolean; onOutput?: (line: string) => void } = {}): Promise<SetupResult> {
  const dataHome = options.dataHome ?? ensembleDataHome();
  const installDir = playwrightBrowsersDir(dataHome);
  const before = await computeCapabilities(realProbe(dataHome));
  const items = plannedInstalls(before);
  const steps: SetupStep[] = [];
  if (items.length) {
    await mkdir(installDir, { recursive: true, mode: 0o700 });
    const run = await runInstaller(items, { installDir, dryRun: options.dryRun, onOutput: options.onOutput });
    const what = items.map((item) => (item === "chromium" ? "Playwright's Chromium" : "Playwright's ffmpeg")).join(" and ");
    steps.push(
      run.code === 0
        ? { name: `Install ${what}`, ok: true, detail: options.dryRun ? "Dry run: nothing was downloaded." : `Installed into ${installDir}.` }
        : { name: `Install ${what}`, ok: false, detail: `The download failed${run.code === null ? "" : ` (exit ${run.code})`}. ${lastLine(run.output)}`.trim() },
    );
  } else {
    steps.push({ name: "Playwright's Chromium and a video encoder", ok: true, detail: "Already here." });
  }
  await findFfmpegs({ dataHome, refresh: true });
  const after = await computeCapabilities(realProbe(dataHome));
  return { before, after, steps, installDir };
}

function lastLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("at "))
      .pop() ?? ""
  ).slice(0, 300);
}
