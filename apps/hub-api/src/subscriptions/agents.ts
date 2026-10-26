/**
 * One assistant turn run by the person's own agent on this computer, signed in with their own
 * subscription (docs/30 §8). The agent is told it is the Ensemble assistant (the system prompt
 * Ensemble built for the turn) and gets Ensemble's tools and nothing else: no shell, no files, no
 * web of its own. Its tool calls go through the bridge (bridge.ts) to wherever the turn's data
 * is; writes there wait for Apply exactly as with a model key. Files attached to the person's
 * message are downloaded into the turn's folder and given to the agent in its own input form
 * (turn-files.ts).
 *
 * Claude Code: `claude -p` with `--system-prompt-file`, `--tools ""`, only Ensemble's MCP server,
 * the person's own settings (how their Claude Code signs in), no saved session.
 * Codex: `codex app-server`, an ephemeral thread with Ensemble's instructions as its base
 * instructions, a read-only sandbox, no environment, every approval declined.
 * Cursor's agent: ACP, every permission refused except Ensemble's own tools.
 * Copilot CLI: `copilot -p`, shell, file writes and URL fetches denied, no built-in MCP servers.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { checkEffort, claudeLaunch, SUBSCRIPTION_INFO, type AcpEngine, type SubscriptionProvider } from "@ensemble/shared-types";
import { acpCalls, ACP_AGENTS, configChoices, type ConfigOption, optionValues, pickOption } from "../workspace/engines/acp.js";
import { antigravityAuthLink } from "./antigravity.js";
import { RpcConnection } from "../workspace/engines/rpc.js";
import { hookScriptPath, localApiUrl } from "../workspace/engines/registry.js";
import { openBridge, type ToolAnswer, type ToolSpec } from "./bridge.js";
import { agentBinary, agentEnv, refreshAgent } from "./detect.js";
import { copilotEnv } from "./copilot.js";
import { copilotOutput } from "./copilot-output.js";
import { acpPrompt, acpPromptCaps, claudeUserMessage, codexInput, copilotFiles, filesNote, saveTurnFiles, type SavedTurnFile, type TurnFile } from "./turn-files.js";

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
};

export type AgentTurnResult = { text: string; model: string | null; tokensIn: number | null; tokensOut: number | null; costUsd: number | null };

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

type Driver = (input: { spec: AgentTurnSpec; io: AgentTurnIO; bin: string; folder: string; mcp: McpServer; files: SavedTurnFile[] }) => Promise<AgentTurnResult>;

const chosen = (value: string | null | undefined): string | null => (value && value !== "default" ? value : null);

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
export function claudeArgs(input: { systemFile: string; mcpFile: string; maxTurns: number; model: string | null; effort: string | null; context?: "default" | "long_context" | null; files?: boolean }): string[] {
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
    // None of Claude Code's own tools: no shell, files or web. Ensemble's tools come from its MCP server.
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    input.mcpFile,
    "--allowedTools",
    "mcp__ensemble",
    "--permission-mode",
    "default",
    // The person's own settings, where their Claude Code keeps how it signs in; never a folder's.
    // Their MCP servers stay out (--strict-mcp-config), and Ensemble's own hook steps aside (ENSEMBLE_RUN).
    "--setting-sources",
    "user",
    "--no-session-persistence",
    "--max-turns",
    String(input.maxTurns),
    ...(launch.model ? ["--model", launch.model] : []),
    ...(launch.effort ? ["--effort", launch.effort] : []),
  ];
}

const runClaude: Driver = async ({ spec, io, bin, folder, mcp, files }) => {
  const systemFile = join(folder, "system.md");
  const mcpFile = join(folder, "mcp.json");
  await writeFile(systemFile, spec.system, "utf8");
  await writeFile(mcpFile, JSON.stringify({ mcpServers: { ensemble: { type: "stdio", ...mcp } } }), "utf8");
  const child = spawn(bin, claudeArgs({ systemFile, mcpFile, maxTurns: spec.maxTurns, model: spec.model, effort: spec.effort, context: spec.context ?? null, files: files.length > 0 }), {
    cwd: folder,
    // A tool call may wait on a slow connected app; Claude Code must not give up first.
    env: agentEnv({ ...mcp.env, MCP_TOOL_TIMEOUT: "600000", ENSEMBLE_RUN: "assistant-turn" }),
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
    if (failure) throw agentProblem(spec.agent, failure);
    if (code !== 0 || !finished) throw agentProblem(spec.agent, stderr.trim().split("\n").slice(-6).join(" ") || `exit ${code}`);
    return result;
  } finally {
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

const runCodex: Driver = async ({ spec, io, bin, folder, mcp, files }) => {
  const child = spawn(bin, ["app-server"], { cwd: folder, env: agentEnv(mcp.env), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
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
  server.onRequest = (method, params) => answerCodexTurn(method, params);
  server.onNotification = (method, params) => {
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
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: "read-only",
      baseInstructions: spec.system,
      ephemeral: true,
      serviceName: "ensemble",
      ...(model ? { model } : {}),
      config: {
        projects: { [folder]: { trust_level: "untrusted" } },
        mcp_servers: { ensemble: { command: mcp.command, args: mcp.args, env: mcp.env, tool_timeout_sec: 600 } },
      },
    };
    // No environment: Codex's own shell and file tools are not there at all. An older Codex that
    // does not know the field starts without it, and every approval is still declined.
    const thread = (await server.request("thread/start", { ...settings, environments: [] }).catch((error: Error) => {
      if (/environments|unknown field/i.test(error.message)) return server.request("thread/start", settings);
      throw error;
    })) as { thread?: { id?: string }; model?: string };
    threadId = thread.thread?.id ?? null;
    if (!threadId) throw agentProblem("codex", "it did not start a conversation");
    result.model = thread.model ?? model;
    const effort = chosen(spec.effort);
    const turn = (await server.request("turn/start", {
      threadId,
      input: codexInput(spec.prompt, files),
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      ...(effort ? { effort } : {}),
    })) as { turn?: { id?: string } };
    turnId = turn.turn?.id ?? null;
    const done = await turnDone;
    if (io.signal.aborted || done.status === "interrupted") throw aborted();
    if (done.status === "failed") throw agentProblem("codex", done.error ?? "the turn failed");
    return result;
  } catch (error) {
    if (io.signal.aborted) throw aborted();
    if (error instanceof AgentTurnError) throw error;
    throw agentProblem("codex", error instanceof Error ? error.message : String(error));
  } finally {
    io.signal.removeEventListener("abort", stop);
    stopChild(child);
  }
};

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

const runCursor: Driver = async ({ spec, io, bin, folder, mcp, files }) => {
  const model = chosen(spec.model);
  const child = spawn(bin, ["--sandbox", "enabled", "--workspace", folder, ...(model ? ["--model", model] : []), "acp"], {
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
  rpc.onRequest = async (method, params) => answerCursorTurn(method, params);
  rpc.onNotification = (method, params) => {
    if (method !== "session/update") return;
    const update = (params.update ?? {}) as { sessionUpdate?: string; content?: { type?: string; text?: string } };
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && update.content.text) {
      reply += update.content.text;
      io.onDelta(update.content.text);
    }
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
    const caps = acpPromptCaps(await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }));
    await rpc.request("authenticate", { methodId: "cursor_login" }).catch(() => undefined);
    const session = await rpc.request("session/new", {
      cwd: folder,
      mcpServers: [{ name: "ensemble", command: mcp.command, args: mcp.args, env: Object.entries(mcp.env).map(([name, value]) => ({ name, value })) }],
    });
    sessionId = typeof session.sessionId === "string" ? session.sessionId : null;
    if (!sessionId) throw agentProblem("cursor-agent", "it did not start a session");
    // ACP has no system prompt: Ensemble's instructions lead the message.
    const done = (await rpc.request("session/prompt", { sessionId, prompt: acpPrompt(`${spec.system}\n\n---\n\n${spec.prompt}`, files, caps) })) as { stopReason?: string };
    if (io.signal.aborted || done.stopReason === "cancelled") throw aborted();
    if (done.stopReason === "refusal") throw agentProblem("cursor-agent", "it refused the request");
    return { text: reply.trim(), model, tokensIn: null, tokensOut: null, costUsd: null };
  } catch (error) {
    if (io.signal.aborted) throw aborted();
    if (error instanceof AgentTurnError) throw error;
    throw agentProblem("cursor-agent", error instanceof Error ? error.message : String(error));
  } finally {
    io.signal.removeEventListener("abort", stop);
    stopChild(child);
  }
};

/** How long Copilot CLI's prompt may be. Windows caps a command line near 32,000 characters. */
const copilotLimit = (platform: NodeJS.Platform = process.platform) => (platform === "win32" ? 28_000 : 200_000);

