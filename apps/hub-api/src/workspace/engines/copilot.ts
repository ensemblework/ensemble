/**
 * GitHub Copilot as the run's engine: the person's own `copilot`, signed in with their own
 * Copilot plan, driven through ACP (`copilot --acp`, JSON-RPC lines over stdio). Ensemble never
 * handles that sign-in; a Copilot that is not signed in says so and the run says how to fix it.
 *
 * Every tool call Copilot asks permission for (shell commands, file edits, reads outside the
 * folder, URL fetches, MCP tools) is judged by the run's rules (`judge.ts`) and answered
 * allow-once or reject-once, never "always" (that would change the person's own Copilot
 * approvals). Copilot ends its turn when a call is refused, so the refusal and its reason go back
 * as the next message and the work continues. Questions go through Ensemble's `ask_person` MCP
 * tool to Needs me (Copilot's own ask_user is off). With the run's sandbox on, Copilot's own
 * command sandbox (`--sandbox`) confines its shell commands.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { copilotBinary, copilotEnv, copilotSandboxMissing, copilotSavedSignIn } from "../../subscriptions/copilot.js";
import { GuardError } from "../guard.js";
import { appendLive, touchLive } from "../live-log.js";
import type { JobContext } from "../tools.js";
import type { EngineResult } from "./claude-code.js";
import { judgeEngineCall, type EngineAnswer, type EngineCall } from "./judge.js";
import { EngineTransientError, hookScriptPath, SIGNED_OUT, UNREACHABLE, mcpEnv, registerEngineRun, SessionGoneError, unregisterEngineRun } from "./registry.js";
import { RpcConnection } from "./rpc.js";
import { EngineTrace } from "./trace.js";

type ToolCall = { toolCallId?: string; title?: string; kind?: string; locations?: Array<{ path?: string }>; rawInput?: unknown };
type Option = { optionId: string; kind?: string; name?: string };
type ConfigOption = { id?: string; currentValue?: string; options?: Array<{ value?: string }> };

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** At most this many follow-up messages after refusals, so a run cannot loop on a refused call. */
export const REFUSAL_FOLLOW_UPS = 6;
const KEYCHAIN_LOCKED =
  "GitHub Copilot is signed in on this computer but could not read its saved sign-in: the system keychain is locked or not ready yet (common right after a restart, before anyone logs in to the desktop). Waiting, then trying again.";
const KEYCHAIN_LOCKED_FINAL =
  "GitHub Copilot is signed in on this computer but could not read its saved sign-in from the system keychain (locked, or not ready after a restart). Log in to this computer's desktop once to unlock the keychain, then Run again. Nothing was changed.";
/** Images Copilot accepts inline (its vision limit per image); anything else goes as a file link. */
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const IMAGE_BYTES = 3 * 1024 * 1024;
/** The levels `copilot --reasoning-effort` takes. */
const COPILOT_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * A Copilot tool call in the judge's terms, one call per path it touches. MCP tools are announced
 * as `<server>-<tool>` in the `tool_call` update and named by the tool alone in the permission.
 */
export function copilotCalls(toolCall: ToolCall, announced?: string | null): EngineCall[] {
  const raw = record(toolCall.rawInput);
  const locations = (toolCall.locations ?? []).map((location) => str(location.path)).filter((path): path is string => Boolean(path));
  switch (toolCall.kind) {
    case "execute": {
      const commands = Array.isArray(raw.commands) ? raw.commands.filter((item): item is string => typeof item === "string") : [];
      const command = str(raw.command) ?? (commands.length ? commands.join(" && ") : (toolCall.title ?? ""));
      return [{ tool: "Bash", input: { command } }];
    }
    case "edit":
    case "delete":
    case "move": {
      const paths = [...new Set([...locations, ...[str(raw.fileName), str(raw.path)].filter((path): path is string => Boolean(path))])];
      return paths.length ? paths.map((path) => ({ tool: "Write", input: { file_path: path } })) : [{ tool: "Write", input: {} }];
    }
    case "read":
    case "search": {
      const paths = [...new Set([...locations, ...[str(raw.path)].filter((path): path is string => Boolean(path))])];
      return paths.length ? paths.map((path) => ({ tool: "Read", input: { file_path: path } })) : [{ tool: "Read", input: {} }];
    }
    case "fetch":
      return [{ tool: "WebFetch", input: { url: str(raw.url) ?? toolCall.title ?? "" } }];
    default: {
      const name = str(announced) ?? str(toolCall.title) ?? "tool";
      if (name.startsWith("ensemble-")) return [{ tool: `mcp__ensemble__${name.slice("ensemble-".length)}`, input: raw }];
      const dash = name.indexOf("-");
      return [{ tool: dash > 0 ? `mcp__${name.slice(0, dash)}__${name.slice(dash + 1)}` : name, input: raw }];
    }
  }
}

