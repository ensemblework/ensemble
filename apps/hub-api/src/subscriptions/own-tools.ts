/**
 * An assistant turn whose agent keeps its own tools (`AgentTurnSpec.ownTools`; docs/30 §8). In a chat, Ask
 * Ensemble or a routine on the person's own plan, the agent's shell, files and web run as they would in the
 * person's own agent, without asking: Ensemble only refuses what its hard floor refuses (judge.ts
 * `judgeFloor`: dangerous commands, privilege and persistence programs, keys and sign-ins, Ensemble's own
 * data and code, the system's files), judged in the turn's folder (`floorJudge`). In an Ensemble Node's
 * turn each call goes by the node's folder policy instead, and may wait for its owner's answer
 * (node-own-tools.ts). How each agent is asked:
 *
 * - Claude Code: a PreToolUse hook on every tool (`--settings`), scripts/ensemble-hook.mjs --chat, which
 *   asks this runtime (`/api/engine/assistant/ask`) with the turn's secret.
 * - GitHub Copilot CLI: the same hook as a per-turn plugin (`--plugin-dir`), which Copilot loads for a
 *   new or a resumed session alike (a folder's own `.github/hooks` load only for a new, trusted one).
 * - Codex: without its sandbox; it asks before every command it does not consider safe and every file
 *   change, and each is answered here.
 * - Cursor's agent and the ACP agents: every permission request, answered here.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { acpCalls, pickOption } from "../workspace/engines/acp.js";
import { hookCall, judgeFloor, type EngineAnswer, type EngineCall } from "../workspace/engines/judge.js";
import { logAi } from "../lib/ai-activity.js";
import { hookScriptPath } from "../workspace/engines/registry.js";
import type { OwnJudge, OwnToolEvent } from "./bridge.js";

const words = (value: unknown): string => (typeof value === "string" ? value : Array.isArray(value) ? value.join(" ") : "");

/**
 * How long an agent waits for Ensemble's answer on one of its own calls (its hook's timeout, in seconds): a
 * node's call can wait for its owner's answer on a card (up to 90 seconds each, node-own-tools.ts).
 */
export const OWN_TOOL_HOOK_SECONDS = 300;

/** A refused own call goes in the person's AI activity log, with why. */
export function logRefused(app: string, call: EngineCall, verdict: EngineAnswer): void {
  logAi({ kind: "agent.tool", app, name: call.tool, input: call.input, ok: false, output: verdict.message ?? "Refused.", meta: { refused: true } });
}

/** A chat, Ask Ensemble or a routine: the hard floor alone, in the turn's folder. */
export function floorJudge(folder: string, app: string): OwnJudge {
  return async (calls) => {
    for (const call of calls) {
      const verdict = await judgeFloor(folder, call);
      if (verdict.decision !== "allow") {
        logRefused(app, call, verdict);
        return verdict;
      }
    }
    return { decision: "allow" };
  };
}

/** The hook command for an agent's own tool calls in the turn (quoted: the script's path may hold spaces). */
export function chatHookCommand(source: "claude" | "copilot-cli"): string {
  return `"${process.execPath}" "${hookScriptPath()}" --source ${source} --chat`;
}

/** Claude Code's per-turn settings: the hook on every tool. Its own permission prompts never come up: the hook decides. */
export function claudeChatSettings(hookCommand: string): Record<string, unknown> {
  return { hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand, timeout: OWN_TOOL_HOOK_SECONDS }] }] } };
}

/** Writes Copilot's per-turn plugin (a legacy plugin: `plugin.json` and `hooks.json`) into `dir`. */
export async function writeCopilotFloorPlugin(dir: string, hookCommand: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "plugin.json"), JSON.stringify({ name: "ensemble-chat", version: "1.0.0", description: "Ensemble's hard floor for an assistant turn" }), "utf8");
  await writeFile(join(dir, "hooks.json"), JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: "command", bash: hookCommand, powershell: `& ${hookCommand}`, timeoutSec: OWN_TOOL_HOOK_SECONDS }] } }), "utf8");
  return dir;
}

