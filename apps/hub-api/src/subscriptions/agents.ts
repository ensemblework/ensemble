/**
 * One assistant turn run by the person's own agent on this computer, signed in with their own
 * subscription (docs/30 §8). The agent is told it is the Ensemble assistant (the system prompt
 * Ensemble built for the turn) and gets Ensemble's tools. A chat, Ask Ensemble or a routine
 * (`spec.ownTools`) keeps the agent's own tools too (its shell, files and web), each call judged
 * only by Ensemble's hard floor (own-tools.ts); any other turn (a node's, a one-off completion)
 * gets Ensemble's tools alone, as below. Ensemble's tool calls go through the bridge (bridge.ts) to
 * wherever the turn's data is; writes there wait for Apply exactly as with a model key. Files
 * attached to the person's message are downloaded into the turn's folder and given to the agent in
 * its own input form (turn-files.ts).
 *
 * A chat is one session of the agent (`spec.session`, turn-sessions.ts): the first turn starts it
 * with the instructions and the chat so far, later turns resume it with just the new message. A
 * turn without a session (a one-off completion) leaves nothing saved.
 *
 * Claude Code: `claude -p` with `--system-prompt-file`, `--tools ""`, only Ensemble's MCP server,
 * the person's own settings (how their Claude Code signs in); `--session-id`, then `--resume`.
 * Codex: `codex app-server`, a thread with Ensemble's instructions as its base instructions, a
 * read-only sandbox, no environment, every approval declined; `thread/resume` for the next turn.
 * Cursor's agent and the ACP agents: every permission refused except Ensemble's own tools;
 * `session/load` (Antigravity: `session/resume`) when the agent offers it.
 * Copilot CLI: `copilot -p`, shell, file writes and URL fetches denied, no built-in MCP servers;
 * `--session-id` starts and resumes the chat's session.
 * With `ownTools`: Claude Code with its own tools and a hook on each; Codex without its sandbox and
 * with its environment, every approval judged; Copilot with all tools, paths and URLs and the hook
 * as a per-turn plugin; Cursor without its sandbox; every permission request judged.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { checkEffort, claudeLaunch, SUBSCRIPTION_INFO, type AcpEngine, type SubscriptionProvider } from "@ensemble/shared-types";
import { acpCalls, ACP_AGENTS, configChoices, type ConfigOption, optionValues, pickOption } from "../workspace/engines/acp.js";
import { antigravityAuthLink } from "./antigravity.js";
import { RpcConnection } from "../workspace/engines/rpc.js";
import { hookScriptPath, localApiUrl } from "../workspace/engines/registry.js";
import { openBridge, type ToolAnswer, type ToolSpec } from "./bridge.js";
import { agentBinary, agentEnv, codexEnv, refreshAgent } from "./detect.js";
import { copilotEnv, copilotHasSession } from "./copilot.js";
import { copilotOutput } from "./copilot-output.js";
import { acpPrompt, acpPromptCaps, claudeUserMessage, codexInput, copilotFiles, filesNote, saveTurnFiles, type SavedTurnFile, type TurnFile } from "./turn-files.js";
import { answerAcpOwnTools, answerCodexOwnTools, chatHookCommand, claudeChatSettings, logAcpTool, OwnToolLog, writeCopilotFloorPlugin } from "./own-tools.js";
import { sessionPrompts } from "./session-touch.js";
import { addClaudeDesktopSession, codexProject, helpHas, nameCodexThread, sessionTitle } from "../workspace/engines/app-sessions.js";
import { dropOneOff, findSession, forgetSession, instructionsUpdate, saveSession, SESSION_KEY, sessionFolder, type SessionUsage } from "./turn-sessions.js";

export type AgentTurnSpec = {
  agent: SubscriptionProvider;
  /** Null or "default": the agent's own default for the plan. */
  model: string | null;
  effort: string | null;
  system: string;
  prompt: string;
  tools: ToolSpec[];
  maxTurns: number;
  /** A model's long context window where the agent offers one (GitHub Copilot's `--context long_context`). */
  context?: "default" | "long_context" | null;
  /** Files attached to the person's message, fetched with `AgentTurnIO.readFile`. */
  files?: TurnFile[];
  /**
   * The chat this turn belongs to (`assistantTurns` 3): `key` names its session on this computer,
   * `history` is the chat so far, sent only when the turn starts a new session, and `position` how
   * many messages the chat had before this one (a session resumes only where it left the chat).
   * `title` names a new session in the agent's own app (app-sessions.ts); older computers ignore it.
   */
  session?: { key: string; history: string; position?: number; group?: SessionGroup; keepDays?: number; title?: string } | null;
  /**
   * The agent's own web search and page reading (Claude Code's WebSearch and WebFetch, Codex's live
   * web_search, Copilot's web_search and web_fetch): on the person's plan, so a node reads the web
   * without Ensemble's search. Never a shell, files or writes. Older computers ignore it.
   */
  ownWeb?: boolean;
  /**
   * The agent keeps all its own tools (its shell, files and web), each call judged only by Ensemble's
   * hard floor in the turn's folder (own-tools.ts): a chat, Ask Ensemble or a routine. Older computers
   * ignore it and the agent has only Ensemble's tools.
   */
  ownTools?: boolean;
};

/**
 * Where a chat's session works when it belongs to more than one chat: an Ensemble Node's project
 * folder (`<workspace>/projects/<name>`, agent-projects.ts), so the agent's app lists the node's
 * conversations, and its coding sessions without a folder of their own, as one project.
 */
export type SessionGroup = { id: string; name: string };

export type AgentTurnResult = {
  text: string;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  /** The turn went on in the chat's earlier session. */
  resumed?: boolean;
};

export type AgentTurnIO = {
  call: (name: string, input: unknown) => Promise<ToolAnswer>;
  onDelta: (text: string) => void;
  signal: AbortSignal;
  /** The bytes of one of `spec.files`; null when it cannot be had. */
  readFile?: (id: string) => Promise<Uint8Array | null>;
};

export type AgentTurnProblem = "not_installed" | "signed_out" | "limit" | "failed";

export class AgentTurnError extends Error {
  constructor(
    readonly problem: AgentTurnProblem,
    message: string,
  ) {
    super(message);
    this.name = "AgentTurnError";
  }
}

type McpServer = { command: string; args: string[]; env: Record<string, string> };

/**
 * `session`: the agent session to resume (`resume`), or the id to start one with, for agents that
 * take one (Claude Code, Copilot); null for a turn that saves no session.
 */
/** `usage`: the resumed session's totals as last reported, for an agent that reports the session's (Copilot). */
type TurnSession = { id: string; resume: boolean; usage?: SessionUsage } | null;
/** `folder`: where the agent works; `own`: the chat's own folder, for the turn's settings files (the same unless the folder is shared). */
/**
 * `oneOff`: the session an agent saved for a turn that keeps none, to delete from the agent afterwards.
 * `totals`: the session's token totals now, when the agent reports the session's rather than the turn's.
 */