/** The option Copilot offered for once: allow-once on yes, reject-once on no. */
function pick(options: Option[], allow: boolean): string | null {
  const wanted = allow ? "allow_once" : "reject_once";
  return options.find((option) => option.kind === wanted)?.optionId ?? options.find((option) => option.optionId === wanted)?.optionId ?? null;
}

export type Refusal = { tool: string; reason: string };

/** A permission request from Copilot, answered by the run's rules (and the person, when they must decide). */
export async function answerCopilot(
  ctx: JobContext,
  params: Record<string, unknown>,
  announced: Map<string, string>,
  refusals: Refusal[],
  judge: typeof judgeEngineCall = judgeEngineCall,
): Promise<unknown> {
  const options = (Array.isArray(params.options) ? params.options : []) as Option[];
  const toolCall = record(params.toolCall) as ToolCall;
  const calls = copilotCalls(toolCall, toolCall.toolCallId ? announced.get(toolCall.toolCallId) : null);
  let verdict: EngineAnswer = { decision: "allow" };
  for (const call of calls) {
    verdict = await judge(ctx, call);
    if (verdict.decision !== "allow") {
      const reason = verdict.message ?? "Not allowed in this run.";
      refusals.push({ tool: call.tool === "Bash" ? `the command \`${String(call.input.command ?? "").slice(0, 200)}\`` : `${call.tool} ${String(call.input.file_path ?? call.input.url ?? "")}`.trim(), reason });
      await ctx.event("tool", { name: call.tool, ok: false, summary: reason, engine: "copilot" });
      break;
    }
  }
  const optionId = pick(options, verdict.decision === "allow");
  return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
}

/** The message that carries refusals back to Copilot, which ends its turn on each one. */
export function refusalMessage(refusals: Refusal[]): string {
  return [
    "Ensemble refused these tool calls under this run's rules:",
    ...refusals.map((refusal) => `- ${refusal.tool}: ${refusal.reason}`),
    "That is the run's setting, not an error to work around. Continue the task another way within the rules, or finish and say what is left and why.",
  ].join("\n");
}

/** Attached originals as ACP content: images inline where the model takes them, other files as links. */
export async function attachmentBlocks(paths: string[], vision: boolean): Promise<Array<Record<string, unknown>>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const path of paths) {
    const mimeType = IMAGE_TYPES[extname(path).toLowerCase()];
    if (vision && mimeType) {
      const size = await stat(path).then((info) => info.size, () => Number.POSITIVE_INFINITY);
      if (size <= IMAGE_BYTES) {
        blocks.push({ type: "image", mimeType, data: (await readFile(path)).toString("base64") });
        continue;
      }
    }
    blocks.push({ type: "resource_link", uri: pathToFileURL(path).href, name: basename(path) });
  }
  return blocks;
}

/** Sets a session option Copilot offers; returns the options as Copilot reports them after. */
async function setOption(rpc: RpcConnection, sessionId: string, configId: string, value: string): Promise<ConfigOption[]> {
  const answer = (await rpc.request("session/set_config_option", { sessionId, configId, value })) as { configOptions?: ConfigOption[] };
  return Array.isArray(answer.configOptions) ? answer.configOptions : [];
}