/** Codex's own requests in such a turn, answered by the turn's judge. `files`: the paths each file change touches (from its `item/started`). */
export async function answerCodexOwnTools(judge: OwnJudge, method: string, params: Record<string, unknown>, files: Map<string, string[]>): Promise<unknown> {
  const cwd = typeof params.cwd === "string" && params.cwd ? { cwd: params.cwd } : {};
  switch (method) {
    case "item/commandExecution/requestApproval": {
      if (params.kind === "writeStdin") return { decision: "accept" };
      // The internet is the person's own agent's, as in their Codex.
      if ((params.networkApprovalContext as { host?: string } | null | undefined)?.host) return { decision: "accept" };
      const verdict = await judge([{ tool: "Bash", input: { command: words(params.command), ...cwd } }]);
      return { decision: verdict.decision === "allow" ? "accept" : "decline" };
    }
    case "item/fileChange/requestApproval": {
      const paths = [...(files.get(String(params.itemId)) ?? []), ...(typeof params.grantRoot === "string" ? [params.grantRoot] : [])];
      const verdict = paths.length ? await judge(paths.map((path) => ({ tool: "Write", input: { file_path: path } }))) : { decision: "deny" as const };
      return { decision: verdict.decision === "allow" ? "accept" : "decline" };
    }
    case "item/permissions/requestApproval": {
      const wanted = (params.permissions ?? {}) as { network?: { enabled?: boolean | null } | null; fileSystem?: { read?: string[] | null; write?: string[] | null } | null };
      const granted: Record<string, unknown> = {};
      if (wanted.network?.enabled) granted.network = { enabled: true };
      const read: string[] = [];
      const write: string[] = [];
      for (const path of (wanted.fileSystem?.read ?? []).filter(Boolean)) if ((await judge([{ tool: "Read", input: { file_path: path } }])).decision === "allow") read.push(path);
      for (const path of (wanted.fileSystem?.write ?? []).filter(Boolean)) if ((await judge([{ tool: "Write", input: { file_path: path } }])).decision === "allow") write.push(path);
      if (read.length || write.length) granted.fileSystem = { read, write };
      return { permissions: granted, scope: "turn" };
    }
    case "execCommandApproval": {
      const verdict = await judge([{ tool: "Bash", input: { command: words(params.command), ...cwd } }]);
      return { decision: verdict.decision === "allow" ? "approved" : { denied: { rejection: verdict.message ?? "Refused by Ensemble." } } };
    }
    case "applyPatchApproval": {
      const verdict = await judge(Object.keys((params.fileChanges ?? {}) as Record<string, unknown>).map((path) => ({ tool: "Write", input: { file_path: path } })));
      return { decision: verdict.decision === "allow" ? "approved" : { denied: { rejection: verdict.message ?? "Refused by Ensemble." } } };
    }
    // Nobody is there to pick an option: the agent asks the person in its reply.
    case "item/tool/requestUserInput":
      return { answers: {} };
    case "mcpServer/elicitation/request":
      return { action: params.serverName === "ensemble" ? "accept" : "decline", content: null, _meta: null };
    default:
      throw new Error(`${method} is not handled by Ensemble.`);
  }
}

/** A permission request from Cursor's agent or an ACP agent in such a turn: allowed once unless the turn's judge refuses it. */
export async function answerAcpOwnTools(judge: OwnJudge, method: string, params: Record<string, unknown>): Promise<unknown> {
  if (method === "session/request_permission") {
    const options = (Array.isArray(params.options) ? params.options : []) as Array<{ optionId: string; kind?: string }>;
    const verdict = await judge(acpCalls((params.toolCall ?? {}) as Parameters<typeof acpCalls>[0]));
    const optionId = pickOption(options as Parameters<typeof pickOption>[0], verdict.decision === "allow");
    return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
  }
  if (method === "cursor/ask_question") return { outcome: { outcome: "skipped", reason: "Ask the person in your reply instead." } };
  throw Object.assign(new Error(`${method} is not handled by Ensemble.`), { code: -32601 });
}

/** Codex's own items (its `item/started`), as the calls they are. */
const CODEX_ITEMS: Record<string, (input: Record<string, unknown>) => EngineCall> = {
  commandExecution: (input) => ({ tool: "Bash", input: { command: words(input.command) } }),
  fileChange: (input) => ({ tool: "Write", input: { file_path: words(input.files) } }),
  webSearch: (input) => ({ tool: "WebSearch", input: { query: words(input.query) } }),
};

/** How a node's chat names an own call: by what it does, the same for every agent. */
const CHIP: Record<string, string> = { Bash: "Shell", PowerShell: "Shell", Read: "Read", Grep: "Search", Glob: "Search", LS: "Read", Write: "Edit", Edit: "Edit", MultiEdit: "Edit", NotebookEdit: "Edit", WebSearch: "Web search", WebFetch: "Web page" };

