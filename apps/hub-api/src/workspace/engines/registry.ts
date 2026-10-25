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

/** The agent could not reopen an earlier chat session (deleted, or from another computer): start a new one. */
export class SessionGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionGoneError";
  }
}

/** Environment for the run's ensemble MCP server: chat turns also get the person's board (`ensemble_*` tools). */
export function mcpEnv(credential: string, chat: boolean): Record<string, string> {
  return { ENSEMBLE_ENGINE_URL: localApiUrl(), ENSEMBLE_RUN: credential, ...(chat ? { ENSEMBLE_CHAT: "1" } : {}) };
}
/**
 * The engine could not start or carry on for a reason that passes: the system keychain was locked
 * right after a restart, the network or the provider's servers were down. The run waits and tries
 * again (agent.ts) instead of failing with a wrong diagnosis.
 */
export class EngineTransientError extends Error {
  constructor(
    message: string,
    /** What to tell the person if every retry fails. */
    readonly finalMessage = message,
  ) {
    super(message);
    this.name = "EngineTransientError";
  }
}

/** What an engine says when it has no usable sign-in. A bare "auth" in an error (OAuth for an MCP server, say) is not one. */
export const SIGNED_OUT = /authentication required|not (logged|signed) in|please (log|sign) ?in|unauthori[sz]ed|\b401\b|copilot login|no authentication available/i;
/** The network or GitHub's servers, not the person's account. */
export const UNREACHABLE = /ECONN(RESET|REFUSED|ABORTED)|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|fetch failed|socket hang up|network (error|is unreachable)|timed? ?out|\b(502|503|504)\b|service unavailable|rate.?limit|\b429\b/i;
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