export async function runCopilot(
  ctx: JobContext,
  options: {
    prompt: string;
    model?: string | null;
    effort?: string | null;
    context?: string | null;
    attachments?: string[];
    vision?: boolean;
    stopCheck: () => Promise<void>;
    resume?: string | null;
    chat?: boolean;
    trace?: EngineTrace;
    /** The thinking levels the model offers, as the computer's check listed them. */
    efforts?: string[];
    /** The model's long context window in tokens, as listed: the run notes when Copilot used less. */
    longWindow?: number | null;
  },
): Promise<EngineResult> {
  const copilot = await copilotBinary();
  if (!copilot) throw new Error("GitHub Copilot CLI is not on this computer (the `copilot` command). Install it (npm install -g @github/copilot), run `copilot login`, and Run again.");
  if (ctx.sandboxed) {
    const missing = await copilotSandboxMissing();
    if (missing.length) {
      throw new GuardError(
        `GitHub Copilot's command sandbox cannot run on this computer (missing: ${missing.join(", ")}). Install ${missing.join(", ")}, or turn the sandbox off for this run: Ensemble still checks every command, edit, outside read and fetch Copilot asks to make.`,
      );
    }
  }
  const credential = registerEngineRun(ctx);
  const ensembleMcp = mcpEnv(credential, options.chat === true);
  // The run's ask_person (and Chat's board tools) server. Copilot's ACP takes only http servers
  // from the client, so it comes in as additional config; the file holds the run's ask-only secret.
  const mcpFile = join(tmpdir(), `ensemble-copilot-${ctx.job.id}-${randomBytes(6).toString("hex")}.json`);
  await writeFile(
    mcpFile,
    JSON.stringify({ mcpServers: { ensemble: { type: "local", command: process.execPath, args: [hookScriptPath("ensemble-ask-mcp.mjs")], env: ensembleMcp, tools: ["*"] } } }),
    { mode: 0o600 },
  );
  const env = copilotEnv(ensembleMcp);
  const model = str(options.model) && options.model !== "default" ? options.model!.trim() : null;
  const effort = str(options.effort) && options.effort !== "default" ? options.effort!.trim() : null;
  const effortFlag = effort && COPILOT_EFFORTS.has(effort) && (!options.efforts?.length || options.efforts.includes(effort));
  const args = [
    "--acp",
    "--no-auto-update",
    // Questions go to Needs me through ask_person, never Copilot's own prompt.
    "--no-ask-user",
    "--additional-mcp-config",
    `@${mcpFile}`,
    "--allow-tool",
    "ensemble",
    // The temp folder is outside the work folder: reads there are judged like any other.
    "--disallow-temp-dir",
    ...(ctx.sandboxed ? ["--sandbox"] : []),
    // Model, thinking level and context window are set as Copilot starts: switching the model over ACP
    // afterwards puts the session back on that model's standard context window.
    ...(model ? ["--model", model] : []),
    ...(effortFlag ? ["--reasoning-effort", effort!] : []),
    ...(options.context === "long_context" ? ["--context", "long_context"] : []),
  ];
  const child: ChildProcessWithoutNullStreams = spawn(copilot, args, { cwd: ctx.root, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
  child.stdin.on("error", () => undefined);
  const rpc = new RpcConnection(
    (line) => {
      if (child.stdin.writable) child.stdin.write(line);
    },
    { jsonrpc: true },
  );
  const trace = options.trace ?? new EngineTrace(ctx, "copilot");
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
  // The context window as Copilot last reported it (tokens in use, window size).
  const usage: { window: { used: number; size: number } | null } = { window: null };
  const announced = new Map<string, string>();
  const refusals: Refusal[] = [];
  rpc.onRequest = async (method, params) => {
    if (method === "session/request_permission") return answerCopilot(ctx, params, announced, refusals);
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
    void (async () => {
      if (update.sessionUpdate === "agent_message_chunk" && single?.type === "text" && single.text) {
        await flushThought();
        reply += single.text;
        appendLive(ctx.job.id, single.text);
      } else if (update.sessionUpdate === "agent_thought_chunk" && single?.type === "text" && single.text) {
        thought += single.text;
      } else if (update.sessionUpdate === "tool_call") {
        const flushed = flushThought();
        result.toolCalls += 1;
        const summary = (update.title ?? update.kind ?? "tool").slice(0, 160);
        const started = trace.toolStart(update.toolCallId ?? "", update.kind ?? "tool", update.rawInput ?? {}, summary);
        appendLive(ctx.job.id, `\n· ${summary}\n`);
        await ctx.event("tool", { name: update.kind ?? "tool", ok: true, summary, engine: "copilot" });
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
    void rpc.receive(line);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000);
  });
  const exited = new Promise<number>((resolve) => child.once("close", (code) => resolve(code ?? 1)));
  void exited.then(() => rpc.close(`GitHub Copilot stopped. ${stderr.trim().split("\n").slice(-3).join(" | ")}`.trim()));
  const kill = () => {
    if (child.exitCode !== null || !child.pid) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  };
  const stop = () => {
    if (sessionId) rpc.notify("session/cancel", { sessionId });
    setTimeout(kill, 3000).unref();
  };
  ctx.signal.addEventListener("abort", stop, { once: true });
  const signedOut = async (error: Error): Promise<never> => {
    if (!SIGNED_OUT.test(error.message)) {
      if (UNREACHABLE.test(error.message)) throw new EngineTransientError(`GitHub Copilot could not reach GitHub: ${error.message.slice(0, 200)}`);
      throw error;
    }
    // Copilot answers "Authentication required" both when signed out and when the keychain holding its sign-in cannot be read.
    if (await copilotSavedSignIn()) throw new EngineTransientError(KEYCHAIN_LOCKED, KEYCHAIN_LOCKED_FINAL);
    throw new Error("GitHub Copilot CLI is not signed in on this computer. Run `copilot login` there (or press Sign in under Settings → Models), then Run again.");
  };
  try {
    await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "ensemble", version: "1" } });
    let session: Record<string, unknown>;
    if (options.resume) {
      // The same Copilot session (a chat's next message, or a run carrying on), so it remembers the conversation.
      replaying = true;
      session = await rpc
        .request("session/load", { sessionId: options.resume, cwd: ctx.root, mcpServers: [] })
        .then((loaded) => ({ ...loaded, sessionId: options.resume }))
        .catch(async (error: Error) => {
          if (SIGNED_OUT.test(error.message) || UNREACHABLE.test(error.message)) await signedOut(error);
          throw new SessionGoneError(`Copilot could not reopen the session: ${error.message}`);
        })
        .finally(() => {
          replaying = false;
        });
    } else {
      session = await rpc.request("session/new", { cwd: ctx.root, mcpServers: [] }).catch(signedOut);
    }
    sessionId = typeof session.sessionId === "string" ? session.sessionId : null;
    if (!sessionId) throw new Error("GitHub Copilot did not start a session.");
    let config = Array.isArray(session.configOptions) ? (session.configOptions as ConfigOption[]) : [];
    const current = config.find((option) => option.id === "model")?.currentValue ?? null;
    if (model && model !== current) {
      const offered = config.find((option) => option.id === "model")?.options?.some((option) => option.value === model);
      if (config.length && !offered) throw new Error(`GitHub Copilot does not offer ${model} on this plan. Pick another model.`);
      config = await setOption(rpc, sessionId, "model", model);
      if (options.context === "long_context") await ctx.event("engine_note", { note: `GitHub Copilot did not start on ${model}; after switching to it, the run may use its standard context window.` });
    }
    result.model = model ?? current;
    if (effort) {
      const levels = config.find((option) => option.id === "reasoning_effort")?.options?.map((option) => option.value) ?? [];
      const now = config.find((option) => option.id === "reasoning_effort")?.currentValue ?? null;
      if (now !== effort && levels.includes(effort)) await setOption(rpc, sessionId, "reasoning_effort", effort);
      else if (now !== effort) await ctx.event("engine_note", { note: `${result.model ?? "This model"} has no ${effort} thinking level on Copilot; it runs at its default.` });
    }
    await ctx.event("engine", { engine: "copilot", model: result.model, effort, context: options.context === "long_context" ? "long_context" : "default", session: sessionId });
    await ctx.progress("GitHub Copilot started");
    let prompt: Array<Record<string, unknown>> = [{ type: "text", text: options.prompt }, ...(await attachmentBlocks(options.attachments ?? [], options.vision !== false))];
    for (let round = 0; ; round += 1) {
      refusals.length = 0;
      const done = (await rpc.request("session/prompt", { sessionId, prompt })) as { stopReason?: string; usage?: { inputTokens?: number; outputTokens?: number } };
      result.turns += 1;
      result.tokensIn += done.usage?.inputTokens ?? 0;
      result.tokensOut += done.usage?.outputTokens ?? 0;
      await options.stopCheck();
      if (ctx.signal.aborted) throw new DOMException("Stopped", "AbortError");
      if (done.stopReason === "refusal") throw new Error("GitHub Copilot refused the task.");
      if (!refusals.length || round >= REFUSAL_FOLLOW_UPS) break;
      // A refused call ends Copilot's turn: send the reasons and let it carry on.
      reply += "\n";
      prompt = [{ type: "text", text: refusalMessage(refusals) }];
    }
    if (usage.window) {
      await ctx.event("engine_context", { used: usage.window.used, size: usage.window.size });
      // The window Copilot reports is the one it used: say so when it is not the long one chosen.
      if (options.context === "long_context" && options.longWindow && usage.window.size < options.longWindow * 0.95) {
        await ctx.event("engine_note", { note: `GitHub Copilot ran with a ${Math.round(usage.window.size / 1000)}K context window, not the ${Math.round(options.longWindow / 1000)}K long window chosen.` });
      }
    }
    await flushThought();
    // Copilot notes each refused call in its reply; the refusals are already on the run's log.
    result.text = reply.replace(/(^|\n)Info: Operation cancelled by user\.?[ \t]*(?=\n|$)/g, "$1").trim();
    return result;
  } catch (error) {
    if (ctx.signal.aborted) throw new DOMException("Stopped", "AbortError");
    throw error;
  } finally {
    ctx.signal.removeEventListener("abort", stop);
    unregisterEngineRun(ctx.job.id);
    lines.close();
    await rm(mcpFile, { force: true }).catch(() => undefined);
    if (child.exitCode === null) {
      child.stdin.end();
      setTimeout(kill, 2000).unref();
    }
  }
}