/** The prompt with the attached files' text after it, the text cut to the room the command line has (exported for tests). */
export function copilotPrompt(head: string, sections: string[], platform?: NodeJS.Platform): string {
  if (!sections.length) return head;
  const text = sections.join("\n\n");
  const room = copilotLimit(platform) - head.length - 2;
  if (text.length <= room) return `${head}\n\n${text}`;
  const cut = "\n[The rest of the attached files' text did not fit in the command line.]";
  return room > cut.length ? `${head}\n\n${text.slice(0, room - cut.length)}${cut}` : `${head}${cut}`;
}

/** The arguments for Copilot CLI (exported for tests). */
export function copilotArgs(input: { prompt: string; mcpFile: string; model: string | null; effort: string | null; context?: string | null; platform?: NodeJS.Platform; attachments?: string[] }): string[] {
  const limit = copilotLimit(input.platform);
  const prompt = input.prompt.length > limit ? input.prompt.slice(input.prompt.length - limit) : input.prompt;
  return [
    "-p",
    prompt,
    "--stream",
    "on",
    "--output-format",
    "json",
    // Prompt mode needs tools allowed up front; the denials win over it.
    "--allow-all-tools",
    "--deny-tool",
    "shell",
    "--deny-tool",
    "write",
    "--deny-tool",
    "url",
    "--disable-builtin-mcps",
    // Nobody can answer Copilot's own question prompt here; Ensemble's tools carry the conversation.
    "--no-ask-user",
    "--no-auto-update",
    "--additional-mcp-config",
    `@${input.mcpFile}`,
    ...(input.attachments ?? []).flatMap((path) => ["--attachment", path]),
    ...(chosen(input.model) ? ["--model", input.model!] : []),
    ...(chosen(input.effort) ? ["--reasoning-effort", input.effort!] : []),
    ...(input.context === "long_context" ? ["--context", "long_context"] : []),
  ];
}

