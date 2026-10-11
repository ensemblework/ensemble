/**
 * Codex as the run's engine: the person's own Codex, signed in with their own ChatGPT account
 * or key, driven through `codex app-server` (JSON lines over stdio). It is the standalone
 * `codex` when one is on PATH, else the copy the ChatGPT app ships, which shares the same
 * `~/.codex` sign-in, so a computer with only the app works too. Ensemble never reads, copies or
 * starts a sign-in; a Codex that is not signed in is refused with how to sign in.
 *
 * Codex keeps its own OS sandbox (Seatbelt, bubblewrap or its Windows sandbox) with the run's
 * writable folders and internet setting; Ensemble does not wrap it in a second one (nesting
 * fails on macOS). Every approval Codex asks for (a command, a file change, more access) is
 * judged by the run's rules (`judge.ts`), and questions go through Ensemble's `ask_person` MCP
 * tool to Needs me. In Ask mode in a folder that is not trusted, Codex asks before each command
 * it does not consider safe ("untrusted"); otherwise only when it wants to leave its sandbox.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { desktopDataDir } from "@ensemble/shared-types/desktop-discovery";
import { askpassPath, cacheDir, ENSEMBLE_SOURCE } from "../guard.js";
import { bundledCodex } from "../handoff.js";
import { appendLive } from "../live-log.js";
import { hostExecutable } from "../policy.js";
import { SECRET_HOME_PATHS } from "../sandbox/seatbelt.js";
import { askPerson, type JobContext } from "../tools.js";
import { claudeFilesystem, type EngineResult } from "./claude-code.js";
import { judgeEngineCall, type EngineAnswer } from "./judge.js";
import { RpcConnection } from "./rpc.js";
import { hookScriptPath, localApiUrl, registerEngineRun, unregisterEngineRun } from "./registry.js";

/** Keys in Ensemble's own environment that must not stand in for the person's Codex sign-in. */
const KEY_VARIABLES = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"];

/** The person's Codex: the standalone CLI first (stable path on the trusted PATH), else the ChatGPT app's. */
export async function codexBinary(): Promise<string | null> {
  return (await hostExecutable("codex").catch(() => null)) ?? bundledCodex();
}

export async function detectCodex(): Promise<{ path: string; version: string; fromApp: boolean } | null> {
  const path = await codexBinary();
  if (!path) return null;
  const result = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) return null;
  return { path, version: result.stdout.trim().split(/\s+/).pop() ?? "", fromApp: path === bundledCodex() };
}

const words = (value: unknown): string => (typeof value === "string" ? value : Array.isArray(value) ? value.join(" ") : "");

