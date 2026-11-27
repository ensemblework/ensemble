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
 * (`session/set_config_option`). Questions go through Ensemble's `ask_person` MCP tool, and an
 * agent's own form questions (`elicitation/create`) reach the person the same way (elicitation.ts).
 * None of these agents takes a name for a session, so a new task's session leads with the task's
 * title alone on its first line (app-sessions.ts). The history an agent replays as it reopens a
 * session (`session/load`) is kept apart from the run's work and handed to the run (`onReplay`):
 * what the person said in the agent's own app since Ensemble's last run there leads the prompt.
 *
 * Launch details follow T3 Code's drivers (`packages/provider-grok`, `provider-opencode`,
 * `apps/server/src/provider/acp` in pingdotgg/t3code, MIT License, Copyright (c) 2026 T3 Tools Inc.).
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ENGINE_LABELS, type AcpEngine } from "@ensemble/shared-types";
import { homeVariables, linkSignIn } from "../../subscriptions/agent-mcp.js";
import { opencodeProgram } from "../../subscriptions/agent-apps.js";
import { antigravityArgs, antigravityAuthLink, antigravityEnv, antigravityInstalled } from "../../subscriptions/antigravity.js";
import { agentEnv, quickRun } from "../../subscriptions/detect.js";
import { acpPrompts, acpTurns, MAX_REPLAYED, type OutsideTurn } from "../../subscriptions/outside.js";
import { GuardError } from "../guard.js";
import { appendLive, touchLive } from "../live-log.js";
import { withPrompts, type ReplayHook } from "../outside-runs.js";
import { hostLaunch, type HostLaunch } from "../policy.js";
import type { JobContext } from "../tools.js";
import { titledPrompt } from "./app-sessions.js";
import type { EngineResult } from "./claude-code.js";
import { refusalMessage, REFUSAL_FOLLOW_UPS, type Refusal } from "./copilot.js";
import { ACP_CLIENT_CAPABILITIES, answerElicitation } from "./elicitation.js";
import { judgeEngineCall, patchPaths, type EngineAnswer, type EngineCall } from "./judge.js";
import { engineStarted, engineTrust, EngineTransientError, hookScriptPath, mcpEnv, registerEngineRun, SessionGoneError, SIGNED_OUT, UNREACHABLE, unregisterEngineRun } from "./registry.js";
import { RpcConnection } from "./rpc.js";
import { EngineTrace } from "./trace.js";