const runCopilot: Driver = async ({ spec, io, bin, folder, mcp, files }) => {
  const mcpFile = join(folder, "mcp.json");
  await writeFile(mcpFile, JSON.stringify({ mcpServers: { ensemble: { type: "local", ...mcp, tools: ["*"] } } }), "utf8");
  const { attachments, sections } = copilotFiles(files);
  const prompt = copilotPrompt(`${spec.system}\n\n---\n\n${spec.prompt}`, sections);
  const child = spawn(bin, copilotArgs({ prompt, mcpFile, model: spec.model, effort: spec.effort, context: spec.context ?? null, attachments }), {
    cwd: folder,
    env: copilotEnv(mcp.env),
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const stop = () => stopChild(child);
  io.signal.addEventListener("abort", stop, { once: true });
  const output = copilotOutput(chosen(spec.model), io.onDelta);
  let stderr = "";
  createInterface({ input: child.stdout }).on("line", line => output.line(line));
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000);
  });
  try {
    const code = await new Promise<number>((done) => child.once("close", (value) => done(value ?? 1)));
    if (io.signal.aborted) throw aborted();
    if (code !== 0) throw agentProblem("copilot-cli", stderr.trim().split("\n").slice(-6).join(" ") || `exit ${code}`);
    return output.finish();
  } finally {
    io.signal.removeEventListener("abort", stop);
    stop();
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
  async ({ spec, io, folder, mcp, files }) => {
    const model = chosen(spec.model);
    const launch = await ACP_AGENTS[id].launch({ root: folder, sandboxed: false, trusted: false, model, extraEnv: mcp.env });
    if (!launch) throw new AgentTurnError("not_installed", `${SUBSCRIPTION_INFO[id].label} is not on this computer.`);
    const child = spawn(launch.program, launch.args, { cwd: folder, env: launch.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    child.stdin.on("error", () => undefined);
    const rpc = new RpcConnection((line) => child.stdin.writable && void child.stdin.write(line), { jsonrpc: true });
    let reply = "";
    let stderr = "";
    let sessionId: string | null = null;
    rpc.onRequest = async (method, params) => answerAcpTurn(method, params);
    rpc.onNotification = (method, params) => {
      if (method !== "session/update") return;
      const update = (params.update ?? {}) as { sessionUpdate?: string; content?: { type?: string; text?: string } };
      if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && update.content.text) {
        reply += update.content.text;
        io.onDelta(update.content.text);
      }
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
      const caps = acpPromptCaps(
        await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "ensemble", version: "1" }, ...(launch.initializeMeta ? { _meta: launch.initializeMeta } : {}) }),
      );
      if (launch.authMethod) await rpc.request("authenticate", { methodId: launch.authMethod });
      const session = await rpc.request("session/new", {
        cwd: folder,
        mcpServers: [{ name: "ensemble", command: mcp.command, args: mcp.args, env: Object.entries(mcp.env).map(([name, value]) => ({ name, value })) }],
      });
      sessionId = typeof session.sessionId === "string" ? session.sessionId : null;
      if (!sessionId) throw agentProblem(id, "it did not start a session");
      const config = Array.isArray(session.configOptions) ? (session.configOptions as ConfigOption[]) : [];
      const { model: modelOption, thought } = configChoices(config);
      if (model && modelOption && optionValues(modelOption).includes(model) && modelOption.currentValue !== model) await rpc.request("session/set_config_option", { sessionId, configId: modelOption.id, value: model });
      if (spec.effort && thought && optionValues(thought).includes(spec.effort)) await rpc.request("session/set_config_option", { sessionId, configId: thought.id, value: spec.effort });
      // ACP has no system prompt: Ensemble's instructions lead the message.
      const done = (await rpc.request("session/prompt", { sessionId, prompt: acpPrompt(`${spec.system}\n\n---\n\n${spec.prompt}`, files, caps) })) as { stopReason?: string; usage?: { inputTokens?: number; outputTokens?: number } };
      if (io.signal.aborted || done.stopReason === "cancelled") throw aborted();
      if (done.stopReason === "refusal") throw agentProblem(id, "it refused the request");
      return { text: reply.trim(), model: model ?? modelOption?.currentValue ?? null, tokensIn: done.usage?.inputTokens ?? null, tokensOut: done.usage?.outputTokens ?? null, costUsd: null };
    } catch (error) {
      if (io.signal.aborted) throw aborted();
      if (error instanceof AgentTurnError) throw error;
      throw agentProblem(id, error instanceof Error ? error.message : String(error));
    } finally {
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
};

