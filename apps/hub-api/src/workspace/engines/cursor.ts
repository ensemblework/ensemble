/**
 * Cursor's agent as the run's engine: the person's own `cursor-agent`, signed in with their own
 * Cursor account (`agent login`), driven through ACP, the Agent Client Protocol (`cursor-agent
 * acp`, JSON-RPC over stdio). Ensemble never handles that sign-in: it asks the agent to use the
 * login it already has (`authenticate` with `cursor_login`) and, without one, says how to sign in.
 *
 * Cursor keeps its own sandbox (`--sandbox enabled` with the run's sandbox on). Every tool call
 * Cursor asks permission for is judged by the run's rules (`judge.ts`) and answered allow-once or
 * reject-once, never "always" (that would change the person's own Cursor allowlist). Cursor's
 * questions (`cursor/ask_question`) and Ensemble's `ask_person` MCP tool reach Needs me.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { appendLive, touchLive } from "../live-log.js";
import { hostExecutable } from "../policy.js";
import { askPerson, type JobContext } from "../tools.js";
import type { EngineResult } from "./claude-code.js";
import { ACP_CLIENT_CAPABILITIES, answerElicitation } from "./elicitation.js";
import { judgeEngineCall, type EngineAnswer } from "./judge.js";
import { hookScriptPath, mcpEnv, registerEngineRun, SessionGoneError, unregisterEngineRun } from "./registry.js";
import { EngineTrace } from "./trace.js";
import { RpcConnection } from "./rpc.js";

/** Keys in Ensemble's own environment that must not stand in for the person's Cursor sign-in. */
const KEY_VARIABLES = ["CURSOR_API_KEY"];

export async function cursorAgentBinary(): Promise<string | null> {
  return (await hostExecutable("cursor-agent").catch(() => null)) ?? null;
}

type ToolCall = { toolCallId?: string; title?: string; kind?: string; content?: Array<{ type?: string; path?: string; content?: { text?: string } }>; locations?: Array<{ path?: string }>; rawInput?: Record<string, unknown> | null };
type Option = { optionId: string; kind?: string; name?: string };

/** What a Cursor tool call is, in the judge's terms (Cursor titles a command `` `npm test` `` and an edit "Edit `path`"). */
export function cursorCall(toolCall: ToolCall): { tool: string; input: Record<string, unknown> } {
  const title = toolCall.title ?? "";
  const quoted = /`((?:[^`\\]|\\.)*)`/.exec(title)?.[1]?.replace(/\\`/g, "`");
  if (toolCall.kind === "execute") {
    const command = typeof toolCall.rawInput?.command === "string" ? toolCall.rawInput.command : quoted ?? title.replace(/^`|`$/g, "");
    return { tool: "Bash", input: { command } };
  }
  if (toolCall.kind === "edit" || toolCall.kind === "delete" || toolCall.kind === "move") {
    const path = toolCall.content?.find((part) => part.type === "diff" && part.path)?.path ?? toolCall.locations?.[0]?.path ?? quoted ?? title.replace(/^(Write|Edit|Delete)\s+/, "");
    return { tool: "Write", input: { file_path: path } };
  }
  if (toolCall.kind === "read" || toolCall.kind === "search") {
    const path = toolCall.locations?.[0]?.path ?? quoted;
    return { tool: "Read", input: path ? { file_path: path } : {} };
  }
  if (toolCall.kind === "fetch") return { tool: "WebFetch", input: { url: typeof toolCall.rawInput?.url === "string" ? toolCall.rawInput.url : title } };
  // MCP tools are titled "<server>: <tool>".
  const mcp = /^([^:]+):\s*(.+)$/.exec(title);
  if (mcp) return { tool: `mcp__${mcp[1]!.trim()}__${mcp[2]!.trim()}`, input: {} };
  return { tool: title || "tool", input: {} };
}

/** The option Cursor offered for once: allow-once on yes, reject-once on no. */
function pick(options: Option[], allow: boolean): string | null {
  const wanted = allow ? "allow_once" : "reject_once";
  return options.find((option) => option.kind === wanted)?.optionId ?? options.find((option) => option.optionId === (allow ? "allow-once" : "reject-once"))?.optionId ?? null;
}