export type AcpLaunch = {
  program: string;
  args: string[];
  /** What starts the program itself, before its own arguments: [] , or an npm shim's script on Windows. */
  base: string[];
  env: NodeJS.ProcessEnv;
  /** `authenticate` with this method before the first session (the login the agent already has). */
  authMethod?: string;
  initializeMeta?: Record<string, unknown>;
  /** How the agent reopens a session: `session/load`, or Antigravity's `session/resume`. */
  resume: "session/load" | "session/resume";
  /** The session mode in which the agent asks before acting, set when it starts in another. */
  askingMode?: string;
  /** The person's own MCP servers are left out, as `ensembleMcpOnly` or `othersHome` asked (agent-mcp.ts). */
  ownMcpOff?: boolean;
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
  /**
   * Only Ensemble's MCP server, none of the person's own (an assistant turn with Ensemble's tools only, or a node's):
   * Gemini CLI and Qwen Code take `--allowed-mcp-server-names` for it; the other agents have no such switch.
   */
  ensembleMcpOnly?: boolean;
  /**
   * A turn someone other than the person can steer: none of the person's own MCP servers on any agent. Those without
   * a switch for it run with this folder of Ensemble's as their home (agent-mcp.ts `othersHome`), with none of the
   * person's settings there and their sign-in reached in place.
   */
  othersHome?: string;
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

const geminiHelp = new Map<string, Promise<string>>();
/** A Gemini CLI's (or Qwen Code's, built from it) help, read once per program. */
function geminiHelpText(found: HostLaunch): Promise<string> {
  const key = [found.program, ...found.args].join("\u0000");
  let known = geminiHelp.get(key);
  if (!known) {
    known = quickRun(found.program, [...found.args, "--help"], 15_000).then((help) => help.stdout);
    geminiHelp.set(key, known);
  }
  return known;
}

/** `--acp`, or `--experimental-acp` on a Gemini CLI (or Qwen Code) from before it was renamed. */
async function geminiAcpFlag(found: HostLaunch): Promise<string> {
  const help = await geminiHelpText(found);
  return /--acp\b/.test(help) || !/--experimental-acp\b/.test(help) ? "--acp" : "--experimental-acp";
}

/** Only Ensemble's MCP server, where the turn asks for that and this Gemini CLI (or Qwen Code) takes the flag. */
async function geminiMcpOnly(found: HostLaunch, input: AcpLaunchInput): Promise<string[]> {
  return (input.ensembleMcpOnly || input.othersHome) && /--allowed-mcp-server-names\b/.test(await geminiHelpText(found)) ? ["--allowed-mcp-server-names", "ensemble"] : [];
}

/** The agent's program on the trusted PATH (an npm shim on Windows as Node and its script), or null. */
const onPath = (name: string) => hostLaunch(name).catch(() => null);

export const ACP_AGENTS: Record<AcpEngine, AcpAgent> = {
  "grok-cli": {
    id: "grok-cli",
    trace: "grok",
    install: "Install Grok Build (https://x.ai/cli), run `grok login`, and Run again.",
    login: "Run `grok login` there (or press Sign in under Settings → Models), then Run again.",
    sandbox: () => null,
    launch: async (input) => {
      const found = await onPath("grok");
      if (!found) return null;
      const env = agentEnv(input.extraEnv);
      // Grok reads its settings, plugins and trusted folders from its home, and Cursor's and Claude Code's MCP servers from
      // the home folder: both are Ensemble's for a turn someone else can steer, signed in with the person's own file.
      if (input.othersHome) {
        const auth = env.GROK_AUTH_PATH?.trim() || join(env.GROK_HOME?.trim() || join(homedir(), ".grok"), "auth.json");
        Object.assign(env, homeVariables(input.othersHome), { GROK_HOME: join(input.othersHome, ".grok"), GROK_AUTH_PATH: auth });
      }
      // `--permission-mode default` on the command line wins over a saved always-approve.
      return { program: found.program, base: found.args, args: [...found.args, "--permission-mode", "default", "agent", "stdio"], env, authMethod: "cached_token", initializeMeta: { clientType: "extension" }, resume: "session/load", ownMcpOff: Boolean(input.othersHome) };
    },
  },
  opencode: {
    id: "opencode",
    trace: "opencode",
    install: "Install OpenCode (https://opencode.ai/download), run `opencode auth login`, and Run again.",
    login: "Run `opencode auth login` there (or press Sign in under Settings → Models), then Run again.",
    sandbox: () => null,
    launch: async (input) => {
      // Also where OpenCode's installer puts it, or the copy the OpenCode app runs itself.
      const found = await opencodeProgram({}, onPath);
      if (!found) return null;
      // Both ways OpenCode reads inline settings, so an older OpenCode without OPENCODE_PERMISSION still asks.
      const env = agentEnv({
        ...input.extraEnv,
        OPENCODE_PERMISSION: JSON.stringify(OPENCODE_PERMISSIONS),
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: OPENCODE_PERMISSIONS }),
        OPENCODE_DISABLE_AUTOUPDATE: "true",
      });
      // A repository's own opencode.json, agents and plugins load only in a folder the person trusted.
      if (!input.trusted) env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
      // A turn someone else can steer: OpenCode's settings (its global folder, `~/.opencode`, Claude Code's) come from
      // Ensemble's home for it; its sign-ins and sessions stay in the person's data folder.
      if (input.othersHome) {
        const data = env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
        delete env.OPENCODE_CONFIG;
        Object.assign(env, homeVariables(input.othersHome), { XDG_CONFIG_HOME: join(input.othersHome, ".config"), OPENCODE_CONFIG_DIR: join(input.othersHome, ".config", "opencode"), XDG_DATA_HOME: data, OPENCODE_DISABLE_CLAUDE_CODE: "true" });
      }
      return { program: found.program, base: found.args, args: [...found.args, "acp"], env, resume: "session/load", ownMcpOff: Boolean(input.othersHome) };
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
      const found = await onPath("gemini");
      if (!found) return null;
      const model = input.model && input.model !== "default" ? ["--model", input.model] : [];
      const sandbox = input.sandboxed ? (ACP_AGENTS["gemini-cli"].sandbox(process.platform) ?? []) : [];
      const only = await geminiMcpOnly(found, input);
      return { program: found.program, base: found.args, args: [...found.args, await geminiAcpFlag(found), "--approval-mode", "default", ...sandbox, ...model, ...only], env: agentEnv(input.extraEnv), resume: "session/load", ownMcpOff: only.length > 0 };
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
      // Its home is always Ensemble's own (antigravity.ts), which holds no MCP server of the person's.
      return { program: install.executable, base: [], args: antigravityArgs(), env: antigravityEnv(install, input.extraEnv), authMethod: "oauth-personal", resume: "session/resume", askingMode: "default", ownMcpOff: true };
    },
  },
  "mistral-vibe": {
    id: "mistral-vibe",
    trace: "vibe",
    install: "Install Mistral Vibe (curl -LsSf https://mistral.ai/vibe/install.sh | bash, or uv tool install mistral-vibe), run `vibe --setup`, and Run again.",
    login: "Run `vibe --setup` there and sign in with your Mistral account (or press Sign in under Settings → Models), then Run again.",
    sandbox: () => null,
    launch: async (input) => {
      const found = await onPath("vibe-acp");
      if (!found) return null;
      const env = agentEnv(input.extraEnv);
      // A turn someone else can steer: Vibe's settings, trusted folders and session logs are in Ensemble's home for it, with
      // the person's key file reached there (a key in the system's keyring is read as always); their Mistral connectors stay off.
      if (input.othersHome) {
        const vibeHome = join(input.othersHome, ".vibe");
        await linkSignIn(join(env.VIBE_HOME?.trim() || join(homedir(), ".vibe"), ".env"), join(vibeHome, ".env"));
        Object.assign(env, { VIBE_HOME: vibeHome, VIBE_ENABLE_CONNECTORS: "false" });
      }
      // Vibe's agents are its modes; `ask` asks before every tool, where the default `accept-edits` writes without asking.
      // A folder's own .vibe/ settings, agents and skills load only where the person trusted it in Vibe.
      return { program: found.program, base: found.args, args: [...found.args], env, resume: "session/load", askingMode: "ask", ownMcpOff: Boolean(input.othersHome) };
    },
  },
  "qwen-code": {
    id: "qwen-code",
    trace: "qwen",
    install: "Install Qwen Code (npm install -g @qwen-code/qwen-code@latest), sign in by running `qwen` once (`/auth`), and Run again.",
    login: "Run `qwen` there and choose how to sign in (`/auth`: your Qwen account, or a provider key), or press Sign in under Settings → Models, then Run again.",
    // Built from Gemini CLI: the same sandbox, Seatbelt on macOS and Docker or Podman elsewhere.
    sandbox: (platform) => (platform === "darwin" ? ["--sandbox"] : null),
    launch: async (input) => {
      const found = await onPath("qwen");
      if (!found) return null;
      const model = input.model && input.model !== "default" ? ["--model", input.model] : [];
      const sandbox = input.sandboxed ? (ACP_AGENTS["qwen-code"].sandbox(process.platform) ?? []) : [];
      const only = await geminiMcpOnly(found, input);
      return { program: found.program, base: found.args, args: [...found.args, await geminiAcpFlag(found), "--approval-mode", "default", ...sandbox, ...model, ...only], env: agentEnv(input.extraEnv), resume: "session/load", ownMcpOff: only.length > 0 };
    },
  },
  "kimi-code": {
    id: "kimi-code",
    trace: "kimi",
    install: "Install Kimi Code CLI (curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash), run `kimi login`, and Run again.",
    login: "Run `kimi login` there (or press Sign in under Settings → Models), then Run again.",
    sandbox: () => null,
    launch: async (input) => {
      const found = await onPath("kimi");
      if (!found) return null;
      // `login` confirms the sign-in `kimi login` saved; `default` mode asks before every edit and command.
      // A folder the person trusted in Ensemble is trusted for this run only, so its .kimi-code/ settings and MCP servers
      // load as in their own Kimi; any other folder's do not, whatever the environment says.
      const env = agentEnv(input.extraEnv);
      if (input.trusted) env.KIMI_CODE_TRUST_WORKSPACE = "1";
      else delete env.KIMI_CODE_TRUST_WORKSPACE;
      // A turn someone else can steer: Kimi Code's settings, MCP servers and plugins are in Ensemble's home for it, with the
      // person's sign-in (`kimi login`) reached there.
      if (input.othersHome) {
        const kimiHome = join(input.othersHome, ".kimi-code");
        await linkSignIn(join(env.KIMI_CODE_HOME?.trim() || join(homedir(), ".kimi-code"), "credentials"), join(kimiHome, "credentials"));
        env.KIMI_CODE_HOME = kimiHome;
      }
      return { program: found.program, base: found.args, args: [...found.args, "acp"], env, authMethod: "login", resume: "session/load", askingMode: "default", ownMcpOff: Boolean(input.othersHome) };
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
 * `locations`, a diff's `path`, `rawInput` (`path`, `file_path`, `filePath`, `absolute_path`) or
 * the files a patch in it names, and an MCP tool as `server: tool`, `server-tool` or `mcp__server__tool`.
 * A read or a change it cannot be located by carries what the agent said of it (`described`).
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
        ...Object.values(raw).flatMap((value) => patchPaths(value)),
        ...extra,
      ].filter((path): path is string => Boolean(path)),
    ),
  ];
  const described = [title, JSON.stringify(raw)].filter((part) => part && part !== "{}").join(" ").slice(0, 1500);
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
      return paths.length ? paths.map((path) => ({ tool: "Write", input: { file_path: path } })) : [{ tool: "Write", input: { described } }];
    }
    case "read": {
      const paths = pathsFrom();
      return paths.length ? paths.map((path) => ({ tool: "Read", input: { file_path: path } })) : [{ tool: "Read", input: { described } }];
    }
    // A search that names no folder looks in the agent's working folder.
    case "search": {
      const paths = pathsFrom();
      return [{ tool: "Grep", input: paths.length ? { paths } : {} }];
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
  options: { prompt: string; model?: string | null; effort?: string | null; stopCheck: () => Promise<void>; resume?: string | null; chat?: boolean; trace?: EngineTrace; onReplay?: ReplayHook },
): Promise<EngineResult> {
  const agent = ACP_AGENTS[id];
  const label = ENGINE_LABELS[id];
  if (ctx.sandboxed && !agent.sandbox(process.platform)) {
    throw new GuardError(
      `${label} has no OS sandbox Ensemble can turn on here. Turn the sandbox off for this run: Ensemble still judges every command, edit, outside read and fetch ${label} asks to make.`,
    );
  }
  const credential = registerEngineRun(ctx);
  const ensembleMcp = mcpEnv(credential, options.chat === true, ctx.job.context);
  const model = str(options.model) && options.model !== "default" ? options.model!.trim() : null;
  const launch = await agent.launch({ root: ctx.root, sandboxed: ctx.sandboxed, trusted: engineTrust(ctx), model, extraEnv: { ...ctx.secretEnv, ...ensembleMcp } });
  if (!launch) {
    unregisterEngineRun(ctx.job.id);
    throw new Error(`${label} is not on this computer. ${agent.install}`);
  }
  const child: ChildProcessWithoutNullStreams = spawn(launch.program, launch.args, { cwd: ctx.root, env: launch.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
  engineStarted(ctx, child);
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
  // A reopened session replays its history first: not this run's work, but it shows what the person said in
  // the agent's own app since Ensemble's last run there (outside-runs.ts).
  let replaying = false;
  const replayed: Array<Record<string, unknown>> = [];
  let overflow = false;
  /** The replay as exchanges, once read: null for a new session, or when the history was not read. */
  let history: OutsideTurn[] | null = null;
  /** The prompts this run sent into the session, one the agent has not answered yet included. */
  let sent = 0;
  // How many prompts the session holds: the replayed ones and each one this run sent (refusals carried back too).
  // Not counted when the history was not read, or for an agent that reopens with `session/resume`.
  const held = () => (launch.resume === "session/load" && (history || !options.resume) ? acpPrompts(history ?? [], sent) : null);
  let signInLink = false;
  const usage: { window: { used: number; size: number } | null } = { window: null };
  const announced = new Map<string, string>();
  const refusals: Refusal[] = [];
  rpc.onRequest = async (method, params) => {
    if (method === "session/request_permission") return answerAcp(ctx, agent.trace, params, announced, refusals);
    // A question as a form (OpenCode's question tool): each field is asked like any other question of the run.
    if (method === "elicitation/create") return answerElicitation(ctx, params);
    throw Object.assign(new Error(`${method} is not handled by Ensemble.`), { code: -32601 });
  };
  rpc.onNotification = (method, params) => {
    if (method !== "session/update") return;
    if (replaying) {
      if (replayed.length < MAX_REPLAYED) replayed.push(params);
      else overflow = true;
      return;
    }
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
        clientCapabilities: ACP_CLIENT_CAPABILITIES,
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
    let legacyModel = legacy.currentModelId ?? null;
    if (model && model !== currentModel && !choices.model && (legacy.availableModels ?? []).some((row) => row.modelId === model)) legacyModel = model;
    const effort = str(options.effort) && options.effort !== "default" ? options.effort!.trim() : null;
    if (effort) {
      const thought = configChoices(config).thought;
      if (thought && optionValues(thought).includes(effort)) {
        if (thought.currentValue !== effort) {
          const answer = (await rpc.request("session/set_config_option", { sessionId, configId: thought.id, value: effort })) as { configOptions?: ConfigOption[] };
          if (Array.isArray(answer?.configOptions) && answer.configOptions.length) config = answer.configOptions;
        }
      } else {
        await ctx.event("engine_note", { note: `${result.model ?? label} has no ${effort} thinking level in ${label}; it runs at its default.` });
      }
    }
    // What the agent's own session options say it runs (node/settings.ts observed).
    const now = configChoices(config);
    const observedModel = now.model ? (now.model.currentValue ?? null) : legacyModel;
    const observed = { ...(observedModel ? { model: observedModel } : {}), ...(now.thought?.currentValue ? { effort: now.thought.currentValue } : {}) };
    await ctx.event("engine", { engine: agent.trace, model: result.model, effort, session: sessionId, observed });
    await ctx.progress(`${label} started`);
    // The reopened session's history as exchanges (`session/resume` replays none): the run brings in what the
    // person said in the agent's own app since its last run there, and its note leads the prompt.
    history = options.resume && launch.resume === "session/load" && !overflow ? acpTurns(replayed) : null;
    const note = history && options.onReplay ? await options.onReplay(sessionId, history).catch(() => null) : null;
    const text = options.resume || options.chat ? options.prompt : titledPrompt(ctx.taskTitle, options.prompt);
    let prompt: Array<Record<string, unknown>> = [{ type: "text", text: note ? `${note}\n\n${text}` : text }];
    for (let round = 0; ; round += 1) {
      refusals.length = 0;
      sent += 1;
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
    // The session's prompts now, for the next run's replay.
    result.prompts = held();
    return result;
  } catch (error) {
    // A prompt sent before the run failed or was stopped is in the session all the same: the count goes with what
    // is thrown, for the run to note (outside-runs.ts).
    throw withPrompts(ctx.signal.aborted ? new DOMException("Stopped", "AbortError") : error, sessionId, held());
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
