/**
 * The decision router: permission prompts from other agents (Cursor, Claude
 * Code, VS Code Copilot) land on Needs me, and the answer goes back to the
 * exact tool call that asked. The hook process holds the tool call open while
 * it long-polls here; nothing is guessed if nobody answers — the hook falls
 * back to the tool's own prompt.
 */
import { EventEmitter } from "node:events";
import type { AgentDecision } from "@prisma/client";
import { prisma } from "./prisma.js";
import { actorFor } from "../sharing/context.js";

export const decisionBus = new EventEmitter();
decisionBus.setMaxListeners(0);

export type Source = "cursor" | "claude" | "copilot" | "codex" | "other";

export interface Normalized {
  source: Source;
  event: string;
  toolName: string;
  title: string;
  command: string | null;
  sessionId: string | null;
  cwd: string | null;
  detail: Record<string, unknown>;
}

const str = (value: unknown): string | null => (typeof value === "string" && value.length ? value : null);

function toolInput(payload: Record<string, unknown>): Record<string, unknown> {
  const raw = payload.tool_input ?? payload.toolInput ?? payload.input ?? {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { value: raw };
    }
  }
  return (raw ?? {}) as Record<string, unknown>;
}

function titleFor(toolName: string, command: string | null, input: Record<string, unknown>): string {
  if (command) return `Run \`${command.length > 140 ? `${command.slice(0, 140)}…` : command}\``;
  const path = str(input.file_path) ?? str(input.path) ?? str(input.filePath) ?? str(input.target_file);
  if (path) return `${toolName} ${path}`;
  if (toolName.startsWith("MCP") || toolName.startsWith("mcp__")) return `Call ${toolName.replace(/^mcp__/, "").replace(/__/g, " → ")}`;
  const url = str(input.url);
  if (url) return `${toolName} ${url}`;
  return `Use ${toolName}`;
}

export function normalize(source: Source, event: string, payload: Record<string, unknown>): Normalized {
  const input = toolInput(payload);
  let toolName = str(payload.tool_name) ?? str(payload.toolName) ?? "tool";
  let command: string | null = null;
  if (event === "beforeShellExecution") {
    toolName = "Shell";
    command = str(payload.command);
  } else if (event === "beforeMCPExecution") {
    toolName = `MCP: ${str(payload.tool_name) ?? "tool"}`;
  } else {
    command = str(input.command) ?? str(input.cmd) ?? (["Shell", "Bash", "run_in_terminal", "runInTerminal"].includes(toolName) ? str(input.value) : null);
  }
  const question = str(payload.question) ?? str(payload.prompt);
  const options = Array.isArray(payload.options) ? payload.options.filter((item): item is string => typeof item === "string") : [];
  const cwd = str(payload.cwd) ?? (Array.isArray(payload.workspace_roots) ? str(payload.workspace_roots[0]) : null);
  const sessionId = str(payload.session_id) ?? str(payload.sessionId) ?? str(payload.conversation_id) ?? null;
  return {
    source,
    event,
    toolName,
    command,
    title: question ?? titleFor(toolName, command, input),
    sessionId,
    cwd,
    detail: {
      input,
      server: str(payload.url) ?? str(payload.command_line) ?? (event === "beforeMCPExecution" ? str(payload.command) : null),
      suggestions: payload.permission_suggestions ?? null,
      transcript: str(payload.transcript_path),
      model: str(payload.model),
      options,
    },
  };
}

export async function matchingRule(userId: string, call: Normalized) {
  const rules = await prisma.decisionRule.findMany({
    where: { userId, toolName: call.toolName, source: { in: [call.source, "*"] } },
    orderBy: { createdAt: "desc" },
  });
  return (
    rules.find(
      (rule) =>
        (rule.pattern === "*" || (call.command !== null && rule.pattern === call.command)) &&
        (!rule.sessionId || rule.sessionId === call.sessionId),
    ) ?? null
  );
}

/**
 * In a shared space everyone sees a run's questions, but only the person whose computer runs
 * it (or the owner, for everything else) may answer, and only they see which computer it is.
 */
export function publicDecision(row: AgentDecision) {
  const detail = row.detail && typeof row.detail === "object" && !Array.isArray(row.detail) ? (row.detail as Record<string, unknown>) : null;
  const runner = typeof detail?.runnerAccountId === "string" && detail.runnerAccountId ? detail.runnerAccountId : null;
  const me = actorFor(row.userId);
  const canAnswer = runner ? me === runner : me === null;
  const shown = canAnswer || !detail ? row.detail : { ...detail, deviceName: null, deviceId: null };
  return {
    id: row.id,
    source: row.source,
    event: row.event,
    toolName: row.toolName,
    title: row.title,
    detail: shown,
    sessionId: row.sessionId,
    cwd: canAnswer ? row.cwd : null,
    canAnswer,
    runnerAccountId: runner,
    status: row.status,
    decision: row.decision,
    scope: row.scope,
    reason: row.reason,
    requestedAt: row.requestedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
  };
}

/** Resolves when the decision leaves pending, or after timeoutMs with the current row. */
export async function waitFor(id: string, timeoutMs: number): Promise<AgentDecision | null> {
  const current = await prisma.agentDecision.findUnique({ where: { id } });
  if (!current || current.status !== "pending") return current;
  return new Promise((resolve) => {
    const finish = async () => {
      clearTimeout(timer);
      clearInterval(poll);
      decisionBus.off(id, finish);
      resolve(await prisma.agentDecision.findUnique({ where: { id } }));
    };
    const timer = setTimeout(finish, timeoutMs);
    // A second hub-api process would not share the bus; the poll covers it.
    const poll = setInterval(async () => {
      const row = await prisma.agentDecision.findUnique({ where: { id }, select: { status: true } });
      if (row?.status !== "pending") void finish();
    }, 3000);
    decisionBus.once(id, finish);
  });
}

export async function expireStale(userId?: string): Promise<number> {
  const result = await prisma.agentDecision.updateMany({
    where: { status: "pending", expiresAt: { lt: new Date() }, ...(userId ? { userId } : {}) },
    data: { status: "expired" },
  });
  return result.count;
}
