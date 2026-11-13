/**
 * An assistant turn whose agent keeps its own tools (`AgentTurnSpec.ownTools`: a chat, Ask Ensemble or a
 * routine on the person's own plan; docs/30 §8). The agent's shell, files and web run as they would in the
 * person's own agent, without asking: Ensemble only refuses what its hard floor refuses (judge.ts
 * `judgeFloor`: dangerous commands, privilege and persistence programs, keys and sign-ins, Ensemble's own
 * data and code, the system's files), judged in the turn's folder. How each agent is asked:
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
import { join } from "node:path";
import { acpCalls, pickOption } from "../workspace/engines/acp.js";
import { judgeFloor, type EngineAnswer, type EngineCall } from "../workspace/engines/judge.js";
import { logAi } from "../lib/ai-activity.js";
import { hookScriptPath } from "../workspace/engines/registry.js";

const words = (value: unknown): string => (typeof value === "string" ? value : Array.isArray(value) ? value.join(" ") : "");

/** The floor's verdict on an agent's own calls; a refusal also goes in the person's AI activity log, with why. */
async function verdictFor(folder: string, calls: EngineCall[], app: string): Promise<EngineAnswer> {
  for (const call of calls) {
    const verdict = await judgeFloor(folder, call);
    if (verdict.decision !== "allow") {
      logAi({ kind: "agent.tool", app, name: call.tool, input: call.input, ok: false, output: verdict.message ?? "Refused.", meta: { refused: true } });
      return verdict;
    }
  }
  return { decision: "allow" };
}

/** The hook command for an agent's own tool calls in the turn (quoted: the script's path may hold spaces). */
export function chatHookCommand(source: "claude" | "copilot-cli"): string {
  return `"${process.execPath}" "${hookScriptPath()}" --source ${source} --chat`;
}

/** Claude Code's per-turn settings: the hook on every tool. Its own permission prompts never come up: the hook decides. */
export function claudeChatSettings(hookCommand: string): Record<string, unknown> {
  return { hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand, timeout: 60 }] }] } };
}

/** Writes Copilot's per-turn plugin (a legacy plugin: `plugin.json` and `hooks.json`) into `dir`. */
export async function writeCopilotFloorPlugin(dir: string, hookCommand: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "plugin.json"), JSON.stringify({ name: "ensemble-chat", version: "1.0.0", description: "Ensemble's hard floor for an assistant turn" }), "utf8");
  await writeFile(join(dir, "hooks.json"), JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: "command", bash: hookCommand, powershell: `& ${hookCommand}`, timeoutSec: 60 }] } }), "utf8");
  return dir;
}