/**
 * One of the agent's own calls as its owner's chat shows it: what it does (`name`), what it touches in a
 * line (`summary`), and whether it can change something (`acts`: a command or a file change). `call` is
 * the call as the agent's permission request named it (an ACP agent's), when there was one.
 */
export function ownToolShape(name: string, input: unknown, call?: EngineCall): { name: string; summary: string; acts: boolean } {
  const given = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const known = call ?? CODEX_ITEMS[name]?.(given) ?? hookCall(name, given);
  const home = homedir();
  const short = (text: string) => (home && (text === home || text.startsWith(`${home}/`) || text.startsWith(`${home}\\`)) ? `~${text.slice(home.length)}` : text);
  const line = (text: string) => short(text.replace(/\s+/g, " ").trim()).slice(0, 300);
  const field = (...keys: string[]) => keys.map((key) => (Array.isArray(known.input[key]) ? (known.input[key] as unknown[])[0] : known.input[key])).find((value) => typeof value === "string" && value.trim()) as string | undefined;
  const chip = CHIP[known.tool];
  const summary = line((field("command", "file_path", "path", "paths", "url", "query", "pattern") ?? words(given.description)) || (call ? name : ""));
  return { name: (chip ?? name).slice(0, 100) || "Tool", summary, acts: chip === "Shell" || chip === "Edit" };
}

/**
 * The agent's own tool calls in a turn (its shell, files, web), kept in the person's AI activity with
 * their input and output (lib/ai-activity.ts), and told to `listen` as they start and end (a node's
 * chat shows them: remote/assistant.ts). Ensemble's own tools are logged where they run instead.
 */
export class OwnToolLog {
  private readonly open = new Map<string, { name: string; input: unknown; at: number; shape: ReturnType<typeof ownToolShape> }>();
  constructor(
    private readonly app: string,
    private readonly listen?: (event: OwnToolEvent) => void,
  ) {}

  start(id: string, name: string, input: unknown, call?: EngineCall): void {
    if (!id || ensembleTool(name) || this.open.size >= 200) return;
    const shape = ownToolShape(name, input, call);
    this.open.set(id, { name, input, at: Date.now(), shape });
    this.listen?.({ id: id.slice(0, 200), ...shape, phase: "start" });
  }

  end(id: string, output: unknown, ok: boolean): void {
    const call = this.open.get(id);
    if (!call) return;
    this.open.delete(id);
    logAi({ kind: "agent.tool", app: this.app, name: call.name, input: call.input, output, ok, durationMs: Date.now() - call.at });
    this.listen?.({ id: id.slice(0, 200), ...call.shape, phase: "end", ok });
  }

  /** At the end of the turn: calls whose result never came back, as they stand. */
  close(): void {
    for (const [id, call] of this.open) {
      logAi({ kind: "agent.tool", app: this.app, name: call.name, input: call.input, durationMs: Date.now() - call.at, meta: { unanswered: true } });
      this.listen?.({ id: id.slice(0, 200), ...call.shape, phase: "end", ok: false });
    }
    this.open.clear();
  }
}

/** An ACP agent's tool call starting or ending (its session/update), for the turn's OwnToolLog. */
export function logAcpTool(log: OwnToolLog, update: Record<string, unknown>): void {
  const id = typeof update.toolCallId === "string" ? update.toolCallId : "";
  if (update.sessionUpdate === "tool_call") {
    const calls = acpCalls(update as Parameters<typeof acpCalls>[0]);
    if (calls.some((call) => ensembleTool(call.tool))) return;
    log.start(id, String(update.title ?? update.kind ?? "tool"), update.rawInput ?? {}, calls[0]);
  } else if (update.sessionUpdate === "tool_call_update" && (update.status === "completed" || update.status === "failed")) {
    const parts = Array.isArray(update.content) ? (update.content as Array<{ content?: { text?: unknown } }>) : [];
    const text = parts.map((part) => (typeof part.content?.text === "string" ? part.content.text : "")).filter(Boolean).join("\n");
    log.end(id, update.rawOutput ?? text, update.status === "completed");
  }
}

/** Ensemble's MCP tools as each agent names them: mcp__ensemble__hub_x (Claude), ensemble-hub_x (Copilot). */
function ensembleTool(name: string): boolean {
  return /^(?:mcp__ensemble__|ensemble[-_./:])/.test(name);
}
