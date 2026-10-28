/**
 * Grok Build, OpenCode, Gemini CLI and Google Antigravity as the run's engine: each is the person's
 * own agent, signed in with their own account, driven through ACP (the Agent Client Protocol,
 * JSON-RPC lines over stdio) by this one runner. Each agent's launch is in `ACP_AGENTS`: the
 * program, its ACP arguments with its own permission prompts on (so every edit, command and fetch
 * reaches Ensemble), the variables that must not stand in for its sign-in, and how it signs in.
 *
 * Every `session/request_permission` is read as a tool call and judged by the run's rules
 * (`judge.ts`), answered allow-once or reject-once, never "always" (that would change the person's
 * own allowlist, and for Grok and OpenCode it is project-wide). Refusals go back as the next
 * message, as for Copilot. The model and thinking level are the agent's own session options
 * (`session/set_config_option`). Questions go through Ensemble's `ask_person` MCP tool.
 *
 * Launch details follow T3 Code's drivers (`packages/provider-grok`, `provider-opencode`,
 * `apps/server/src/provider/acp` in pingdotgg/t3code, MIT License, Copyright (c) 2026 T3 Tools Inc.).
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { ENGINE_LABELS, type AcpEngine } from "@ensemble/shared-types";
import { antigravityArgs, antigravityAuthLink, antigravityEnv, antigravityInstalled } from "../../subscriptions/antigravity.js";
import { agentEnv, quickRun } from "../../subscriptions/detect.js";
import { GuardError } from "../guard.js";
import { appendLive, touchLive } from "../live-log.js";
import { hostExecutable } from "../policy.js";
import type { JobContext } from "../tools.js";
import type { EngineResult } from "./claude-code.js";
import { refusalMessage, REFUSAL_FOLLOW_UPS, type Refusal } from "./copilot.js";
import { judgeEngineCall, type EngineAnswer, type EngineCall } from "./judge.js";
import { engineTrust, EngineTransientError, hookScriptPath, mcpEnv, registerEngineRun, SessionGoneError, SIGNED_OUT, UNREACHABLE, unregisterEngineRun } from "./registry.js";
import { RpcConnection } from "./rpc.js";
import { EngineTrace } from "./trace.js";

export type AcpLaunch = {
  program: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** `authenticate` with this method before the first session (the login the agent already has). */
  authMethod?: string;
  initializeMeta?: Record<string, unknown>;
  /** How the agent reopens a session: `session/load`, or Antigravity's `session/resume`. */
  resume: "session/load" | "session/resume";
  /** The session mode in which the agent asks before acting, set when it starts in another. */
  askingMode?: string;
};

export type AcpLaunchInput = {
  /** The folder the agent works in. */
  root: string;
  sandboxed: boolean;
  /** The person trusted this very folder: the agent may load its own project settings there. */
  trusted: boolean;
  model?: string | null;
  /** Variables for Ensemble's MCP server and the run. */
  extraEnv?: Record<string, string>;
};

export type AcpAgent = {
  id: AcpEngine;
  /** The trace and event name. */
  trace: string;
  install: string;
  login: string;
  /** Arguments that turn on the agent's own OS sandbox here, or null when it has none Ensemble can use. */
  sandbox: (platform: NodeJS.Platform) => string[] | null;
  /** How to start it, or null when it is not on this computer. */
  launch: (input: AcpLaunchInput) => Promise<AcpLaunch | null>;
};

/**
 * OpenCode asks before everything that is not a plain read (`OPENCODE_PERMISSION` comes last and
 * wins over the person's and the repository's settings), so each edit, command, fetch and outside
 * path reaches Ensemble's judge. Reads, searches and its own bookkeeping go ahead.
 */