/** A Codex approval request, answered by the run's rules (and the person, when they must decide). */
export async function answerCodex(
  ctx: JobContext,
  method: string,
  params: Record<string, unknown>,
  files: Map<string, string[]>,
  judge: typeof judgeEngineCall = judgeEngineCall,
  ask: typeof askPerson = askPerson,
): Promise<unknown> {
  const verdictFor = async (calls: Array<{ tool: string; input: Record<string, unknown> }>): Promise<EngineAnswer> => {
    for (const call of calls) {
      const verdict = await judge(ctx, call);
      if (verdict.decision !== "allow") return verdict;
    }
    return { decision: "allow" };
  };
  const note = async (verdict: EngineAnswer) => {
    if (verdict.decision !== "allow") await ctx.event("tool", { name: "codex", ok: false, summary: verdict.message ?? "Refused", engine: "codex" });
  };
  switch (method) {
    case "item/commandExecution/requestApproval": {
      if (params.kind === "writeStdin") return { decision: "accept" };
      const network = params.networkApprovalContext as { host?: string } | null | undefined;
      const verdict = network?.host
        ? await verdictFor([{ tool: "WebFetch", input: { url: `https://${network.host}` } }])
        : await verdictFor([{ tool: "Bash", input: { command: words(params.command) } }]);
      await note(verdict);
      return { decision: verdict.decision === "allow" ? "accept" : "decline" };
    }
    case "item/fileChange/requestApproval": {
      const paths = files.get(String(params.itemId)) ?? [];
      const grant = typeof params.grantRoot === "string" ? [params.grantRoot] : [];
      const verdict = paths.length || grant.length ? await verdictFor([...paths, ...grant].map((path) => ({ tool: "Write", input: { file_path: path } }))) : { decision: "deny" as const, message: "Ensemble could not see which files this change touches." };
      await note(verdict);
      return { decision: verdict.decision === "allow" ? "accept" : "decline" };
    }
    case "item/permissions/requestApproval": {
      // More access for this turn: internet, or reading and writing more folders.
      const wanted = (params.permissions ?? {}) as { network?: { enabled?: boolean | null } | null; fileSystem?: { read?: string[] | null; write?: string[] | null } | null };
      const granted: Record<string, unknown> = {};
      if (wanted.network?.enabled && ctx.network && (await verdictFor([{ tool: "WebFetch", input: {} }])).decision === "allow") granted.network = { enabled: true };
      const read = (wanted.fileSystem?.read ?? []).filter(Boolean);
      const write = (wanted.fileSystem?.write ?? []).filter(Boolean);
      const readOk: string[] = [];
      const writeOk: string[] = [];
      for (const path of read) if ((await judge(ctx, { tool: "Read", input: { file_path: path } })).decision === "allow") readOk.push(path);
      for (const path of write) if ((await judge(ctx, { tool: "Write", input: { file_path: path } })).decision === "allow") writeOk.push(path);
      if (readOk.length || writeOk.length) granted.fileSystem = { read: readOk, write: writeOk };
      return { permissions: granted, scope: "turn" };
    }
    case "item/tool/requestUserInput": {
      const questions = (Array.isArray(params.questions) ? params.questions : []) as Array<{ id: string; question: string; options?: Array<{ label: string }> | null; isOther?: boolean }>;
      const answers: Record<string, { answers: string[] }> = {};
      for (const item of questions) {
        const options = (item.options ?? []).map((option) => option.label).filter(Boolean);
        const recommended = options.find((label) => /\(recommended\)/i.test(label)) ?? options[0] ?? null;
        if (ctx.job.unattended) {
          if (recommended) {
            answers[item.id] = { answers: [recommended] };
            ctx.decisions?.push({ question: item.question, options, recommended });
            await ctx.event("decision", { question: item.question, options, recommended, by: "unattended" });
          }
          continue;
        }
        const answer = await ask(ctx, { event: "question", toolName: "question", title: item.question, options, allowCustom: item.isOther !== false, recommended });
        if (answer.decision === "allow" && answer.answer) answers[item.id] = { answers: [answer.answer] };
      }
      return { answers };
    }
    case "mcpServer/elicitation/request": {
      // Ensemble's own ask_person server never elicits; anything else needs the person, like a command.
      if (params.serverName === "ensemble") return { action: "accept", content: null, _meta: null };
      const verdict = await verdictFor([{ tool: `mcp__${String(params.serverName)}`, input: {} }]);
      return { action: verdict.decision === "allow" ? "accept" : "decline", content: null, _meta: null };
    }
    case "execCommandApproval": {
      const verdict = await verdictFor([{ tool: "Bash", input: { command: words(params.command) } }]);
      return { decision: verdict.decision === "allow" ? "approved" : { denied: { rejection: verdict.message ?? "Not allowed in this run." } } };
    }
    case "applyPatchApproval": {
      const changed = Object.keys((params.fileChanges ?? {}) as Record<string, unknown>);
      const verdict = await verdictFor(changed.map((path) => ({ tool: "Write", input: { file_path: path } })));
      return { decision: verdict.decision === "allow" ? "approved" : { denied: { rejection: verdict.message ?? "Not allowed in this run." } } };
    }
    default:
      // Sign-in tokens, attestation, tools Ensemble did not register: never handled for Codex.
      throw new Error(`${method} is not handled by Ensemble.`);
  }
}