type DriverResult = AgentTurnResult & { session?: string | null; oneOff?: string | null; totals?: SessionUsage | null };
type Driver = (input: { spec: AgentTurnSpec; io: AgentTurnIO; bin: string; folder: string; own?: string; mcp: McpServer; files: SavedTurnFile[]; session: TurnSession }) => Promise<DriverResult>;

/** The chat's earlier session could not be reopened (deleted, or the agent lost it): the turn starts a new one. */
class SessionGone extends Error {}
/** This version of the agent cannot keep a session: the turn runs without one. */
class SessionUnsupported extends Error {}

/** The first message of a session: Ensemble's instructions, for agents that have no system prompt, then the message. */
const opening = (spec: AgentTurnSpec, session: TurnSession) => (session?.resume ? spec.prompt : `${spec.system}\n\n---\n\n${spec.prompt}`);

const chosen = (value: string | null | undefined): string | null => (value && value !== "default" ? value : null);

/** How long the agent waits for one of Ensemble's tools: a browser task or a slow connected app takes minutes. */
export const TOOL_TIMEOUT_MS = 600_000;

/** Words for a failed turn: the agent's own message, read for sign-in and plan limits. */
export function agentProblem(agent: SubscriptionProvider, detail: string): AgentTurnError {
  const label = SUBSCRIPTION_INFO[agent].label;
  const text = detail.replace(/\s+/g, " ").trim().slice(0, 500);
  if (/not\s+(logged|signed)\s+in|please run \/login|run `?\/?login|invalid api key|oauth token|unauthori[sz]ed|authentication (required|failed)|\b401\b|copilot login|agent login|codex login/i.test(text)) {
    return new AgentTurnError("signed_out", `${label} is not signed in on this computer. In Ensemble, open Settings → Models → Your AI subscriptions and press Sign in next to ${label}.`);
  }
  if (/usage limit|rate limit|limit reached|hit your limit|out of (credits|usage)|quota|too many requests|\b429\b/i.test(text)) {
    return new AgentTurnError("limit", `${label} says your plan's limit is reached${text ? `: ${text}` : "."}`);
  }
  return new AgentTurnError("failed", `${label} stopped${text ? `: ${text}` : "."}`);
}

function stopChild(child: ChildProcess): void {
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

function aborted(): Error {
  return new DOMException("Stopped", "AbortError");
}

/** The arguments for Claude Code (exported for tests). */
export function claudeArgs(input: { systemFile: string; mcpFile: string; maxTurns: number; model: string | null; effort: string | null; context?: "default" | "long_context" | null; files?: boolean; session?: TurnSession; web?: boolean; ownTools?: boolean; hookCommand?: string; name?: string | null }): string[] {
  // The model's own thinking levels and its 1M window (`[1m]`), as the Claude tile listed them.
  const launch = claudeLaunch({ model: chosen(input.model) ? input.model : null, effort: chosen(input.effort) ? input.effort : null, context: input.context ?? null });
  return [
    "-p",
    // With files the message is one JSON line on stdin, so pictures and documents go as content blocks.
    ...(input.files ? ["--input-format", "stream-json"] : []),
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--system-prompt-file",
    input.systemFile,
    // All of Claude Code's own tools, each judged by Ensemble's hard floor through a hook (own-tools.ts);
    // otherwise none of them but its web search and page reading when asked. Ensemble's tools come from its MCP server.
    ...(input.ownTools && input.hookCommand ? ["--settings", JSON.stringify(claudeChatSettings(input.hookCommand))] : ["--tools", input.web ? "WebSearch,WebFetch" : ""]),
    "--strict-mcp-config",
    "--mcp-config",
    input.mcpFile,
    "--allowedTools",
    !input.ownTools && input.web ? "mcp__ensemble,WebSearch,WebFetch" : "mcp__ensemble",
    "--permission-mode",
    "default",
    // The person's own settings, where their Claude Code keeps how it signs in; never a folder's.
    // Their MCP servers stay out (--strict-mcp-config), and Ensemble's own hook steps aside (ENSEMBLE_RUN).
    "--setting-sources",
    "user",
    ...(input.session ? (input.session.resume ? ["--resume", input.session.id] : ["--session-id", input.session.id]) : ["--no-session-persistence"]),
    // A new session's name in Claude's own lists, in place of its first message (Ensemble's instructions).
    ...(input.session && !input.session.resume && input.name ? ["--name", input.name] : []),
    "--max-turns",
    String(input.maxTurns),
    ...(launch.model ? ["--model", launch.model] : []),
    ...(launch.effort ? ["--effort", launch.effort] : []),
  ];
}

const runClaude: Driver = async ({ spec, io, bin, folder, own, mcp, files, session }) => {
  const systemFile = join(own ?? folder, "system.md");
  const mcpFile = join(own ?? folder, "mcp.json");
  await writeFile(systemFile, spec.system, "utf8");
  await writeFile(mcpFile, JSON.stringify({ mcpServers: { ensemble: { type: "stdio", ...mcp } } }), "utf8");
  const title = sessionTitle(spec.session?.title);
  const name = session && !session.resume && title && (await helpHas(bin, ["--help"], "--name", agentEnv({}))) ? title : null;
  const child = spawn(bin, claudeArgs({ systemFile, mcpFile, maxTurns: spec.maxTurns, model: spec.model, effort: spec.effort, context: spec.context ?? null, files: files.length > 0, session, web: spec.ownWeb === true, ownTools: spec.ownTools === true, hookCommand: chatHookCommand("claude"), name }), {
    cwd: folder,
    // A tool call may wait on a slow connected app; Claude Code must not give up first.
    env: agentEnv({ ...mcp.env, MCP_TOOL_TIMEOUT: String(TOOL_TIMEOUT_MS), ENSEMBLE_RUN: "assistant-turn" }),
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  child.stdin!.on("error", () => undefined);
  child.stdin!.end(files.length ? claudeUserMessage(spec.prompt, files) : spec.prompt);
  const stop = () => stopChild(child);
  io.signal.addEventListener("abort", stop, { once: true });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000);
  });
  const result: AgentTurnResult = { text: "", model: null, tokensIn: null, tokensOut: null, costUsd: null };
  let failure: string | null = null;
  let finished = false;
  const tools = new OwnToolLog("claude-code");
  try {
    for await (const line of createInterface({ input: child.stdout! })) {
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (message.type === "system" && message.subtype === "init") {
        result.model = typeof message.model === "string" ? message.model : null;
      } else if (message.type === "assistant" || message.type === "user") {
        // Its own tool calls as they start (assistant) and what each returned (user), for the AI activity log.
        const content = ((message.message ?? {}) as { content?: unknown }).content;
        for (const part of Array.isArray(content) ? (content as Array<Record<string, unknown>>) : []) {
          if (part.type === "tool_use") tools.start(String(part.id ?? ""), String(part.name ?? "tool"), part.input ?? {});
          else if (part.type === "tool_result") {
            const output = Array.isArray(part.content) ? (part.content as Array<Record<string, unknown>>).map((piece) => (typeof piece.text === "string" ? piece.text : piece.type === "image" ? "[image]" : "")).join("\n") : part.content;
            tools.end(String(part.tool_use_id ?? ""), output, part.is_error !== true);
          }
        }
      } else if (message.type === "stream_event") {
        const event = (message.event ?? {}) as { type?: string; delta?: { type?: string; text?: string } };
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) io.onDelta(event.delta.text);
      } else if (message.type === "result") {
        finished = true;
        result.text = typeof message.result === "string" ? message.result.trim() : "";
        result.costUsd = typeof message.total_cost_usd === "number" ? message.total_cost_usd : null;
        const usage = (message.usage ?? {}) as Record<string, number>;
        result.tokensIn = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) || null;
        result.tokensOut = usage.output_tokens ?? null;
        if (message.is_error === true || (typeof message.subtype === "string" && message.subtype !== "success")) {
          failure = message.subtype === "error_max_turns" ? `it used all ${spec.maxTurns} steps without a final answer` : result.text || String(message.subtype ?? "an error");
        }
      }
    }
    const code = await new Promise<number>((done) => (child.exitCode !== null ? done(child.exitCode) : child.once("close", (value) => done(value ?? 1))));
    if (io.signal.aborted) throw aborted();
    const said = `${failure ?? ""} ${stderr}`;
    if (session?.resume && /no conversation found|session.{0,40}not found/i.test(said)) throw new SessionGone(said.trim());
    if (session && /unknown option.{0,20}(--session-id|--resume)/i.test(said)) throw new SessionUnsupported(said.trim());
    if (failure) throw agentProblem(spec.agent, failure);
    if (code !== 0 || !finished) throw agentProblem(spec.agent, stderr.trim().split("\n").slice(-6).join(" ") || `exit ${code}`);
    // A new chat session is listed in the Claude app's Code tab too (app-sessions.ts).
    if (session && !session.resume) await addClaudeDesktopSession({ cliSessionId: session.id, cwd: folder, title, model: result.model });
    return { ...result, session: session?.id ?? null };
  } finally {
    tools.close();
    io.signal.removeEventListener("abort", stop);
    stop();
  }
};