export const OPENCODE_PERMISSIONS = {
  "*": "ask",
  read: { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" },
  glob: "allow",
  grep: "allow",
  list: "allow",
  lsp: "allow",
  todowrite: "allow",
  todoread: "allow",
  skill: "allow",
  question: "allow",
  bash: "ask",
  edit: "ask",
  webfetch: "ask",
  websearch: "ask",
  codesearch: "ask",
  external_directory: "ask",
  task: "ask",
  doom_loop: "ask",
} as const;

const geminiFlag = new Map<string, string>();
/** `--acp`, or `--experimental-acp` on a Gemini CLI from before it was renamed. */
async function geminiAcpFlag(program: string): Promise<string> {
  const known = geminiFlag.get(program);
  if (known) return known;
  const help = await quickRun(program, ["--help"], 15_000);
  const flag = /--acp\b/.test(help.stdout) || !/--experimental-acp\b/.test(help.stdout) ? "--acp" : "--experimental-acp";
  geminiFlag.set(program, flag);
  return flag;
}

const onPath = (name: string) => hostExecutable(name).catch(() => null);

export const ACP_AGENTS: Record<AcpEngine, AcpAgent> = {
  "grok-cli": {
    id: "grok-cli",
    trace: "grok",
    install: "Install Grok Build (https://x.ai/cli), run `grok login`, and Run again.",
    login: "Run `grok login` there (or press Sign in under Settings → Models), then Run again.",
    sandbox: () => null,
    launch: async (input) => {
      const program = await onPath("grok");
      if (!program) return null;
      // `--permission-mode default` on the command line wins over a saved always-approve.
      return { program, args: ["--permission-mode", "default", "agent", "stdio"], env: agentEnv(input.extraEnv), authMethod: "cached_token", initializeMeta: { clientType: "extension" }, resume: "session/load" };
    },
  },
  opencode: {
    id: "opencode",
    trace: "opencode",
    install: "Install OpenCode (https://opencode.ai/download), run `opencode auth login`, and Run again.",
    login: "Run `opencode auth login` there (or press Sign in under Settings → Models), then Run again.",
    sandbox: () => null,
    launch: async (input) => {
      const program = await onPath("opencode");
      if (!program) return null;
      // Both ways OpenCode reads inline settings, so an older OpenCode without OPENCODE_PERMISSION still asks.
      const env = agentEnv({
        ...input.extraEnv,
        OPENCODE_PERMISSION: JSON.stringify(OPENCODE_PERMISSIONS),
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: OPENCODE_PERMISSIONS }),
        OPENCODE_DISABLE_AUTOUPDATE: "true",
      });
      // A repository's own opencode.json, agents and plugins load only in a folder the person trusted.
      if (!input.trusted) env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
      return { program, args: ["acp"], env, resume: "session/load" };
    },
  },
  "gemini-cli": {
    id: "gemini-cli",
    trace: "gemini",
    install: "Install Gemini CLI (npm install -g @google/gemini-cli), sign in with Google by running `gemini` once, and Run again.",
    login: "Run `gemini` there and choose Sign in with Google (or press Sign in under Settings → Models), then Run again.",
    // Gemini CLI's own sandbox is Seatbelt on macOS; elsewhere it needs Docker or Podman.
    sandbox: (platform) => (platform === "darwin" ? ["--sandbox"] : null),
    launch: async (input) => {
      const program = await onPath("gemini");
      if (!program) return null;
      const model = input.model && input.model !== "default" ? ["--model", input.model] : [];
      const sandbox = input.sandboxed ? (ACP_AGENTS["gemini-cli"].sandbox(process.platform) ?? []) : [];
      return { program, args: [await geminiAcpFlag(program), "--approval-mode", "default", ...sandbox, ...model], env: agentEnv(input.extraEnv), resume: "session/load" };
    },
  },
  antigravity: {
    id: "antigravity",
    trace: "antigravity",
    install: "Antigravity's agent is not installed on this computer. Press Sign in for Antigravity under Settings → Models: Ensemble installs it and opens Google's sign-in.",
    login: "Press Sign in for Antigravity under Settings → Models on that computer: Google's sign-in page opens in the browser. Then Run again.",
    sandbox: () => null,
    launch: async (input) => {
      const install = antigravityInstalled();
      if (!install) return null;
      return { program: install.executable, args: antigravityArgs(), env: antigravityEnv(install, input.extraEnv), authMethod: "oauth-personal", resume: "session/resume", askingMode: "default" };
    },
  },
};

