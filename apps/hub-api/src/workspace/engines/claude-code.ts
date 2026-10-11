/**
 * Claude Code as the run's engine: the person's own `claude`, signed in with
 * their own account, started headless (`claude -p … --output-format
 * stream-json`). Ensemble never sees their credentials.
 *
 * Every tool call goes through a per-run PreToolUse hook (scripts/
 * ensemble-hook.mjs --engine) that asks this runtime, which judges it by the
 * run's mode, trust, outside-path, git and internet rules (`judge.ts`) and
 * opens a Needs me card when the person must answer. Questions go through
 * Ensemble's `ask_person` MCP tool (scripts/ensemble-ask-mcp.mjs), because
 * headless Claude Code has no question tool of its own; the answer comes back
 * as that tool's result.
 *
 * With the sandbox on, Claude Code's own OS sandbox (Anthropic's
 * sandbox-runtime: Seatbelt on macOS, bubblewrap on Linux) confines its shell
 * commands to the work folder, strictly: it never retries outside it, and it
 * refuses to start where the sandbox cannot run. Wrapping the whole `claude`
 * process in Ensemble's sandbox instead would cut it off from its own
 * sign-in.
 */
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { appendLive } from "../live-log.js";
import { hostExecutable } from "../policy.js";
import { cacheDir } from "../guard.js";
import type { JobContext } from "../tools.js";
import { hookScriptPath, localApiUrl, registerEngineRun, unregisterEngineRun } from "./registry.js";

export type EngineResult = { text: string; turns: number; toolCalls: number; tokensIn: number; tokensOut: number; model: string | null; costUsd: number | null };

/** Keys that would make `claude -p` bill an API key instead of the person's own sign-in. */
const KEY_VARIABLES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];

export async function detectClaudeCode(): Promise<{ path: string; version: string } | null> {
  try {
    const path = await hostExecutable("claude");
    const result = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 10_000 });
    if (result.status !== 0) return null;
    return { path, version: result.stdout.trim().split(/\s+/)[0] ?? "" };
  } catch {
    return null;
  }
}

/** The per-run settings: the hook on every tool call, and the sandbox and internet the run asked for. */
export function claudeSettings(input: { hookCommand: string; sandboxed: boolean; network: boolean; writable: string[] }): Record<string, unknown> {
  return {
    hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: input.hookCommand, timeout: 86_400 }] }] },
    sandbox: input.sandboxed
      ? {
          enabled: true,
          failIfUnavailable: true,
          allowUnsandboxedCommands: false,
          // Ensemble's hook decides every command first; the sandbox is the floor under it.
          autoAllowBashIfSandboxed: true,
          filesystem: { allowWrite: input.writable },
          network: input.network ? {} : { allowedDomains: [], strictAllowlist: true },
        }
      : { enabled: false },
    permissions: input.network ? { allow: ["WebFetch(domain:*)", "WebSearch"] } : { deny: ["WebFetch", "WebSearch"] },
  };
}

function summarize(name: string, input: Record<string, unknown>): string {
  const value = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? "";
  return `${name}${value ? ` ${String(value).slice(0, 120)}` : ""}`;
}