/** How Codex asks: before commands in Ask mode in a folder that is not trusted, else only to leave its sandbox. */
export function codexApprovalPolicy(ctx: Pick<JobContext, "accessMode" | "trusted"> & { job: { unattended: boolean } }): "untrusted" | "on-request" {
  return ctx.accessMode === "read-write" && !ctx.job.unattended && !ctx.trusted ? "untrusted" : "on-request";
}

export async function runCodex(
  ctx: JobContext,
  options: { prompt: string; model?: string | null; stopCheck: () => Promise<void> },
): Promise<EngineResult> {
  const codex = await codexBinary();
  if (!codex) throw new Error("Codex is not on this computer. Install the ChatGPT app or the Codex CLI, sign in, and Run again.");
  const credential = registerEngineRun(ctx);
  const env: NodeJS.ProcessEnv = { ...process.env, ENSEMBLE_ENGINE_URL: localApiUrl(), ENSEMBLE_RUN: credential };
  for (const key of KEY_VARIABLES) delete env[key];
  delete env.ENSEMBLE_DESKTOP_TOKEN;
  delete env.ENSEMBLE_INTERNAL_TOKEN;
  const child: ChildProcessWithoutNullStreams = spawn(codex, ["app-server"], { cwd: ctx.root, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
  // Codex may exit first; a late write is dropped, never thrown.
  child.stdin.on("error", () => undefined);
  const server = new RpcConnection((line) => {
    if (child.stdin.writable) child.stdin.write(line);
  });
  const result: EngineResult = { text: "", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0, model: null, costUsd: null };
  const files = new Map<string, string[]>();
  let stderr = "";
  let threadId: string | null = null;
  let turnId: string | null = null;
  let finished: (status: { status: string; error?: string }) => void = () => {};
  const turnDone = new Promise<{ status: string; error?: string }>((resolve) => (finished = resolve));

  server.onRequest = (method, params) => answerCodex(ctx, method, params, files);
  server.onNotification = (method, params) => {
    void (async () => {
      if (method === "item/started" || method === "item/completed") {
        const item = (params.item ?? {}) as { type?: string; id?: string; command?: string; text?: string; changes?: Array<{ path: string }>; phase?: string | null };
        if (item.type === "fileChange" && item.id) files.set(item.id, (item.changes ?? []).map((change) => change.path));
        if (method === "item/started" && (item.type === "commandExecution" || item.type === "fileChange" || item.type === "mcpToolCall")) {
          result.toolCalls += 1;
          const summary = item.type === "commandExecution" ? `Run ${String(item.command ?? "").slice(0, 160)}` : item.type === "fileChange" ? `Change ${(item.changes ?? []).map((change) => change.path).join(", ").slice(0, 160)}` : "Use a tool";
          appendLive(ctx.job.id, `· ${summary}\n`);
          await ctx.event("tool", { name: item.type, ok: true, summary, engine: "codex" });
        }
        if (method === "item/completed" && item.type === "agentMessage" && item.text?.trim()) {
          appendLive(ctx.job.id, `${item.text.trim()}\n`);
          await ctx.progress(item.text.trim().split("\n")[0]!.slice(0, 160));
          if (item.phase === "final_answer" || item.phase === null || item.phase === undefined) result.text = item.text.trim();
        }
      } else if (method === "thread/tokenUsage/updated") {
        const total = ((params.tokenUsage ?? {}) as { total?: { inputTokens?: number; outputTokens?: number } }).total ?? {};
        result.tokensIn = total.inputTokens ?? result.tokensIn;
        result.tokensOut = total.outputTokens ?? result.tokensOut;
      } else if (method === "turn/completed") {
        const turn = (params.turn ?? {}) as { status?: string; error?: { message?: string } | null };
        finished({ status: turn.status ?? "completed", error: turn.error?.message });
      }
    })().catch(() => undefined);
  };

  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => void server.receive(line));
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000);
  });
  const exited = new Promise<number>((resolve) => child.once("close", (code) => resolve(code ?? 1)));
  void exited.then(() => {
    server.close("Codex stopped.");
    finished({ status: "failed", error: stderr.trim().split("\n").slice(-3).join(" | ") || "Codex stopped." });
  });
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
  // Stopped from Ensemble: ask Codex to end the turn, then end the process.
  const stop = () => {
    if (threadId && turnId) void server.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
    setTimeout(kill, 3000).unref();
  };
  ctx.signal.addEventListener("abort", stop, { once: true });

  try {
    const init = await server.request("initialize", { clientInfo: { name: "ensemble", title: "Ensemble", version: "1" }, capabilities: { experimentalApi: true, requestAttestation: false } });
    server.notify("initialized");
    const account = (await server.request("account/read", {})) as { account?: unknown; requiresOpenaiAuth?: boolean };
    if (account.requiresOpenaiAuth && !account.account) {
      throw new Error("Codex is not signed in on this computer. Open the ChatGPT app (or run `codex login`) and sign in, then Run again.");
    }
    const home = homedir();
    const closed = [...SECRET_HOME_PATHS.map((name) => join(home, name)), desktopDataDir({ platform: process.platform, home }), ENSEMBLE_SOURCE, dirname(await askpassPath())];
    const access = ctx.outsideAccess ?? "none";
    const writable = claudeFilesystem({ access, home, writable: [ctx.root, await cacheDir()], closed, homeEntries: access === "read-write" ? await readdir(home).catch(() => []) : [] }).allowWrite;
    const thread = (await server.request("thread/start", {
      cwd: ctx.root,
      approvalPolicy: codexApprovalPolicy(ctx),
      approvalsReviewer: "user",
      sandbox: ctx.sandboxed ? "workspace-write" : "danger-full-access",
      ...(options.model && options.model !== "default" ? { model: options.model } : {}),
      config: {
        // The folder's own .codex/ (hooks, rules, MCP servers) does not run, as with Claude Code's --setting-sources user.
        projects: { [ctx.root]: { trust_level: "untrusted" } },
        sandbox_workspace_write: { network_access: ctx.network },
        mcp_servers: {
          ensemble: {
            command: process.execPath,
            args: [hookScriptPath("ensemble-ask-mcp.mjs")],
            env: { ENSEMBLE_ENGINE_URL: localApiUrl(), ENSEMBLE_RUN: credential },
            tool_timeout_sec: 86_400,
          },
        },
      },
      serviceName: "ensemble",
    })) as { thread?: { id?: string }; model?: string };
    threadId = thread.thread?.id ?? null;
    if (!threadId) throw new Error("Codex did not start a thread.");
    result.model = thread.model ?? null;
    await ctx.event("engine", { engine: "codex", model: result.model, session: threadId, version: String((init as { userAgent?: string }).userAgent ?? "") });
    await ctx.progress(`Codex started${result.model ? ` (${result.model})` : ""}`);
    const turn = (await server.request("turn/start", {
      threadId,
      input: [{ type: "text", text: options.prompt, text_elements: [] }],
      sandboxPolicy: ctx.sandboxed
        ? { type: "workspaceWrite", writableRoots: writable, networkAccess: ctx.network, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
        : { type: "dangerFullAccess" },
    })) as { turn?: { id?: string } };
    turnId = turn.turn?.id ?? null;
    result.turns = 1;
    const done = await turnDone;
    await options.stopCheck();
    if (ctx.signal.aborted) throw new DOMException("Stopped", "AbortError");
    if (done.status === "failed") throw new Error(`Codex stopped: ${done.error ?? "the turn failed"}`);
    if (done.status === "interrupted") throw new DOMException("Stopped", "AbortError");
    return result;
  } catch (error) {
    if (ctx.signal.aborted) throw new DOMException("Stopped", "AbortError");
    if (error instanceof Error && /sandbox/i.test(stderr) && ctx.sandboxed) {
      throw new Error(`Codex's sandbox could not start on this computer. Turn off the sandbox for this run to use Codex directly. ${stderr.trim().slice(-300)}`);
    }
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