/** Codex's own requests during an assistant turn: nothing of its own may run. */
export async function answerCodexTurn(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: { denied: { rejection: "The Ensemble assistant has only Ensemble's tools." } } };
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn" };
    case "item/tool/requestUserInput":
      return { answers: {} };
    case "mcpServer/elicitation/request":
      return { action: params.serverName === "ensemble" ? "accept" : "decline", content: null, _meta: null };
    default:
      throw new Error(`${method} is not handled by Ensemble.`);
  }
}

const runCodex: Driver = async ({ spec, io, bin, folder, mcp, files, session }) => {
  const child = spawn(bin, ["app-server"], { cwd: folder, env: codexEnv(mcp.env), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
  child.stdin.on("error", () => undefined);
  const server = new RpcConnection((line) => {
    if (child.stdin.writable) child.stdin.write(line);
  });
  const result: AgentTurnResult = { text: "", model: null, tokensIn: null, tokensOut: null, costUsd: null };
  let stderr = "";
  let lastError = "";
  let threadId: string | null = null;
  let turnId: string | null = null;
  let finished: (status: { status: string; error?: string }) => void = () => {};
  const turnDone = new Promise<{ status: string; error?: string }>((resolve) => (finished = resolve));
  // With its own tools, the paths each file change touches, for its approval (own-tools.ts).
  const changes = new Map<string, string[]>();
  const tools = new OwnToolLog("codex");
  server.onRequest = (method, params) => (spec.ownTools ? answerCodexOwnTools(folder, method, params, changes) : answerCodexTurn(method, params));
  server.onNotification = (method, params) => {
    if (method === "item/started" || method === "item/completed") {
      const item = (params.item ?? {}) as { type?: string; id?: string; changes?: Array<{ path: string }>; command?: string; server?: string; tool?: string; arguments?: unknown; query?: string; aggregatedOutput?: string | null; exitCode?: number | null; status?: string; result?: unknown; error?: unknown };
      if (item.type === "fileChange" && item.id) changes.set(item.id, (item.changes ?? []).map((change) => change.path));
      // Its own calls for the AI activity log; Ensemble's MCP tools are logged where they run.
      const own = item.type === "commandExecution" || item.type === "fileChange" || item.type === "webSearch" || (item.type === "mcpToolCall" && item.server !== "ensemble");
      if (own && item.id && method === "item/started") {
        const input = item.type === "commandExecution" ? { command: item.command } : item.type === "fileChange" ? { files: (item.changes ?? []).map((change) => change.path) } : item.type === "webSearch" ? { query: item.query } : { server: item.server, tool: item.tool, arguments: item.arguments };
        tools.start(item.id, item.type === "mcpToolCall" ? `${item.server}/${item.tool}` : item.type!, input);
      } else if (own && item.id) {
        const failed = item.status === "failed" || item.status === "declined" || (typeof item.exitCode === "number" && item.exitCode !== 0);
        tools.end(item.id, item.aggregatedOutput ?? item.result ?? item.error ?? (typeof item.exitCode === "number" ? `exit ${item.exitCode}` : item.status ?? ""), !failed);
      }
    }
    if (method === "item/agentMessage/delta" && typeof params.delta === "string") io.onDelta(params.delta);
    else if (method === "item/completed") {
      const item = (params.item ?? {}) as { type?: string; text?: string; phase?: string | null };
      if (item.type === "agentMessage" && item.text?.trim() && (item.phase === "final_answer" || item.phase === null || item.phase === undefined)) result.text = item.text.trim();
    } else if (method === "thread/tokenUsage/updated") {
      const total = ((params.tokenUsage ?? {}) as { total?: { inputTokens?: number; outputTokens?: number } }).total ?? {};
      result.tokensIn = total.inputTokens ?? result.tokensIn;
      result.tokensOut = total.outputTokens ?? result.tokensOut;
    } else if (method === "error") {
      const error = (params.error ?? {}) as { message?: string };
      if (error.message) lastError = error.message;
    } else if (method === "turn/completed") {
      const turn = (params.turn ?? {}) as { status?: string; error?: { message?: string } | null };
      finished({ status: turn.status ?? "completed", error: turn.error?.message });
    }
  };
  createInterface({ input: child.stdout }).on("line", (line) => void server.receive(line));
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000);
  });
  child.once("close", () => {
    server.close("Codex stopped.");
    finished({ status: "failed", error: lastError || stderr.trim().split("\n").slice(-3).join(" ") || "Codex stopped." });
  });
  const stop = () => {
    if (threadId && turnId) void server.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
    setTimeout(() => stopChild(child), 2000).unref();
  };
  io.signal.addEventListener("abort", stop, { once: true });
  try {
    await server.request("initialize", { clientInfo: { name: "ensemble", title: "Ensemble", version: "1" }, capabilities: { experimentalApi: true, requestAttestation: false } });
    server.notify("initialized");
    const account = (await server.request("account/read", {})) as { account?: unknown; requiresOpenaiAuth?: boolean };
    if (account.requiresOpenaiAuth && !account.account) throw agentProblem("codex", "not signed in");
    const model = chosen(spec.model);
    const settings = {
      cwd: folder,
      // Codex asks before every command it does not consider safe; with its own tools each is judged (own-tools.ts).
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: spec.ownTools ? "danger-full-access" : "read-only",
      baseInstructions: spec.system,
      // A chat's thread is kept for its next turn; a one-off turn's is not.
      ephemeral: !session,
      serviceName: "ensemble",
      ...(model ? { model } : {}),
      config: {
        projects: { [folder]: { trust_level: "untrusted" } },
        mcp_servers: { ensemble: { command: mcp.command, args: mcp.args, env: mcp.env, tool_timeout_sec: TOOL_TIMEOUT_MS / 1000 } },
        // Codex's own web search runs at OpenAI, not in the sandbox: the person's plan reads the web.
        ...(spec.ownWeb || spec.ownTools ? { web_search: "live" } : {}),
      },
    };
    const { serviceName: _serviceName, ephemeral: _ephemeral, ...resumeSettings } = settings;
    // An Ensemble Node's chats share its project folder: in the Codex app they are that project's (app-sessions.ts).
    const group = !session?.resume && session && spec.session?.group ? spec.session.group : null;
    const projectId = group ? await codexProject(server, { id: group.id, name: group.name, folder }) : null;
    const start = (params: typeof settings & { projectId?: string }) =>
      server.request("thread/start", spec.ownTools ? params : { ...params, environments: [] }).catch((error: Error) => {
        if (/environments|unknown field/i.test(error.message)) return server.request("thread/start", params);
        throw error;
      });
    // No environment: Codex's own shell and file tools are not there at all. A resumed thread does not
    // keep that, so every turn asks for it again (turn/start below).
    const thread = (
      session?.resume
        ? await server.request("thread/resume", { threadId: session.id, ...resumeSettings }).catch((error: Error) => {
            throw new SessionGone(error.message);
          })
        : await start(projectId ? { ...settings, projectId } : settings).catch((error: Error) => {
            // A project removed in the Codex app since: the thread starts outside any project.
            if (projectId && /project/i.test(error.message)) return start(settings);
            throw error;
          })
    ) as { thread?: { id?: string }; model?: string };
    threadId = thread.thread?.id ?? null;
    if (!threadId) throw agentProblem("codex", "it did not start a conversation");
    // Named after the chat in the Codex app, not after its first message (Ensemble's instructions).
    if (session && !session.resume) await nameCodexThread(server, threadId, sessionTitle(spec.session?.title));
    result.model = thread.model ?? model;
    const effort = chosen(spec.effort);
    const turnParams = { threadId, input: codexInput(spec.prompt, files), sandboxPolicy: spec.ownTools ? { type: "dangerFullAccess" } : { type: "readOnly", networkAccess: false }, ...(effort ? { effort } : {}) };
    const turn = (await server.request("turn/start", spec.ownTools ? turnParams : { ...turnParams, environments: [] }).catch((error: Error) => {
      if (!/environments|unknown field/i.test(error.message)) throw error;
      // A Codex that cannot drop its environment per turn may only run a thread started without one.
      if (session?.resume) throw new SessionUnsupported(error.message);
      return server.request("turn/start", turnParams);
    })) as { turn?: { id?: string } };
    turnId = turn.turn?.id ?? null;
    const done = await turnDone;
    if (io.signal.aborted || done.status === "interrupted") throw aborted();
    if (done.status === "failed") throw agentProblem("codex", done.error ?? "the turn failed");
    return { ...result, session: session ? threadId : null };
  } catch (error) {
    if (io.signal.aborted) throw aborted();
    if (error instanceof AgentTurnError || error instanceof SessionGone || error instanceof SessionUnsupported) throw error;
    throw agentProblem("codex", error instanceof Error ? error.message : String(error));
  } finally {
    tools.close();
    io.signal.removeEventListener("abort", stop);
    stopChild(child);
  }
};