type ToolCall = { toolCallId?: string; title?: string; kind?: string; locations?: Array<{ path?: string }>; content?: Array<{ type?: string; path?: string }>; rawInput?: unknown };
type Option = { optionId: string; kind?: string; name?: string };
type ConfigChoice = { value?: string; name?: string; options?: ConfigChoice[] };
export type ConfigOption = { id?: string; name?: string; category?: string; type?: string; currentValue?: string; options?: ConfigChoice[] };

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/**
 * An ACP tool call in the judge's terms, one call per path it touches. Agents name things their own
 * way: a command in `rawInput.command` (a string or argv) or a backticked title, a path in
 * `locations`, a diff's `path` or `rawInput` (`path`, `file_path`, `filePath`, `absolute_path`),
 * and an MCP tool as `server: tool`, `server-tool` or `mcp__server__tool`.
 */
export function acpCalls(toolCall: ToolCall, announced?: string | null): EngineCall[] {
  const raw = record(toolCall.rawInput);
  const title = str(toolCall.title) ?? "";
  const quoted = /`((?:[^`\\]|\\.)*)`/.exec(title)?.[1]?.replace(/\\`/g, "`") ?? null;
  const pathsFrom = (...extra: Array<string | null>) => [
    ...new Set(
      [
        ...(toolCall.locations ?? []).map((location) => str(location.path)),
        ...(toolCall.content ?? []).filter((part) => part.type === "diff").map((part) => str(part.path)),
        str(raw.path),
        str(raw.file_path),
        str(raw.filePath),
        str(raw.fileName),
        str(raw.absolute_path),
        ...extra,
      ].filter((path): path is string => Boolean(path)),
    ),
  ];
  switch (toolCall.kind) {
    case "execute": {
      const argv = Array.isArray(raw.command) ? raw.command.filter((item): item is string => typeof item === "string") : [];
      const commands = Array.isArray(raw.commands) ? raw.commands.filter((item): item is string => typeof item === "string") : [];
      const command = str(raw.command) ?? (argv.length ? argv.join(" ") : commands.length ? commands.join(" && ") : (quoted ?? title));
      return [{ tool: "Bash", input: { command } }];
    }
    case "edit":
    case "delete":
    case "move": {
      const paths = pathsFrom(quoted);
      return paths.length ? paths.map((path) => ({ tool: "Write", input: { file_path: path } })) : [{ tool: "Write", input: {} }];
    }
    case "read":
    case "search": {
      const paths = pathsFrom();
      return paths.length ? paths.map((path) => ({ tool: "Read", input: { file_path: path } })) : [{ tool: "Read", input: {} }];
    }
    case "fetch":
      return [{ tool: "WebFetch", input: { url: str(raw.url) ?? quoted ?? title } }];
    default: {
      const name = str(announced) ?? (title || "tool");
      if (/^mcp__/.test(name)) return [{ tool: name, input: raw }];
      const pair = /^([\w.-]+)\s*(?::|\/)\s*(.+)$/.exec(name) ?? /^(ensemble)[-_](.+)$/.exec(name);
      if (pair) return [{ tool: `mcp__${pair[1]!.trim()}__${pair[2]!.trim()}`, input: raw }];
      return [{ tool: name, input: raw }];
    }
  }
}

/** The option the agent offered for once: allow-once on yes, reject-once on no. */
export function pickOption(options: Option[], allow: boolean): string | null {
  const wanted = allow ? "allow_once" : "reject_once";
  return options.find((option) => option.kind === wanted)?.optionId ?? options.find((option) => option.optionId.replace(/-/g, "_") === wanted)?.optionId ?? null;
}

/** A permission request from the agent, answered by the run's rules (and the person, when they must decide). */
export async function answerAcp(
  ctx: JobContext,
  engine: string,
  params: Record<string, unknown>,
  announced: Map<string, string>,
  refusals: Refusal[],
  judge: typeof judgeEngineCall = judgeEngineCall,
): Promise<unknown> {
  const options = (Array.isArray(params.options) ? params.options : []) as Option[];
  const toolCall = record(params.toolCall) as ToolCall;
  let verdict: EngineAnswer = { decision: "allow" };
  for (const call of acpCalls(toolCall, toolCall.toolCallId ? announced.get(toolCall.toolCallId) : null)) {
    verdict = await judge(ctx, call);
    if (verdict.decision !== "allow") {
      const reason = verdict.message ?? "Not allowed in this run.";
      refusals.push({ tool: call.tool === "Bash" ? `the command \`${String(call.input.command ?? "").slice(0, 200)}\`` : `${call.tool} ${String(call.input.file_path ?? call.input.url ?? "")}`.trim(), reason });
      await ctx.event("tool", { name: call.tool, ok: false, summary: reason, engine });
      break;
    }
  }
  const optionId = pickOption(options, verdict.decision === "allow");
  return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
}