/** A request from Cursor, answered by the run's rules (and the person, when they must decide). */
export async function answerCursor(
  ctx: JobContext,
  method: string,
  params: Record<string, unknown>,
  judge: typeof judgeEngineCall = judgeEngineCall,
  ask: typeof askPerson = askPerson,
): Promise<unknown> {
  if (method === "session/request_permission") {
    const options = (Array.isArray(params.options) ? params.options : []) as Option[];
    const call = cursorCall((params.toolCall ?? {}) as ToolCall);
    let verdict: EngineAnswer;
    // A single-choice question Cursor asks as a permission (when ask_question is not supported): the person picks.
    const question = options.some((option) => option.optionId === "__ask_question_skip__");
    if (question) {
      const labels = options.filter((option) => option.optionId !== "__ask_question_skip__").map((option) => option.name ?? option.optionId);
      const title = (params.toolCall as ToolCall | undefined)?.title ?? "Cursor has a question";
      const recommended = labels[0] ?? null;
      if (ctx.job.unattended) return { outcome: { outcome: "selected", optionId: options[0]!.optionId } };
      const answer = await ask(ctx, { event: "question", toolName: "question", title, options: labels, allowCustom: false, recommended });
      const chosen = options.find((option) => (option.name ?? option.optionId) === answer.answer);
      return chosen ? { outcome: { outcome: "selected", optionId: chosen.optionId } } : { outcome: { outcome: "selected", optionId: "__ask_question_skip__" } };
    }
    verdict = await judge(ctx, call);
    if (verdict.decision !== "allow") await ctx.event("tool", { name: call.tool, ok: false, summary: verdict.message ?? "Refused", engine: "cursor" });
    const optionId = pick(options, verdict.decision === "allow");
    return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
  }
  if (method === "cursor/ask_question") {
    const questions = (Array.isArray(params.questions) ? params.questions : []) as Array<{ id: string; prompt: string; options?: Array<{ id: string; label: string }>; allowMultiple?: boolean }>;
    const answers: Array<{ questionId: string; selectedOptionIds: string[] }> = [];
    for (const item of questions) {
      const options = item.options ?? [];
      const labels = options.map((option) => option.label);
      const recommended = labels.find((label) => /\(recommended\)/i.test(label)) ?? labels[0] ?? null;
      if (ctx.job.unattended) {
        if (!recommended) return { outcome: { outcome: "skipped", reason: "Nobody is watching this run. Decide yourself and list the decision in your summary." } };
        answers.push({ questionId: item.id, selectedOptionIds: [options[labels.indexOf(recommended)]!.id] });
        ctx.decisions?.push({ question: item.prompt, options: labels, recommended });
        await ctx.event("decision", { question: item.prompt, options: labels, recommended, by: "unattended" });
        continue;
      }
      const answer = await ask(ctx, { event: "question", toolName: "question", title: item.prompt, options: labels, allowCustom: true, recommended });
      if (answer.decision !== "allow" || !answer.answer) return { outcome: { outcome: "skipped", reason: "The person did not answer. Make a sensible choice, say which in your summary, and continue." } };
      const chosen = options.find((option) => option.label === answer.answer);
      // A typed answer is not one of Cursor's options: it goes back as the reason, in the person's words.
      if (!chosen) return { outcome: { outcome: "skipped", reason: `The person answered: ${answer.answer}` } };
      answers.push({ questionId: item.id, selectedOptionIds: [chosen.id] });
    }
    return { outcome: { outcome: "answered", answers } };
  }
  // A question as a form (ACP's `elicitation/create`), asked like `ask_person`.
  if (method === "elicitation/create") return answerElicitation(ctx, params, ask);
  throw Object.assign(new Error(`${method} is not handled by Ensemble.`), { code: -32601 });
}