/** Whether an ACP agent can reopen a session (`agentCapabilities.loadSession`). */
function loadsSessions(init: Record<string, unknown>): boolean {
  return (init.agentCapabilities as { loadSession?: unknown } | undefined)?.loadSession === true;
}

/** Reopens an ACP session, its replayed history ignored; one the agent cannot find is gone. */
async function reopen(rpc: RpcConnection, method: "session/load" | "session/resume", id: string, cwd: string, mcpServers: unknown[], replaying: (on: boolean) => void): Promise<Record<string, unknown>> {
  replaying(true);
  try {
    const loaded = (await rpc.request(method, { sessionId: id, cwd, mcpServers })) as Record<string, unknown>;
    return { ...loaded, sessionId: id };
  } catch (error) {
    throw new SessionGone(error instanceof Error ? error.message : String(error));
  } finally {
    replaying(false);
  }
}

/**
 * The agents whose own web search and page reading a turn turns on (`ownWeb`): Claude Code (WebSearch,
 * WebFetch), Codex (`web_search`), Copilot (`web_search`, `web_fetch`). Cursor's agent and the ACP agents
 * get every tool of their own refused in a turn, so they read the web through Ensemble's tools.
 */
export const OWN_WEB_AGENTS: ReadonlySet<SubscriptionProvider> = new Set(["claude-code", "codex", "copilot-cli"]);

/** Cursor's own requests during an assistant turn: only Ensemble's tools may run. */
export function answerCursorTurn(method: string, params: Record<string, unknown>): unknown {
  if (method === "session/request_permission") {
    const options = (Array.isArray(params.options) ? params.options : []) as Array<{ optionId: string; kind?: string }>;
    const title = String((params.toolCall as { title?: string } | undefined)?.title ?? "");
    // MCP tools are titled "<server>: <tool>".
    const ours = /^ensemble:\s*\S/.test(title);
    const wanted = ours ? "allow_once" : "reject_once";
    const option = options.find((item) => item.kind === wanted) ?? options.find((item) => item.optionId === (ours ? "allow-once" : "reject-once"));
    return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
  }
  if (method === "cursor/ask_question") return { outcome: { outcome: "skipped", reason: "Ask the person in your reply instead." } };
  throw Object.assign(new Error(`${method} is not handled by Ensemble.`), { code: -32601 });
}