const flatChoices = (choices: ConfigChoice[] | undefined): ConfigChoice[] => (choices ?? []).flatMap((choice) => (Array.isArray(choice.options) ? choice.options : [choice]));
const THOUGHT_IDS = new Set(["reasoning_effort", "thought_level", "effort", "thinking", "variant"]);

/** The agent's model option and thinking option among its session options. */
export function configChoices(config: ConfigOption[]): { model: ConfigOption | null; thought: ConfigOption | null } {
  return {
    model: config.find((option) => option.category === "model") ?? config.find((option) => option.id === "model") ?? null,
    thought: config.find((option) => option.category === "thought_level") ?? config.find((option) => THOUGHT_IDS.has(option.id ?? "")) ?? null,
  };
}

export function optionValues(option: ConfigOption | null): string[] {
  return flatChoices(option?.options).map((choice) => choice.value).filter((value): value is string => typeof value === "string");
}

export function stopProcess(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

export async function runAcp(
  ctx: JobContext,
  id: AcpEngine,
  options: { prompt: string; model?: string | null; effort?: string | null; stopCheck: () => Promise<void>; resume?: string | null; chat?: boolean; trace?: EngineTrace },
): Promise<EngineResult> {
  const agent = ACP_AGENTS[id];
  const label = ENGINE_LABELS[id];
  if (ctx.sandboxed && !agent.sandbox(process.platform)) {
    throw new GuardError(
      `${label} has no OS sandbox Ensemble can turn on here. Turn the sandbox off for this run: Ensemble still judges every command, edit, outside read and fetch ${label} asks to make.`,
    );
  }
  const credential = registerEngineRun(ctx);
  const ensembleMcp = mcpEnv(credential, options.chat === true);
  const model = str(options.model) && options.model !== "default" ? options.model!.trim() : null;
  const launch = await agent.launch({ root: ctx.root, sandboxed: ctx.sandboxed, trusted: engineTrust(ctx), model, extraEnv: { ...ctx.secretEnv, ...ensembleMcp } });
  if (!launch) {
    unregisterEngineRun(ctx.job.id);
    throw new Error(`${label} is not on this computer. ${agent.install}`);
  }
  const child: ChildProcessWithoutNullStreams = spawn(launch.program, launch.args, { cwd: ctx.root, env: launch.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
  child.stdin.on("error", () => undefined);
  const rpc = new RpcConnection((line) => child.stdin.writable && void child.stdin.write(line), { jsonrpc: true });
  const trace = options.trace ?? new EngineTrace(ctx, agent.trace);
  const result: EngineResult = { text: "", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0, model, costUsd: null, trace };
  let thought = "";
  const flushThought = async () => {
    if (!thought.trim()) return;
    const text = thought;
    thought = "";
    await trace.thinking(text);
  };
  let reply = "";
  let stderr = "";
  let sessionId: string | null = null;
  let replaying = false;
  let signInLink = false;
  const usage: { window: { used: number; size: number } | null } = { window: null };
  const announced = new Map<string, string>();
  const refusals: Refusal[] = [];
  rpc.onRequest = async (method, params) => {
    if (method === "session/request_permission") return answerAcp(ctx, agent.trace, params, announced, refusals);
    throw Object.assign(new Error(`${method} is not handled by Ensemble.`), { code: -32601 });
  };
  rpc.onNotification = (method, params) => {
    if (method !== "session/update" || replaying) return;
    const update = (params.update ?? {}) as {
      sessionUpdate?: string;
      content?: { type?: string; text?: string } | Array<{ type?: string; content?: { type?: string; text?: string } }>;
      title?: string;
      kind?: string;
      toolCallId?: string;
      status?: string;
      rawInput?: unknown;
      rawOutput?: unknown;
      used?: number;
      size?: number;
    };
    const single = Array.isArray(update.content) ? undefined : update.content;
    if (update.sessionUpdate === "tool_call" && update.toolCallId && update.title) announced.set(update.toolCallId, update.title);
    if (update.sessionUpdate === "usage_update" && typeof update.used === "number" && typeof update.size === "number") usage.window = { used: update.used, size: update.size };
    if (update.sessionUpdate === "agent_message_chunk" && single?.type === "text" && single.text) reply += single.text;
    void (async () => {
      if (update.sessionUpdate === "agent_message_chunk" && single?.type === "text" && single.text) {
        await flushThought();
        appendLive(ctx.job.id, single.text);
      } else if (update.sessionUpdate === "agent_thought_chunk" && single?.type === "text" && single.text) {
        thought += single.text;
      } else if (update.sessionUpdate === "tool_call") {
        const flushed = flushThought();
        result.toolCalls += 1;
        const summary = (update.title ?? update.kind ?? "tool").slice(0, 160);
        const started = trace.toolStart(update.toolCallId ?? "", update.kind ?? "tool", update.rawInput ?? {}, summary);
        appendLive(ctx.job.id, `\n· ${summary}\n`);
        await ctx.event("tool", { name: update.kind ?? "tool", ok: true, summary, engine: agent.trace });
        await ctx.progress(summary);
        await Promise.all([flushed, started]);
      } else if (update.sessionUpdate === "tool_call_update" && (update.status === "completed" || update.status === "failed")) {
        const text = Array.isArray(update.content) ? update.content.map((part) => part.content?.text ?? "").filter(Boolean).join("\n") : "";
        await trace.toolEnd(update.toolCallId ?? "", update.rawOutput ?? text, update.status === "completed");
      }
    })().catch(() => undefined);
  };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    touchLive(ctx.job.id);
    // Antigravity prints its Google sign-in link on stdout when it has no sign-in.
    if (antigravityAuthLink(line)) {
      signInLink = true;
      rpc.close(`${label} is not signed in on this computer.`);
      return;
    }
    void rpc.receive(line);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    if (antigravityAuthLink(stderr)) signInLink = true;
  });
  const exited = new Promise<number>((resolve) => child.once("close", (code) => resolve(code ?? 1)));
  void exited.then(() => rpc.close(`${label} stopped. ${stderr.trim().split("\n").slice(-3).join(" | ")}`.trim()));
  const stop = () => {
    if (sessionId) rpc.notify("session/cancel", { sessionId });
    setTimeout(() => stopProcess(child), 3000).unref();
  };
  ctx.signal.addEventListener("abort", stop, { once: true });
  const failed = (error: Error): never => {
    if (signInLink || SIGNED_OUT.test(error.message)) throw new Error(`${label} is not signed in on this computer. ${agent.login}`);
    if (UNREACHABLE.test(error.message)) throw new EngineTransientError(`${label} could not reach its servers: ${error.message.slice(0, 200)}`);
    throw error;
  };
  try {
    await rpc
      .request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "ensemble", version: "1" },
        ...(launch.initializeMeta ? { _meta: launch.initializeMeta } : {}),
      })
      .catch(failed);
    // The sign-in the person already made with the agent's own login; Ensemble never sees it.
    if (launch.authMethod) await rpc.request("authenticate", { methodId: launch.authMethod }).catch(failed);
    const mcpServers = [{ name: "ensemble", command: process.execPath, args: [hookScriptPath("ensemble-ask-mcp.mjs")], env: Object.entries(ensembleMcp).map(([name, value]) => ({ name, value })) }];
    let session: Record<string, unknown>;
    if (options.resume) {
      replaying = true;
      session = await rpc
        .request(launch.resume, { sessionId: options.resume, cwd: ctx.root, mcpServers })
        .then((loaded) => ({ ...loaded, sessionId: options.resume }))
        .catch((error: Error) => {
          if (signInLink || SIGNED_OUT.test(error.message) || UNREACHABLE.test(error.message)) failed(error);
          throw new SessionGoneError(`${label} could not reopen the session: ${error.message}`);
        })
        .finally(() => {
          replaying = false;
        });
    } else {
      session = await rpc.request("session/new", { cwd: ctx.root, mcpServers }).catch(failed);
    }
    sessionId = typeof session.sessionId === "string" ? session.sessionId : null;
    if (!sessionId) throw new Error(`${label} did not start a session.`);
    // Antigravity can start in a mode that acts without asking: back to the one that asks.
    const modes = record(session.modes) as { currentModeId?: string; availableModes?: Array<{ id?: string }> };
    if (launch.askingMode && modes.currentModeId && modes.currentModeId !== launch.askingMode) {
      if (!(modes.availableModes ?? []).some((mode) => mode.id === launch.askingMode)) throw new Error(`${label} cannot be set to ask before it acts, so Ensemble did not start it.`);
      await rpc.request("session/set_mode", { sessionId, modeId: launch.askingMode });
    }
    // Model and thinking level are the agent's own session options.
    let config = Array.isArray(session.configOptions) ? (session.configOptions as ConfigOption[]) : [];
    const legacy = record(session.models) as { availableModels?: Array<{ modelId?: string }>; currentModelId?: string };
    const choices = configChoices(config);
    const currentModel = choices.model?.currentValue ?? legacy.currentModelId ?? null;
    if (model && model !== currentModel) {
      if (choices.model && optionValues(choices.model).includes(model)) {
        const answer = (await rpc.request("session/set_config_option", { sessionId, configId: choices.model.id, value: model })) as { configOptions?: ConfigOption[] };
        if (Array.isArray(answer.configOptions)) config = answer.configOptions;
      } else if ((legacy.availableModels ?? []).some((row) => row.modelId === model)) {
        await rpc.request("session/set_model", { sessionId, modelId: model });
      } else if (choices.model || legacy.availableModels?.length) {
        throw new Error(`${label} does not offer ${model} on this account. Pick another model.`);
      }
    }
    result.model = model ?? currentModel;
    const effort = str(options.effort) && options.effort !== "default" ? options.effort!.trim() : null;
    if (effort) {
      const thought = configChoices(config).thought;
      if (thought && optionValues(thought).includes(effort)) {
        if (thought.currentValue !== effort) await rpc.request("session/set_config_option", { sessionId, configId: thought.id, value: effort });
      } else {
        await ctx.event("engine_note", { note: `${result.model ?? label} has no ${effort} thinking level in ${label}; it runs at its default.` });
      }
    }
    await ctx.event("engine", { engine: agent.trace, model: result.model, effort, session: sessionId });
    await ctx.progress(`${label} started`);
    let prompt: Array<Record<string, unknown>> = [{ type: "text", text: options.prompt }];
    for (let round = 0; ; round += 1) {
      refusals.length = 0;
      const done = (await rpc.request("session/prompt", { sessionId, prompt })) as { stopReason?: string; usage?: { inputTokens?: number; outputTokens?: number } };
      result.turns += 1;
      result.tokensIn += done.usage?.inputTokens ?? 0;
      result.tokensOut += done.usage?.outputTokens ?? 0;
      await options.stopCheck();
      if (ctx.signal.aborted || done.stopReason === "cancelled") throw new DOMException("Stopped", "AbortError");
      if (done.stopReason === "refusal") throw new Error(`${label} refused the task.`);
      if (!refusals.length || round >= REFUSAL_FOLLOW_UPS) break;
      reply += "\n";
      prompt = [{ type: "text", text: refusalMessage(refusals) }];
    }
    if (usage.window) await ctx.event("engine_context", { used: usage.window.used, size: usage.window.size });
    await flushThought();
    result.text = reply.trim();
    return result;
  } catch (error) {
    if (ctx.signal.aborted) throw new DOMException("Stopped", "AbortError");
    throw error;
  } finally {
    ctx.signal.removeEventListener("abort", stop);
    unregisterEngineRun(ctx.job.id);
    lines.close();
    if (child.exitCode === null) {
      child.stdin.end();
      setTimeout(() => stopProcess(child), 2000).unref();
    }
  }
}