export async function runCursor(
  ctx: JobContext,
  options: { prompt: string; model?: string | null; stopCheck: () => Promise<void>; resume?: string | null; chat?: boolean; trace?: EngineTrace },
): Promise<EngineResult> {
  const agent = await cursorAgentBinary();
  if (!agent) throw new Error("Cursor's agent is not on this computer (the `cursor-agent` command). Install it (curl https://cursor.com/install -fsS | bash), run `agent login`, and Run again.");
  const credential = registerEngineRun(ctx);
  const ensembleMcp = mcpEnv(credential, options.chat === true);
  const env: NodeJS.ProcessEnv = { ...process.env, ...ctx.secretEnv, ...ensembleMcp };
  for (const key of KEY_VARIABLES) delete env[key];
  delete env.ENSEMBLE_DESKTOP_TOKEN;
  delete env.ENSEMBLE_INTERNAL_TOKEN;
  const args = ["--sandbox", ctx.sandboxed ? "enabled" : "disabled", "--workspace", ctx.root, ...(options.model && options.model !== "default" ? ["--model", options.model] : []), "acp"];
  const child: ChildProcessWithoutNullStreams = spawn(agent, args, { cwd: ctx.root, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
  child.stdin.on("error", () => undefined);
  const rpc = new RpcConnection(
    (line) => {
      if (child.stdin.writable) child.stdin.write(line);
    },
    { jsonrpc: true },
  );
  // The caller may hold the trace, to close it if the run stops before the engine returns.
  const trace = options.trace ?? new EngineTrace(ctx, "cursor");
  const result: EngineResult = { text: "", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0, model: options.model && options.model !== "default" ? options.model : null, costUsd: null, trace };
  // Cursor streams its thinking in chunks: kept until the next tool call or message, then one step.
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
  // Reopening a chat session replays its history as updates: those are not this turn's reply.
  let replaying = false;
  rpc.onRequest = (method, params) => answerCursor(ctx, method, params);
  rpc.onNotification = (method, params) => {
    if (method !== "session/update" || replaying) return;
    const update = (params.update ?? {}) as {
      sessionUpdate?: string;
      content?: { type?: string; text?: string } | Array<{ content?: { type?: string; text?: string } }>;
      title?: string;
      kind?: string;
      toolCallId?: string;
      status?: string;
      rawInput?: unknown;
      rawOutput?: unknown;
    };
    const single = Array.isArray(update.content) ? undefined : update.content;
    void (async () => {
      if (update.sessionUpdate === "agent_message_chunk" && single?.type === "text" && single.text) {
        // Kept before any await: the turn's result may be read as soon as the last chunk arrives.
        reply += single.text;
        await flushThought();
        appendLive(ctx.job.id, single.text);
      } else if (update.sessionUpdate === "agent_thought_chunk" && single?.type === "text" && single.text) {
        thought += single.text;
      } else if (update.sessionUpdate === "tool_call") {
        // Trace first, before any await: updates are handled concurrently, and this call's
        // completion may be handled while the event below is still being written.
        const flushed = flushThought();
        result.toolCalls += 1;
        const summary = (update.title ?? update.kind ?? "tool").slice(0, 160);
        const started = trace.toolStart(update.toolCallId ?? "", update.kind ?? "tool", update.rawInput ?? {}, summary);
        appendLive(ctx.job.id, `\n· ${summary}\n`);
        await ctx.event("tool", { name: update.kind ?? "tool", ok: true, summary, engine: "cursor" });
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
  void exited.then(() => rpc.close(`Cursor's agent stopped. ${stderr.trim().split("\n").filter((line) => !/certificate/i.test(line)).slice(-3).join(" | ")}`.trim()));
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
  try {
    await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: ACP_CLIENT_CAPABILITIES });
    // The login the person already made with `agent login`; Ensemble never sees it.
    await rpc.request("authenticate", { methodId: "cursor_login" }).catch(() => undefined);
    const mcpServers = [
      {
        name: "ensemble",
        command: process.execPath,
        args: [hookScriptPath("ensemble-ask-mcp.mjs")],
        env: Object.entries(ensembleMcp).map(([name, value]) => ({ name, value })),
      },
    ];
    const signedOut = (error: Error) => {
      throw /authentication required/i.test(error.message) ? new Error("Cursor's agent is not signed in on this computer. Run `agent login` there, then Run again.") : error;
    };
    let session: Record<string, unknown>;
    if (options.resume) {
      // The next message in a chat: the same Cursor session, so it remembers the conversation.
      replaying = true;
      session = await rpc
        .request("session/load", { sessionId: options.resume, cwd: ctx.root, mcpServers })
        .then(() => ({ sessionId: options.resume }))
        .catch((error: Error) => {
          if (/authentication required/i.test(error.message)) signedOut(error);
          throw new SessionGoneError(`Cursor could not reopen the chat's session: ${error.message}`);
        })
        .finally(() => {
          replaying = false;
        });
    } else {
      session = await rpc.request("session/new", { cwd: ctx.root, mcpServers }).catch(signedOut);
    }
    sessionId = typeof session.sessionId === "string" ? session.sessionId : null;
    if (!sessionId) throw new Error("Cursor's agent did not start a session.");
    // What Cursor's session says it runs (node/settings.ts observed): its current model, when it reports one.
    const current = (session.models as { currentModelId?: unknown } | undefined)?.currentModelId;
    await ctx.event("engine", { engine: "cursor", model: result.model, session: sessionId, observed: typeof current === "string" && current ? { model: current } : {} });
    await ctx.progress("Cursor started");
    const done = (await rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: options.prompt }] })) as { stopReason?: string };
    result.turns = 1;
    await options.stopCheck();
    if (ctx.signal.aborted || done.stopReason === "cancelled") throw new DOMException("Stopped", "AbortError");
    if (done.stopReason === "refusal") throw new Error("Cursor's agent refused the task.");
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
      setTimeout(kill, 2000).unref();
    }
  }
}