const runCursor: Driver = async ({ spec, io, bin, folder, mcp, files, session }) => {
  const model = chosen(spec.model);
  const child = spawn(bin, ["--sandbox", spec.ownTools ? "disabled" : "enabled", "--workspace", folder, ...(model ? ["--model", model] : []), "acp"], {
    cwd: folder,
    env: agentEnv(mcp.env),
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  child.stdin.on("error", () => undefined);
  const rpc = new RpcConnection(
    (line) => {
      if (child.stdin.writable) child.stdin.write(line);
    },
    { jsonrpc: true },
  );
  let reply = "";
  let stderr = "";
  let sessionId: string | null = null;
  // A reopened session replays its history first: that is not this turn's reply.
  let replaying = false;
  const tools = new OwnToolLog("cursor-agent");
  rpc.onRequest = async (method, params) => (spec.ownTools ? answerAcpOwnTools(folder, method, params, "cursor-agent") : answerCursorTurn(method, params));
  rpc.onNotification = (method, params) => {
    if (method !== "session/update" || replaying) return;
    const update = (params.update ?? {}) as { sessionUpdate?: string; content?: { type?: string; text?: string } };
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && update.content.text) {
      reply += update.content.text;
      io.onDelta(update.content.text);
    } else logAcpTool(tools, update as Record<string, unknown>);
  };
  createInterface({ input: child.stdout }).on("line", (line) => void rpc.receive(line));
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000);
  });
  child.once("close", () => rpc.close(`Cursor's agent stopped. ${stderr.split("\n").filter((line) => line.trim() && !/certificate/i.test(line)).slice(-3).join(" ")}`.trim()));
  const stop = () => {
    if (sessionId) rpc.notify("session/cancel", { sessionId });
    setTimeout(() => stopChild(child), 2000).unref();
  };
  io.signal.addEventListener("abort", stop, { once: true });
  try {
    const init = await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    const caps = acpPromptCaps(init);
    await rpc.request("authenticate", { methodId: "cursor_login" }).catch(() => undefined);
    const mcpServers = [{ name: "ensemble", command: mcp.command, args: mcp.args, env: Object.entries(mcp.env).map(([name, value]) => ({ name, value })) }];
    if (session && !loadsSessions(init)) throw new SessionUnsupported("Cursor's agent cannot reopen a session");
    const started = session?.resume ? await reopen(rpc, "session/load", session.id, folder, mcpServers, (on) => (replaying = on)) : await rpc.request("session/new", { cwd: folder, mcpServers });
    sessionId = typeof started.sessionId === "string" ? started.sessionId : null;
    if (!sessionId) throw agentProblem("cursor-agent", "it did not start a session");
    // ACP has no system prompt: Ensemble's instructions lead a session's first message.
    const done = (await rpc.request("session/prompt", { sessionId, prompt: acpPrompt(opening(spec, session), files, caps, "Cursor's agent") })) as { stopReason?: string; usage?: { inputTokens?: number; outputTokens?: number } };
    if (io.signal.aborted || done.stopReason === "cancelled") throw aborted();
    if (done.stopReason === "refusal") throw agentProblem("cursor-agent", "it refused the request");
    return { text: reply.trim(), model, tokensIn: done.usage?.inputTokens ?? null, tokensOut: done.usage?.outputTokens ?? null, costUsd: null, session: session ? sessionId : null, oneOff: session ? null : sessionId };
  } catch (error) {
    if (io.signal.aborted) throw aborted();
    if (error instanceof AgentTurnError || error instanceof SessionGone || error instanceof SessionUnsupported) throw error;
    throw agentProblem("cursor-agent", error instanceof Error ? error.message : String(error));
  } finally {
    tools.close();
    io.signal.removeEventListener("abort", stop);
    stopChild(child);
  }
};

/**
 * How long Copilot CLI's prompt may be. On the command line (`-p`), Windows caps it near 32,000 characters,
 * which cut a node's instructions; piped on stdin (Copilot 1.0.78 and later) nothing does.
 */
const copilotLimit = (platform: NodeJS.Platform = process.platform, stdin = false) => (stdin ? 2_000_000 : platform === "win32" ? 28_000 : 200_000);

/** The first Copilot CLI that reads its prompt piped on stdin (its changelog: prompt mode "-p or piped stdin"). */
export const COPILOT_STDIN_FROM = [1, 0, 78] as const;
/** The first Copilot CLI known to write `--usage-output-file` (1.0.81 added per-agent metrics to it). */
export const COPILOT_USAGE_FILE_FROM = [1, 0, 81] as const;

/** Whether a Copilot CLI of this version (`copilot --version`'s output) is at least `from` (exported for tests). */
export function copilotAtLeast(versionText: string | null, from: readonly number[]): boolean {
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(versionText ?? "");
  if (!found) return false;
  const parts = found.slice(1, 4).map(Number);
  for (const [index, part] of parts.entries()) {
    if (part !== from[index]) return part > from[index]!;
  }
  return true;
}

/** Whether a Copilot CLI of this version reads its prompt from stdin (exported for tests). */
export const copilotReadsStdin = (versionText: string | null): boolean => copilotAtLeast(versionText, COPILOT_STDIN_FROM);

const pluginSupport = new Map<string, Promise<boolean>>();
/** Whether this Copilot CLI loads a plugin for one run (`--plugin-dir` in its help), asked once per program. */
function copilotTakesPlugins(bin: string): Promise<boolean> {
  let known = pluginSupport.get(bin);
  if (!known) {
    known = new Promise<boolean>((done) => {
      const probe = spawn(bin, ["help"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, env: copilotEnv({}) });
      let out = "";
      const timer = setTimeout(() => probe.kill(), 15_000);
      probe.stdout.on("data", (chunk: Buffer) => void (out += chunk.toString("utf8")));
      probe.once("error", () => done(false));
      probe.once("close", () => {
        clearTimeout(timer);
        done(out.includes("--plugin-dir"));
      });
    });
    pluginSupport.set(bin, known);
  }
  return known;
}

const copilotVersions = new Map<string, Promise<string | null>>();
/** `copilot --version`, asked once per Copilot program for this process's life. */
function copilotVersion(bin: string): Promise<string | null> {
  let known = copilotVersions.get(bin);
  if (!known) {
    known = new Promise<string | null>((done) => {
      const probe = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, env: copilotEnv({}) });
      let out = "";
      const timer = setTimeout(() => probe.kill(), 15_000);
      probe.stdout.on("data", (chunk: Buffer) => void (out += chunk.toString("utf8")));
      probe.once("error", () => done(null));
      probe.once("close", () => {
        clearTimeout(timer);
        done(out || null);
      });
    });
    copilotVersions.set(bin, known);
  }
  return known;
}

