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
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { desktopDataDir } from "@ensemble/shared-types/desktop-discovery";
import { askpassPath, cacheDir, ENSEMBLE_SOURCE } from "../guard.js";
import { appendLive, touchLive } from "../live-log.js";
import { claudeBinary } from "../../subscriptions/detect.js";
import { LINUX_TOOLCHAIN_HOME } from "../sandbox/linux.js";
import { SECRET_HOME_PATHS, TOOLCHAIN_HOME_READS } from "../sandbox/seatbelt.js";
import type { JobContext } from "../tools.js";
import type { OutsideAccess } from "../trust.js";
import { hookScriptPath, mcpEnv, registerEngineRun, SessionGoneError, unregisterEngineRun } from "./registry.js";
import { EngineTrace } from "./trace.js";

export type EngineResult = {
  text: string;
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  model: string | null;
  costUsd: number | null;
  /** The run's steps as the engine worked (tool calls, thinking, messages); the caller adds the result. */
  trace?: EngineTrace;
};

/** Keys that would make `claude -p` bill an API key instead of the person's own sign-in. */
const KEY_VARIABLES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];

export async function detectClaudeCode(): Promise<{ path: string; version: string } | null> {
  try {
    const path = (await claudeBinary())?.path;
    if (!path) return null;
    const result = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 10_000 });
    if (result.status !== 0) return null;
    return { path, version: result.stdout.trim().split(/\s+/)[0] ?? "" };
  } catch {
    return null;
  }
}

export type ClaudeFilesystem = { allowWrite: string[]; denyWrite?: string[]; denyRead: string[]; allowRead?: string[] };

/**
 * Claude Code's sandbox paths for the run's "Outside the work folder" setting, so a script it runs
 * gets the same answer as a named path does from the hook. Keys, browser data and Ensemble's own
 * data (`closed`) stay shut in every case; read and write opens the person's own folders in the
 * home folder, never its dotfiles or app folders.
 */
export function claudeFilesystem(input: {
  access: OutsideAccess;
  home: string;
  writable: string[];
  closed: string[];
  /** Names in the home folder (read and write only). */
  homeEntries?: string[];
  /** Toolchains under the home folder that commands still need to read (no access only). */
  toolchain?: string[];
}): ClaudeFilesystem {
  if (input.access === "none") {
    // Claude Code sources its shell snapshot from its own folder before each command.
    const allowRead = [...input.writable, ...(input.toolchain ?? []), join(input.home, ".claude", "shell-snapshots")];
    return { allowWrite: input.writable, denyRead: [input.home, ...input.closed], allowRead };
  }
  if (input.access === "read") return { allowWrite: input.writable, denyRead: input.closed };
  const own = (input.homeEntries ?? []).filter((name) => !name.startsWith(".") && !HOME_APP_FOLDERS.has(name)).map((name) => join(input.home, name));
  return { allowWrite: [...input.writable, ...own], denyWrite: input.closed, denyRead: input.closed };
}

/** Folders in the home folder that belong to apps, not to the person's work. */
const HOME_APP_FOLDERS = new Set(["Library", "AppData", "Applications", "snap"]);

