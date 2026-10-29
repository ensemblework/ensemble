/**
 * The browser and capture tools on a coding agent's run MCP server (docs/30 §9, docs/25 §10): the
 * same tool layer the node uses (`runBrowserTool`, `runCaptureTool`), for one operation, the run's job,
 * writing into the run's evidence folder. What the tools write is the run's evidence at once
 * (evidence/captures.ts): uploaded with its other files, or held for the owner's preview. A run with
 * the internet off browses only this computer's own addresses, and an app it starts for capture runs
 * in its folder, sandboxed as the run is. When the run ends, its recordings are finished and kept, and
 * its tabs, apps and displays end (`finishRunCapture`).
 */
import { realpath } from "node:fs/promises";
import { BROWSER_TOOLS, browserToolDefinitions, isBrowserTool, runBrowserTool } from "../browser/tools.js";
import { browserBroker, runningBroker } from "../browser/index.js";
import { captureService } from "../capture/index.js";
import type { MediaFile } from "../capture/media.js";
import { CAPTURE_TOOLS, captureToolDefinitions, isCaptureTool, runCaptureTool } from "../capture/tools.js";
import { releaseOperation } from "../capture/runtime.js";
import { savedSecretValues } from "../lib/run-secrets.js";
import { liveFrameFor } from "../remote/live.js";
import type { JobContext } from "../workspace/tools.js";
import { within } from "../workspace/guard.js";
import { capturedFiles, finishedFiles, recordCaptures, recordedNote } from "./captures.js";
import { prepareEvidenceDir } from "./files.js";

/** Every browser and capture tool name. */
export const CAPTURE_RUN_TOOLS: readonly string[] = [...BROWSER_TOOLS.map((tool) => tool.name), ...CAPTURE_TOOLS.map((tool) => tool.name)];

export function isRunCaptureTool(name: string): boolean {
  return isBrowserTool(name) || isCaptureTool(name);
}

/**
 * The tools a run's MCP server lists: all of them when this computer has a browser for Ensemble,
 * else only capture_status, which says what to install.
 */
export function runCaptureToolList(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const all = [...browserToolDefinitions(), ...captureToolDefinitions()];
  if (browserBroker().chromium(true)) return all;
  return all.filter((tool) => tool.name === "capture_status");
}

const URL_TOOLS = new Set(["browser_open", "capture_screenshot", "capture_video", "capture_check"]);

/** The run's folder, or one the person let it work in. */
async function runFolder(ctx: Pick<JobContext, "root" | "grants">, cwd: string): Promise<string> {
  const real = await realpath(cwd).catch(() => null);
  if (!real || !(within(ctx.root, real) || (ctx.grants ?? []).some((grant) => within(grant, real)))) {
    throw new Error("Start apps in this run's folder (or one you were let into).");
  }
  return real;
}

/** One browser or capture tool call of a run: run, its files recorded as the run's evidence. */
export async function runRunCaptureTool(ctx: JobContext, name: string, input: unknown): Promise<{ ok: boolean; text: string }> {
  const operation = ctx.job.id;
  const evidenceDir = await prepareEvidenceDir(ctx.prisma, ctx.job.id);
  const loopbackOnly = !ctx.network;
  let args = (input && typeof input === "object" ? { ...(input as Record<string, unknown>) } : {}) as Record<string, unknown>;
  if (loopbackOnly && URL_TOOLS.has(name) && typeof args.url === "string") {
    const { isLoopbackUrl } = await import("../browser/broker.js");
    if (!isLoopbackUrl(args.url)) return { ok: false, text: "This run has the internet off: the browser opens only this computer's own addresses (localhost)." };
  }
  if (name === "capture_app_start" && typeof args.cwd === "string") {
    try {
      args = { ...args, cwd: await runFolder(ctx, args.cwd.startsWith("/") ? args.cwd : `${ctx.root}/${args.cwd}`) };
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error) };
    }
  }
  const result = isBrowserTool(name)
    ? await runBrowserTool(browserBroker(), name, args, { operation, evidenceDir, loopbackOnly, onLiveFrame: liveFrameFor(ctx.job.id) })
    : await runCaptureTool(await captureService(), name, args, { operation, evidenceDir, loopbackOnly, network: ctx.network, unsandboxedApps: !ctx.sandboxed });
  const files = [...(result.ok ? capturedFiles(result.result) : []), ...finishedFiles(runningBroker()?.takeFinished(operation) ?? [])];
  const recorded = files.length ? await recordCaptures(ctx.prisma, { userId: ctx.userId, jobId: ctx.job.id }, files, await savedSecretValues(ctx.prisma, ctx.userId).catch(() => [])) : { rows: [], refused: [] };
  for (const row of recorded.rows) await ctx.event("evidence", { id: row.id, name: row.name, kind: row.kind, size: row.size, via: name, ...(row.held ? { held: true } : {}) });
  const note = recordedNote(recorded);
  if (!result.ok) return { ok: false, text: [result.error.message, note].filter(Boolean).join("\n") };
  return { ok: true, text: [result.summary, note].filter(Boolean).join("\n") };
}

/**
 * When a run ends: recordings still going are finished and kept as its evidence (held as they were
 * watched), then its tabs, apps and displays end. Starts nothing for a run that never used them.
 */
export async function finishRunCapture(ctx: Pick<JobContext, "prisma" | "job" | "userId">): Promise<void> {
  const operation = ctx.job.id;
  const broker = runningBroker();
  const stopped: MediaFile[] = [];
  for (const tab of broker ? await broker.list(operation).catch(() => []) : []) {
    if (!tab.recording) continue;
    const done = await broker!.record(operation, tab.tab, { kind: tab.recording, action: "stop" }).catch(() => null);
    if (done?.file) stopped.push(done.file);
  }
  await releaseOperation(operation);
  const left = finishedFiles([...stopped, ...(broker?.takeFinished(operation) ?? [])]);
  if (left.length) await recordCaptures(ctx.prisma, { userId: ctx.userId, jobId: ctx.job.id }, left, await savedSecretValues(ctx.prisma, ctx.userId).catch(() => []));
}