/** The prompt with the attached files' text after it, the text cut to the room the command line has (exported for tests). */
export function copilotPrompt(head: string, sections: string[], platform?: NodeJS.Platform, stdin = false): string {
  if (!sections.length) return head;
  const text = sections.join("\n\n");
  const room = copilotLimit(platform, stdin) - head.length - 2;
  if (text.length <= room) return `${head}\n\n${text}`;
  const cut = "\n[The rest of the attached files' text did not fit in the command line.]";
  return room > cut.length ? `${head}\n\n${text.slice(0, room - cut.length)}${cut}` : `${head}${cut}`;
}

/** The arguments for Copilot CLI (exported for tests). */
export function copilotArgs(input: { prompt: string; mcpFile: string; model: string | null; effort: string | null; context?: string | null; platform?: NodeJS.Platform; attachments?: string[]; sessionId?: string | null; web?: boolean; stdin?: boolean; usageFile?: string | null; pluginDir?: string | null; name?: string | null }): string[] {
  const limit = copilotLimit(input.platform);
  const prompt = input.prompt.length > limit ? input.prompt.slice(input.prompt.length - limit) : input.prompt;
  return [
    // Piped on stdin the prompt has no length limit; on the command line it is cut to fit, oldest text first.
    ...(input.stdin ? [] : ["-p", prompt]),
    "--stream",
    "on",
    "--output-format",
    "json",
    // Prompt mode needs tools allowed up front. With its own tools (`pluginDir`: Ensemble's hard floor as a
    // per-turn plugin's hook, own-tools.ts) every tool, path and URL; else the denials win over it.
    "--allow-all-tools",
    ...(input.pluginDir
      ? ["--allow-all-paths", "--allow-all-urls", "--plugin-dir", input.pluginDir]
      : [
          "--deny-tool",
          "shell",
          "--deny-tool",
          "write",
          // Copilot's web_fetch asks for url(); its web_search does not. Without own web both stay closed.
          ...(input.web ? [] : ["--deny-tool", "url", "--excluded-tools", "web_search"]),
          "--disable-builtin-mcps",
        ]),
    // Nobody can answer Copilot's own question prompt here; Ensemble's tools carry the conversation.
    "--no-ask-user",
    "--no-auto-update",
    "--additional-mcp-config",
    `@${input.mcpFile}`,
    // The chat's session: started with this id on the first turn, resumed by it after.
    ...(input.sessionId ? ["--session-id", input.sessionId] : []),
    // A new session's name in Copilot's lists (VS Code's sessions too), in place of Ensemble's instructions.
    ...(input.name ? ["--name", input.name] : []),
    ...(input.attachments ?? []).flatMap((path) => ["--attachment", path]),
    ...(chosen(input.model) ? ["--model", input.model!] : []),
    ...(chosen(input.effort) ? ["--reasoning-effort", input.effort!] : []),
    ...(input.context === "long_context" ? ["--context", "long_context"] : []),
    ...(input.usageFile ? ["--usage-output-file", input.usageFile] : []),
  ];
}

const runCopilot: Driver = async ({ spec, io, bin, folder, own, mcp, files, session }) => {
  // `--session-id` would quietly start a new, empty session under the id of one deleted in Copilot.
  if (session?.resume && (await copilotHasSession(session.id)) === false) throw new SessionGone(`Copilot no longer has session ${session.id}`);
  const mcpFile = join(own ?? folder, "mcp.json");
  // A tool call may take minutes (a browser task, a slow connected app); Copilot's own MCP timeout is shorter.
  await writeFile(mcpFile, JSON.stringify({ mcpServers: { ensemble: { type: "local", ...mcp, tools: ["*"], timeout: TOOL_TIMEOUT_MS } } }), "utf8");
  const { attachments, sections } = copilotFiles(files);
  const version = await copilotVersion(bin);
  const stdin = copilotReadsStdin(version);
  const usageFile = copilotAtLeast(version, COPILOT_USAGE_FILE_FROM) ? join(own ?? folder, `usage-${randomUUID()}.json`) : null;
  const prompt = copilotPrompt(opening(spec, session), sections, process.platform, stdin);
  // Copilot saves every run as a session: a one-off turn names its own, to delete it afterwards (from 1.0.78, which takes --session-id).
  const oneOff = !session && stdin ? randomUUID() : null;
  // Its own tools need a Copilot that loads a plugin for one run; an older one has only Ensemble's.
  const pluginDir = spec.ownTools && (await copilotTakesPlugins(bin)) ? await writeCopilotFloorPlugin(join(own ?? folder, "copilot-floor"), chatHookCommand("copilot-cli")) : null;
  const title = sessionTitle(spec.session?.title);
  const name = session && !session.resume && title && (await helpHas(bin, ["help"], "--name", copilotEnv({}))) ? title : null;
  const child = spawn(bin, copilotArgs({ prompt, mcpFile, model: spec.model, effort: spec.effort, context: spec.context ?? null, attachments, sessionId: session?.id ?? oneOff, web: spec.ownWeb === true, stdin, usageFile, pluginDir, name }), {
    cwd: folder,
    // A hook of the person's own Ensemble connection (`ensemble hooks connect`) stays out of the turn.
    env: copilotEnv({ ...mcp.env, ENSEMBLE_RUN: "assistant-turn" }),
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  child.stdin.on("error", () => undefined);
  // On the command line, stdin closes empty at once.
  child.stdin.end(stdin ? prompt : undefined, "utf8");
  const stop = () => stopChild(child);
  io.signal.addEventListener("abort", stop, { once: true });
  const tools = new OwnToolLog("copilot-cli");
  const output = copilotOutput(chosen(spec.model), io.onDelta, tools);
  let stderr = "";
  createInterface({ input: child.stdout }).on("line", line => output.line(line));
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000);
  });
  try {
    const code = await new Promise<number>((done) => child.once("close", (value) => done(value ?? 1)));
    if (io.signal.aborted) throw aborted();
    if (code !== 0 && session && /unknown option.{0,20}--session-id/i.test(stderr)) throw new SessionUnsupported(stderr.trim());
    if (code !== 0) throw agentProblem("copilot-cli", stderr.trim().split("\n").slice(-6).join(" ") || `exit ${code}`);
    const read = usageFile ? output.usageFile(await readFile(usageFile, "utf8").catch(() => null)) : null;
    const done = output.finish();
    // Copilot's usage file holds the whole session's tokens: this turn's are what it added since the last one.
    const totals = read?.totals ?? null;
    const base = session?.resume ? session.usage : undefined;
    const turn = read?.applied && totals && base && totals.in >= base.in && totals.out >= base.out ? { tokensIn: totals.in - base.in, tokensOut: totals.out - base.out } : {};
    return { ...done, ...turn, session: session?.id ?? null, oneOff, totals };
  } finally {
    tools.close();
    io.signal.removeEventListener("abort", stop);
    stop();
    if (usageFile) await rm(usageFile, { force: true }).catch(() => undefined);
  }
};

