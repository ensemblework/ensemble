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
import { hookScriptPath } from "../workspace/engines/registry.js";

const words = (value: unknown): string => (typeof value === "string" ? value : Array.isArray(value) ? value.join(" ") : "");

async function verdictFor(folder: string, calls: EngineCall[]): Promise<EngineAnswer> {
  for (const call of calls) {
    const verdict = await judgeFloor(folder, call);
    if (verdict.decision !== "allow") return verdict;
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
      const verdict = await verdictFor(folder, [{ tool: "Bash", input: { command: words(params.command), ...cwd } }]);
      return { decision: verdict.decision === "allow" ? "accept" : "decline" };
    }
    case "item/fileChange/requestApproval": {
      const paths = [...(files.get(String(params.itemId)) ?? []), ...(typeof params.grantRoot === "string" ? [params.grantRoot] : [])];
      const verdict = paths.length ? await verdictFor(folder, paths.map((path) => ({ tool: "Write", input: { file_path: path } }))) : { decision: "deny" as const };
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
      const verdict = await verdictFor(folder, [{ tool: "Bash", input: { command: words(params.command), ...cwd } }]);
      return { decision: verdict.decision === "allow" ? "approved" : { denied: { rejection: verdict.message ?? "Refused by Ensemble." } } };
    }
    case "applyPatchApproval": {
      const verdict = await verdictFor(folder, Object.keys((params.fileChanges ?? {}) as Record<string, unknown>).map((path) => ({ tool: "Write", input: { file_path: path } })));
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
export async function answerAcpOwnTools(folder: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  if (method === "session/request_permission") {
    const options = (Array.isArray(params.options) ? params.options : []) as Array<{ optionId: string; kind?: string }>;
    const verdict = await verdictFor(folder, acpCalls((params.toolCall ?? {}) as Parameters<typeof acpCalls>[0]));
    const optionId = pickOption(options as Parameters<typeof pickOption>[0], verdict.decision === "allow");
    return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
  }
  if (method === "cursor/ask_question") return { outcome: { outcome: "skipped", reason: "Ask the person in your reply instead." } };
  throw Object.assign(new Error(`${method} is not handled by Ensemble.`), { code: -32601 });
}
