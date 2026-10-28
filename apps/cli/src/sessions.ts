/**
 * `ensemble sessions`: the coding-agent sessions on this computer (hub-api workspace/sessions.ts),
 * read from the local runtime. A session is one conversation with Claude Code, Codex, Copilot or
 * another agent, carried across the tasks continued in it.
 */
import { localJson, type Discovery } from "./sidecar.js";

export type SessionRow = {
  id: string;
  agentName: string;
  model: string;
  folder: string;
  title: string;
  latestTask: { id: string; title: string };
  summary: string;
  status: "working" | "waiting" | "queued" | "idle";
  tasks: number;
  lastActiveAt: string;
};

export async function listSessions(discovery: Discovery, limit = 20): Promise<SessionRow[]> {
  const body = await localJson<{ sessions?: SessionRow[] }>(discovery, `/api/agent/sessions?limit=${limit}`);
  return body.sessions ?? [];
}

const STATUS: Record<SessionRow["status"], string> = { working: "working", waiting: "waiting for you", queued: "queued", idle: "idle" };

/** "5m ago", "3h ago", "2d ago". */
export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

export function formatSessions(rows: SessionRow[], now = Date.now()): string {
  if (!rows.length) return "No agent sessions on this computer yet. A session starts when Claude Code, Codex, Copilot or another agent runs a task here.";
  return rows
    .map((row, index) => {
      const model = row.model && row.model !== "default" ? ` (${row.model})` : "";
      const tasks = row.latestTask.title === row.title ? row.title : `${row.title} → ${row.latestTask.title}${row.tasks > 2 ? ` (+${row.tasks - 2} more)` : ""}`;
      return [`${index + 1}. ${row.agentName}${model} · ${row.folder} · ${STATUS[row.status]} · ${ago(row.lastActiveAt, now)}`, `   ${tasks}`, ...(row.summary ? [`   ${row.summary}`] : [])].join("\n");
    })
    .join("\n\n");
}