/** Codex's own requests in such a turn. `files`: the paths each file change touches (from its `item/started`). */
export async function answerCodexOwnTools(folder: string, method: string, params: Record<string, unknown>, files: Map<string, string[]>): Promise<unknown> {
  const cwd = typeof params.cwd === "string" && params.cwd ? { cwd: params.cwd } : {};
  switch (method) {
    case "item/commandExecution/requestApproval": {
      if (params.kind === "writeStdin") return { decision: "accept" };
      // The internet is the person's own agent's, as in their Codex.
      if ((params.networkApprovalContext as { host?: string } | null | undefined)?.host) return { decision: "accept" };
      const verdict = await verdictFor(folder, [{ tool: "Bash", input: { command: words(params.command), ...cwd } }], "codex");
      return { decision: verdict.decision === "allow" ? "accept" : "decline" };
    }
    case "item/fileChange/requestApproval": {
      const paths = [...(files.get(String(params.itemId)) ?? []), ...(typeof params.grantRoot === "string" ? [params.grantRoot] : [])];
      const verdict = paths.length ? await verdictFor(folder, paths.map((path) => ({ tool: "Write", input: { file_path: path } })), "codex") : { decision: "deny" as const };
      return { decision: verdict.decision === "allow" ? "accept" : "decline" };
    }
    case "item/permissions/requestApproval": {
      const wanted = (params.permissions ?? {}) as { network?: { enabled?: boolean | null } | null; fileSystem?: { read?: string[] | null; write?: string[] | null } | null };
      const granted: Record<string, unknown> = {};
      if (wanted.network?.enabled) granted.network = { enabled: true };
      const read: string[] = [];
      const write: string[] = [];
      for (const path of (wanted.fileSystem?.read ?? []).filter(Boolean)) if ((await judgeFloor(folder, { tool: "Read", input: { file_path: path } })).decision === "allow") read.push(path);
      for (const path of (wanted.fileSystem?.write ?? []).filter(Boolean)) if ((await judgeFloor(folder, { tool: "Write", input: { file_path: path } })).decision === "allow") write.push(path);
      if (read.length || write.length) granted.fileSystem = { read, write };
      return { permissions: granted, scope: "turn" };
    }
    case "execCommandApproval": {
      const verdict = await verdictFor(folder, [{ tool: "Bash", input: { command: words(params.command), ...cwd } }], "codex");
      return { decision: verdict.decision === "allow" ? "approved" : { denied: { rejection: verdict.message ?? "Refused by Ensemble." } } };
    }
    case "applyPatchApproval": {
      const verdict = await verdictFor(folder, Object.keys((params.fileChanges ?? {}) as Record<string, unknown>).map((path) => ({ tool: "Write", input: { file_path: path } })), "codex");
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

/** A permission request from Cursor's agent or an ACP agent in such a turn: allowed once unless the hard floor refuses it. */
export async function answerAcpOwnTools(folder: string, method: string, params: Record<string, unknown>, app = "acp"): Promise<unknown> {
  if (method === "session/request_permission") {
    const options = (Array.isArray(params.options) ? params.options : []) as Array<{ optionId: string; kind?: string }>;
    const verdict = await verdictFor(folder, acpCalls((params.toolCall ?? {}) as Parameters<typeof acpCalls>[0]), app);
    const optionId = pickOption(options as Parameters<typeof pickOption>[0], verdict.decision === "allow");
    return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
  }
  if (method === "cursor/ask_question") return { outcome: { outcome: "skipped", reason: "Ask the person in your reply instead." } };
  throw Object.assign(new Error(`${method} is not handled by Ensemble.`), { code: -32601 });
}

/**
 * The agent's own tool calls in a turn (its shell, files, web), kept in the person's AI activity with
 * their input and output (lib/ai-activity.ts). Ensemble's own tools are logged where they run instead.
 */
export class OwnToolLog {
  private readonly open = new Map<string, { name: string; input: unknown; at: number }>();
  constructor(private readonly app: string) {}

  start(id: string, name: string, input: unknown): void {
    if (!id || ensembleTool(name) || this.open.size >= 200) return;
    this.open.set(id, { name, input, at: Date.now() });
  }

  end(id: string, output: unknown, ok: boolean): void {
    const call = this.open.get(id);
    if (!call) return;
    this.open.delete(id);
    logAi({ kind: "agent.tool", app: this.app, name: call.name, input: call.input, output, ok, durationMs: Date.now() - call.at });
  }

  /** At the end of the turn: calls whose result never came back, as they stand. */
  close(): void {
    for (const call of this.open.values()) logAi({ kind: "agent.tool", app: this.app, name: call.name, input: call.input, durationMs: Date.now() - call.at, meta: { unanswered: true } });
    this.open.clear();
  }
}

/** An ACP agent's tool call starting or ending (its session/update), for the turn's OwnToolLog. */
export function logAcpTool(log: OwnToolLog, update: Record<string, unknown>): void {
  const id = typeof update.toolCallId === "string" ? update.toolCallId : "";
  if (update.sessionUpdate === "tool_call") {
    if (acpCalls(update as Parameters<typeof acpCalls>[0]).some((call) => ensembleTool(call.tool))) return;
    log.start(id, String(update.title ?? update.kind ?? "tool"), update.rawInput ?? {});
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