/** An ACP agent's own requests during an assistant turn: only Ensemble's tools may run. */
export function answerAcpTurn(method: string, params: Record<string, unknown>): unknown {
  if (method === "session/request_permission") {
    const options = (Array.isArray(params.options) ? params.options : []) as Array<{ optionId: string; kind?: string }>;
    const ours = acpCalls((params.toolCall ?? {}) as Parameters<typeof acpCalls>[0]).every((call) => call.tool.startsWith("mcp__ensemble__"));
    const optionId = pickOption(options, ours);
    return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
  }
  throw Object.assign(new Error(`${method} is not handled by Ensemble.`), { code: -32601 });
}

/** Grok Build, OpenCode, Gemini CLI or Antigravity for one assistant turn, in an empty folder with only Ensemble's tools. */
const runAcpTurn =
  (id: AcpEngine): Driver =>
  async ({ spec, io, folder, mcp, files, session }) => {
    const model = chosen(spec.model);
    const launch = await ACP_AGENTS[id].launch({ root: folder, sandboxed: false, trusted: false, model, extraEnv: mcp.env });
    if (!launch) throw new AgentTurnError("not_installed", `${SUBSCRIPTION_INFO[id].label} is not on this computer.`);
    const child = spawn(launch.program, launch.args, { cwd: folder, env: launch.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    child.stdin.on("error", () => undefined);
    const rpc = new RpcConnection((line) => child.stdin.writable && void child.stdin.write(line), { jsonrpc: true });
    let reply = "";
    let stderr = "";
    let sessionId: string | null = null;
    let replaying = false;
    const tools = new OwnToolLog(id);
    rpc.onRequest = async (method, params) => (spec.ownTools ? answerAcpOwnTools(folder, method, params, id) : answerAcpTurn(method, params));
    rpc.onNotification = (method, params) => {
      if (method !== "session/update" || replaying) return;
      const update = (params.update ?? {}) as { sessionUpdate?: string; content?: { type?: string; text?: string } };
      if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && update.content.text) {
        reply += update.content.text;
        io.onDelta(update.content.text);
      } else logAcpTool(tools, update as Record<string, unknown>);
    };
    createInterface({ input: child.stdout }).on("line", (line) => (antigravityAuthLink(line) ? rpc.close("not signed in") : void rpc.receive(line)));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });
    child.once("close", () => rpc.close(`${SUBSCRIPTION_INFO[id].label} stopped. ${stderr.split("\n").filter((line) => line.trim()).slice(-3).join(" ")}`.trim()));
    const stop = () => {
      if (sessionId) rpc.notify("session/cancel", { sessionId });
      setTimeout(() => stopChild(child), 2000).unref();
    };
    io.signal.addEventListener("abort", stop, { once: true });
    try {
      const init = await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "ensemble", version: "1" }, ...(launch.initializeMeta ? { _meta: launch.initializeMeta } : {}) });
      const caps = acpPromptCaps(init);
      if (launch.authMethod) await rpc.request("authenticate", { methodId: launch.authMethod });
      const mcpServers = [{ name: "ensemble", command: mcp.command, args: mcp.args, env: Object.entries(mcp.env).map(([name, value]) => ({ name, value })) }];
      if (session && launch.resume === "session/load" && !loadsSessions(init)) throw new SessionUnsupported(`${SUBSCRIPTION_INFO[id].label} cannot reopen a session`);
      const started = session?.resume ? await reopen(rpc, launch.resume, session.id, folder, mcpServers, (on) => (replaying = on)) : await rpc.request("session/new", { cwd: folder, mcpServers });
      sessionId = typeof started.sessionId === "string" ? started.sessionId : null;
      if (!sessionId) throw agentProblem(id, "it did not start a session");
      // An agent that can start in a mode acting without asking (Antigravity, Mistral Vibe's accept-edits) goes to
      // the one that asks, so every tool of its own reaches answerAcpTurn and is refused.
      const modes = (started.modes ?? {}) as { currentModeId?: string; availableModes?: Array<{ id?: string }> };
      if (launch.askingMode && modes.currentModeId && modes.currentModeId !== launch.askingMode) {
        if (!(modes.availableModes ?? []).some((mode) => mode.id === launch.askingMode)) throw agentProblem(id, "it cannot be set to ask before it acts");
        await rpc.request("session/set_mode", { sessionId, modeId: launch.askingMode });
      }
      const config = Array.isArray(started.configOptions) ? (started.configOptions as ConfigOption[]) : [];
      const { model: modelOption, thought } = configChoices(config);
      if (model && modelOption && optionValues(modelOption).includes(model) && modelOption.currentValue !== model) await rpc.request("session/set_config_option", { sessionId, configId: modelOption.id, value: model });
      if (spec.effort && thought && optionValues(thought).includes(spec.effort)) await rpc.request("session/set_config_option", { sessionId, configId: thought.id, value: spec.effort });
      // ACP has no system prompt: Ensemble's instructions lead a session's first message.
      const done = (await rpc.request("session/prompt", { sessionId, prompt: acpPrompt(opening(spec, session), files, caps, SUBSCRIPTION_INFO[id].label) })) as { stopReason?: string; usage?: { inputTokens?: number; outputTokens?: number } };
      if (io.signal.aborted || done.stopReason === "cancelled") throw aborted();
      if (done.stopReason === "refusal") throw agentProblem(id, "it refused the request");
      return { text: reply.trim(), model: model ?? modelOption?.currentValue ?? null, tokensIn: done.usage?.inputTokens ?? null, tokensOut: done.usage?.outputTokens ?? null, costUsd: null, session: session ? sessionId : null, oneOff: session ? null : sessionId };
    } catch (error) {
      if (io.signal.aborted) throw aborted();
      if (error instanceof AgentTurnError || error instanceof SessionGone || error instanceof SessionUnsupported) throw error;
      throw agentProblem(id, error instanceof Error ? error.message : String(error));
    } finally {
      tools.close();
      io.signal.removeEventListener("abort", stop);
      stopChild(child);
    }
  };

const DRIVERS: Record<SubscriptionProvider, Driver> = {
  "claude-code": runClaude,
  codex: runCodex,
  "cursor-agent": runCursor,
  "copilot-cli": runCopilot,
  "grok-cli": runAcpTurn("grok-cli"),
  opencode: runAcpTurn("opencode"),
  "gemini-cli": runAcpTurn("gemini-cli"),
  antigravity: runAcpTurn("antigravity"),
  "mistral-vibe": runAcpTurn("mistral-vibe"),
  "qwen-code": runAcpTurn("qwen-code"),
  "kimi-code": runAcpTurn("kimi-code"),
};

/** Turns of one chat, one at a time: they share its session and its folder. */
const chats = new Map<string, Promise<unknown>>();

/** Resolves once the chat's turn in progress here (if any) has ended, so its session is not saved again after it is deleted. */
export async function chatSettled(key: string): Promise<void> {
  while (chats.has(key)) await chats.get(key)!.catch(() => undefined);
}