/** Runs the turn with the agent's own sign-in; the tools are called through `io.call`. */
export async function runAgentTurn(spec: AgentTurnSpec, io: AgentTurnIO): Promise<AgentTurnResult> {
  const found = await agentBinary(spec.agent);
  const info = SUBSCRIPTION_INFO[spec.agent];
  if (!found) throw new AgentTurnError("not_installed", `${info.label} is not on this computer. ${info.install.label} (${info.install.url}), sign in, and try again.`);
  if (io.signal.aborted) throw aborted();
  const agent = await refreshAgent(spec.agent);
  if (io.signal.aborted) throw aborted();
  if (agent?.signedIn === false) throw new AgentTurnError("signed_out", agent.problem || `${info.label} is not signed in with a subscription on this computer. Sign in from Settings → Models.`);
  // Always validate against this computer's fresh capabilities, including relayed turns.
  const levels = agent?.models.find((row) => row.id === spec.model)?.efforts ?? agent?.efforts ?? [];
  const thinking = checkEffort(spec.agent, spec.model ?? "default", spec.effort, { efforts: levels });
  if (!thinking.ok) throw new AgentTurnError("failed", thinking.message);
  spec = { ...spec, effort: thinking.send };
  const folder = await mkdtemp(join(tmpdir(), "ensemble-turn-"));
  const bridge = openBridge(spec.tools, io.call);
  const mcp: McpServer = {
    command: process.execPath,
    args: [hookScriptPath("ensemble-ask-mcp.mjs")],
    env: { ENSEMBLE_ENGINE_URL: localApiUrl(), ENSEMBLE_ASSISTANT_TURN: bridge.credential },
  };
  try {
    let files: SavedTurnFile[] = [];
    if (spec.files?.length) {
      const fetched = await saveTurnFiles(spec.files, io.readFile, join(folder, "files"), io.signal);
      files = fetched.saved;
      spec = { ...spec, prompt: spec.prompt + filesNote(fetched) };
    }
    return await DRIVERS[spec.agent]({ spec, io, bin: found.path, folder, mcp, files });
  } finally {
    bridge.close();
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}
