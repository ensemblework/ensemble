/**
 * Live engine runs on this computer, so the hook a coding agent calls can be
 * judged against its run. Each run gets a random secret that the agent's
 * hook sends back; it only lets the hook *ask* (the answer still comes from
 * the run's rules or the person), so a command that reads it gains nothing.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JobContext } from "../tools.js";
import { judgeEngineCall, type EngineAnswer, type EngineCall } from "./judge.js";

type Run = { ctx: JobContext; secret: string };
const runs = new Map<string, Run>();
let localPort = 0;

export function setLocalPort(port: number): void {
  localPort = port;
}

export function localApiUrl(): string {
  if (!localPort) throw new Error("The local API port is not known yet.");
  return `http://127.0.0.1:${localPort}`;
}

export function registerEngineRun(ctx: JobContext): string {
  const secret = randomBytes(24).toString("hex");
  runs.set(ctx.job.id, { ctx, secret });
  return `${ctx.job.id}.${secret}`;
}

export function unregisterEngineRun(jobId: string): void {
  runs.delete(jobId);
}

export function engineRunFor(credential: string | undefined): Run | null {
  if (!credential) return null;
  const dot = credential.lastIndexOf(".");
  if (dot <= 0) return null;
  const run = runs.get(credential.slice(0, dot));
  if (!run) return null;
  const given = Buffer.from(credential.slice(dot + 1));
  const expected = Buffer.from(run.secret);
  return given.length === expected.length && timingSafeEqual(given, expected) ? run : null;
}

export async function judge(run: Run, call: EngineCall): Promise<EngineAnswer> {
  await run.ctx.event("engine_tool", { tool: call.tool, ...(typeof call.input.command === "string" ? { command: String(call.input.command).slice(0, 300) } : {}) });
  return judgeEngineCall(run.ctx, call);
}

/** A root `scripts/` file: in the repository, or copied into the packaged sidecar at app/scripts/hooks/. */
export function hookScriptPath(name = "ensemble-hook.mjs"): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, "../../../../../scripts", name), resolve(here, "../../../scripts/hooks", name)];
  return candidates.find((path) => existsSync(path)) ?? candidates[0]!;
}