export async function runClaudeCode(
  ctx: JobContext,
  options: { prompt: string; model?: string | null; maxTurns: number; stopCheck: () => Promise<void> },
): Promise<EngineResult> {
  const claude = await hostExecutable("claude").catch(() => {
    throw new Error("Claude Code is not installed on this computer (the `claude` command was not found). Install it and sign in, or pick another engine.");
  });
  const credential = registerEngineRun(ctx);
  const hookCommand = `"${process.execPath}" "${hookScriptPath()}" --source claude --engine`;
  const settings = claudeSettings({ hookCommand, sandboxed: ctx.sandboxed, network: ctx.network, writable: [ctx.root, await cacheDir()] });
  const args = [
    "-p",
    options.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "default",
    // The person's own settings only: a repository's .claude/ hooks and servers do not run.
    "--setting-sources",
    "user",
    "--settings",
    JSON.stringify(settings),
    // Ensemble's ask_person tool: headless Claude Code has no question tool of its own.
    "--mcp-config",
    JSON.stringify({ mcpServers: { ensemble: { type: "stdio", command: process.execPath, args: [hookScriptPath("ensemble-ask-mcp.mjs")] } } }),
    "--max-turns",
    String(options.maxTurns),
    ...(options.model && options.model !== "default" ? ["--model", options.model] : []),
  ];
  // A question may wait hours for the person; the tool call must not time out first.
  const env: NodeJS.ProcessEnv = { ...process.env, ENSEMBLE_ENGINE_URL: localApiUrl(), ENSEMBLE_RUN: credential, MCP_TOOL_TIMEOUT: String(86_400_000) };
  for (const key of KEY_VARIABLES) delete env[key];
  delete env.ENSEMBLE_DESKTOP_TOKEN;
  delete env.ENSEMBLE_INTERNAL_TOKEN;
  const child = spawn(claude, args, { cwd: ctx.root, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
  const result: EngineResult = { text: "", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0, model: null, costUsd: null };
  let failure: string | null = null;
  let stderr = "";
  const stop = () => {
    if (!child.pid) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  };
  ctx.signal.addEventListener("abort", stop, { once: true });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000);
  });
  const lines = createInterface({ input: child.stdout });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        appendLive(ctx.job.id, `${line}\n`);
        continue;
      }
      if (message.type === "system" && message.subtype === "init") {
        result.model = typeof message.model === "string" ? message.model : null;
        await ctx.event("engine", { engine: "claude-code", model: result.model, session: message.session_id ?? null });
        await ctx.progress(`Claude Code started${result.model ? ` (${result.model})` : ""}`);
      } else if (message.type === "assistant") {
        const body = (message.message ?? {}) as { content?: Array<Record<string, unknown>>; usage?: Record<string, number> };
        for (const part of body.content ?? []) {
          if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
            appendLive(ctx.job.id, `${part.text.trim()}\n`);
            await ctx.progress(part.text.trim().split("\n")[0]!.slice(0, 160));
          } else if (part.type === "tool_use") {
            result.toolCalls += 1;
            const summary = summarize(String(part.name ?? "tool"), (part.input ?? {}) as Record<string, unknown>);
            appendLive(ctx.job.id, `· ${summary}\n`);
            await ctx.event("tool", { name: part.name, ok: true, summary, engine: "claude-code" });
          }
        }
        await options.stopCheck();
      } else if (message.type === "result") {
        result.text = typeof message.result === "string" ? message.result : "";
        result.turns = typeof message.num_turns === "number" ? message.num_turns : result.turns;
        result.costUsd = typeof message.total_cost_usd === "number" ? message.total_cost_usd : null;
        const usage = (message.usage ?? {}) as Record<string, number>;
        result.tokensIn = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        result.tokensOut = usage.output_tokens ?? 0;
        if (message.is_error === true || (typeof message.subtype === "string" && message.subtype !== "success")) {
          failure =
            message.subtype === "error_max_turns"
              ? `Claude Code reached the limit of ${options.maxTurns} turns.`
              : `Claude Code stopped: ${result.text || String(message.subtype)}`;
        }
      }
    }
    const code = await new Promise<number>((done) => (child.exitCode !== null ? done(child.exitCode) : child.once("close", (value) => done(value ?? 1))));
    if (ctx.signal.aborted) throw new DOMException("Stopped", "AbortError");
    if (failure) throw new Error(failure);
    if (code !== 0) {
      const sandbox = /sandbox/i.test(stderr) && ctx.sandboxed;
      throw new Error(
        sandbox
          ? `Claude Code's sandbox could not start on this computer (on Linux it needs bubblewrap and socat; native Windows has none). Turn off the sandbox for this run to use Claude Code directly. ${stderr.trim().slice(-300)}`
          : `Claude Code exited with ${code}. ${stderr.trim().split("\n").slice(0, 8).join(" | ").slice(0, 700)}`,
      );
    }
    return result;
  } finally {
    ctx.signal.removeEventListener("abort", stop);
    unregisterEngineRun(ctx.job.id);
    if (child.exitCode === null) stop();
  }
}