/** The per-run settings: the hook on every tool call, and the sandbox and internet the run asked for. */
export function claudeSettings(input: { hookCommand: string; sandboxed: boolean; network: boolean; filesystem: ClaudeFilesystem }): Record<string, unknown> {
  return {
    hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: input.hookCommand, timeout: 86_400 }] }] },
    sandbox: input.sandboxed
      ? {
          enabled: true,
          failIfUnavailable: true,
          allowUnsandboxedCommands: false,
          // Ensemble's hook decides every command first; the sandbox is the floor under it.
          autoAllowBashIfSandboxed: true,
          // Claude Code's sandbox reads broadly by default: keys, browser data and Ensemble's own data stay closed.
          filesystem: input.filesystem,
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
  options: { prompt: string; model?: string | null; effort?: string | null; maxTurns: number; stopCheck: () => Promise<void>; resume?: string | null; chat?: boolean; trace?: EngineTrace },
): Promise<EngineResult> {
  // The `claude` command, else the Claude Code the Claude app keeps for its Code tab (subscriptions/detect.ts).
  const found = await claudeBinary();
  if (!found) throw new Error("Claude Code is not on this computer: neither the Claude app nor the `claude` command was found. Install the Claude app and sign in, or pick another engine.");
  const claude = found.path;
  const credential = registerEngineRun(ctx);
  const hookCommand = `"${process.execPath}" "${hookScriptPath()}" --source claude --engine`;
  const home = homedir();
  const closed = [...SECRET_HOME_PATHS.map((name) => join(home, name)), desktopDataDir({ platform: process.platform, home }), ENSEMBLE_SOURCE, dirname(await askpassPath())];
  const access = ctx.outsideAccess ?? "none";
  const filesystem = claudeFilesystem({
    access,
    home,
    writable: [ctx.root, await cacheDir()],
    closed,
    homeEntries: access === "read-write" ? await readdir(home).catch(() => []) : [],
    toolchain: (process.platform === "darwin" ? TOOLCHAIN_HOME_READS : process.platform === "linux" ? LINUX_TOOLCHAIN_HOME : []).map((name) => join(home, name)),
  });
  const settings = claudeSettings({ hookCommand, sandboxed: ctx.sandboxed, network: ctx.network, filesystem });
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
    ...(options.effort ? ["--effort", options.effort] : []),
    // The next message in a chat: the same Claude Code session, so it remembers the conversation.
    ...(options.resume ? ["--resume", options.resume] : []),
  ];
  // A question may wait hours for the person; the tool call must not time out first.
  const env: NodeJS.ProcessEnv = { ...process.env, ...mcpEnv(credential, options.chat === true), MCP_TOOL_TIMEOUT: String(86_400_000) };
  for (const key of KEY_VARIABLES) delete env[key];
  delete env.ENSEMBLE_DESKTOP_TOKEN;
  delete env.ENSEMBLE_INTERNAL_TOKEN;
  const child = spawn(claude, args, { cwd: ctx.root, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
  // The caller may hold the trace, to close it if the run stops before the engine returns.
  const trace = options.trace ?? new EngineTrace(ctx, "claude-code");
  const result: EngineResult = { text: "", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0, model: null, costUsd: null, trace };
  let failure: string | null = null;
  let started = false;
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
      touchLive(ctx.job.id);
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        appendLive(ctx.job.id, `${line}\n`);
        continue;
      }
      if (message.type === "system" && message.subtype === "init") {
        started = true;
        result.model = typeof message.model === "string" ? message.model : null;
        await ctx.event("engine", { engine: "claude-code", model: result.model, session: message.session_id ?? null });
        await ctx.progress(`Claude Code started${result.model ? ` (${result.model})` : ""}`);
      } else if (message.type === "assistant") {
        const body = (message.message ?? {}) as { content?: Array<Record<string, unknown>>; usage?: Record<string, number>; model?: string };
        const usage = body.usage ?? {};
        const totals = {
          model: typeof body.model === "string" ? body.model : result.model,
          tokensIn: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) || null,
          tokensOut: usage.output_tokens ?? null,
        };
        for (const part of body.content ?? []) {
          if (part.type === "thinking" && typeof part.thinking === "string") {
            await trace.thinking(part.thinking);
          } else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
            appendLive(ctx.job.id, `${part.text.trim()}\n`);
            await ctx.progress(part.text.trim().split("\n")[0]!.slice(0, 160));
            await trace.message(part.text, totals);
          } else if (part.type === "tool_use") {
            result.toolCalls += 1;
            const summary = summarize(String(part.name ?? "tool"), (part.input ?? {}) as Record<string, unknown>);
            appendLive(ctx.job.id, `· ${summary}\n`);
            await ctx.event("tool", { name: part.name, ok: true, summary, engine: "claude-code" });
            await trace.toolStart(String(part.id ?? ""), String(part.name ?? "tool"), part.input ?? {}, summary);
          }
        }
        await options.stopCheck();
      } else if (message.type === "user") {
        // Tool results come back as the "user" turn: what each call returned, and whether it failed.
        const body = (message.message ?? {}) as { content?: Array<Record<string, unknown>> | string };
        for (const part of Array.isArray(body.content) ? body.content : []) {
          if (part.type !== "tool_result") continue;
          const content = Array.isArray(part.content)
            ? (part.content as Array<Record<string, unknown>>).map((piece) => (typeof piece.text === "string" ? piece.text : piece.type === "image" ? "[image]" : "")).join("\n")
            : part.content;
          await trace.toolEnd(String(part.tool_use_id ?? ""), content, part.is_error !== true);
        }
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
    if (code !== 0 && options.resume && !started && /no conversation found|session/i.test(stderr)) throw new SessionGoneError(stderr.trim().slice(0, 300));
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