/** A node's project folder in the Ensemble workspace (agent-projects.ts); null when there is none here. */
async function groupFolder(group: SessionGroup): Promise<string | null> {
  try {
    // Loaded only for a node's turn: the workspace's guard reads the runtime's settings.
    const [{ projectFolder }, { workspaceRoot }] = await Promise.all([import("../workspace/agent-projects.js"), import("../workspace/guard.js")]);
    return await projectFolder(await workspaceRoot(), group);
  } catch {
    return null;
  }
}

/** Runs the turn with the agent's own sign-in; the tools are called through `io.call`. */
export async function runAgentTurn(spec: AgentTurnSpec, io: AgentTurnIO): Promise<AgentTurnResult> {
  const key = spec.session && SESSION_KEY.test(spec.session.key) ? spec.session.key : null;
  if (!key) return runTurn(spec, io, null);
  const before = chats.get(key) ?? Promise.resolve();
  const turn = before.then(() => runTurn(spec, io, key), () => runTurn(spec, io, key));
  const settled = turn.catch(() => undefined);
  chats.set(key, settled);
  try {
    return await turn;
  } finally {
    if (chats.get(key) === settled) chats.delete(key);
  }
}

async function runTurn(spec: AgentTurnSpec, io: AgentTurnIO, key: string | null): Promise<AgentTurnResult> {
  const found_ = await agentBinary(spec.agent);
  const info = SUBSCRIPTION_INFO[spec.agent];
  if (!found_) throw new AgentTurnError("not_installed", `${info.label} is not on this computer. ${info.install.label} (${info.install.url}), sign in, and try again.`);
  if (io.signal.aborted) throw aborted();
  const agent = await refreshAgent(spec.agent);
  if (io.signal.aborted) throw aborted();
  if (agent?.signedIn === false) throw new AgentTurnError("signed_out", agent.problem || `${info.label} is not signed in with a subscription on this computer. Sign in from Settings → Models.`);
  // Always validate against this computer's fresh capabilities, including relayed turns.
  const levels = agent?.models.find((row) => row.id === spec.model)?.efforts ?? agent?.efforts ?? [];
  const thinking = checkEffort(spec.agent, spec.model ?? "default", spec.effort, { efforts: levels });
  if (!thinking.ok) throw new AgentTurnError("failed", thinking.message);
  spec = { ...spec, effort: thinking.send };
  // A chat keeps one folder for its session (Claude Code finds a session by the folder it began in); a
  // node's chats share its project's folder, where its apps list them together.
  const group = key && spec.session?.group ? await groupFolder(spec.session.group) : null;
  const folder = group ?? (key ? sessionFolder(key) : await mkdtemp(join(tmpdir(), "ensemble-turn-")));
  if (key) await mkdir(folder, { recursive: true });
  // The turn's own files and settings stay out of a shared folder: one folder per chat beside it.
  const own = group ? sessionFolder(key!) : folder;
  if (group) await mkdir(own, { recursive: true });
  // With its own tools, each of the agent's calls is judged by the hard floor from the turn's folder.
  const bridge = openBridge(spec.tools, io.call, spec.ownTools ? { folder } : {});
  let handedOff = false;
  const mcp: McpServer = {
    command: process.execPath,
    args: [hookScriptPath("ensemble-ask-mcp.mjs")],
    env: { ENSEMBLE_ENGINE_URL: localApiUrl(), ENSEMBLE_ASSISTANT_TURN: bridge.credential },
  };
  try {
    let files: SavedTurnFile[] = [];
    if (spec.files?.length) {
      const fetched = await saveTurnFiles(spec.files, io.readFile, join(own, "files"), io.signal);
      files = fetched.saved;
      spec = { ...spec, prompt: spec.prompt + filesNote(fetched) };
    }
    const history = spec.session?.history.trim() ?? "";
    // A new session gets the chat so far before the message; a resumed one already has it.
    // Claude Code and Codex take the instructions with every turn; the others only in a session's first message.
    const perTurn = spec.agent === "claude-code" || spec.agent === "codex";
    const position = spec.session?.position;
    const kept = key ? await findSession(key, spec.agent, spec.system, perTurn, position) : null;
    // Someone sent the session prompts of their own in the agent's app since Ensemble's last turn: the chat goes
    // on in a new session with Ensemble's own history, so none of that enters it (session-touch.ts).
    const touched = kept && kept.prompts !== undefined && ((await sessionPrompts(spec.agent, kept.id, folder).catch(() => null)) ?? kept.prompts) > kept.prompts ? kept.id : null;
    const found = touched ? null : kept;
    // A resumed session whose instructions changed hears only what changed; most of them changed: a new session.
    const update = found?.text !== null && found?.text !== undefined ? instructionsUpdate(found.text, spec.system) : "";
    const earlier = found && update !== null ? found.id : null;
    const run = (session: TurnSession) =>
      DRIVERS[spec.agent]({
        spec: { ...spec, prompt: session?.resume ? (update ? `${update}\n\n---\n\n${spec.prompt}` : spec.prompt) : history ? `${history}\n\n---\n\n${spec.prompt}` : spec.prompt },
        io,
        bin: found_.path,
        folder,
        files,
        mcp,
        session,
        own,
      });
    let result: DriverResult;
    let resumed = Boolean(earlier);
    try {
      result = await run(key ? (earlier ? { id: earlier, resume: true, ...(found?.usage ? { usage: found.usage } : {}) } : { id: randomUUID(), resume: false }) : null);
    } catch (error) {
      if (io.signal.aborted || !key) throw error;
      if (error instanceof SessionGone) {
        await forgetSession(key);
        resumed = false;
        result = await run({ id: randomUUID(), resume: false });
      } else if (error instanceof SessionUnsupported) {
        resumed = false;
        result = await run(null);
      } else throw error;
    }
    // The chat will have this message and its reply: the next turn resumes only from there.
    if (key && result.session) {
      await saveSession(key, spec.agent, result.session, spec.system, {
        ...(position === undefined ? {} : { next: position + 2 }),
        ...(group ? { folder: group } : {}),
        ...(spec.session?.keepDays ? { keepDays: spec.session.keepDays } : {}),
        perTurn,
        usage: result.totals ?? null,
        prompts: await sessionPrompts(spec.agent, result.session, folder).catch(() => null),
        ...(touched ? { retire: touched } : {}),
      });
    }
    // A turn that keeps no session leaves none in the agent either, deleted in the folder it ran in, which goes after.
    if (result.oneOff) {
      dropOneOff(spec.agent, result.oneOff, key ? undefined : folder);
      handedOff = !key;
    }
    const { session: _session, oneOff: _oneOff, totals: _totals, ...answer } = result;
    return { ...answer, resumed };
  } finally {
    bridge.close();
    // A chat's folder stays for its next turn; the files of this turn do not. A one-off's folder is dropOneOff's.
    if (!handedOff) await rm(key ? join(own, "files") : folder, { recursive: true, force: true }).catch(() => undefined);
  }
}
