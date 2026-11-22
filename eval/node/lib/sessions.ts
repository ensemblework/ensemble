/**
 * The agent sessions a run makes, recorded as they appear and deleted at the end: a node's
 * conversation sessions (`<state>/assistant-sessions.json`), the coding sessions its runs start
 * (`workspace_events` of kind `engine`), the judge's one-off calls, and any Copilot session whose
 * folder lies in the run's scratch folder. A session that existed before the run, or that is
 * protected by name, is never deleted. Copilot's own record of a session (its folder under
 * `~/.copilot/session-state` and its rows in `session-store.db`) is checked after deletion.
 */
import { existsSync, readdirSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CleanupEntry } from "./types.js";
import type { World } from "./world.js";

export type LedgerEntry = { agent: string; id: string; kind: "node-turn" | "coding" | "judge" | "found"; task: string | null; folder: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/;

export const copilotHome = () => process.env.COPILOT_HOME?.trim() || join(homedir(), ".copilot");
const stateRoot = () => join(copilotHome(), "session-state");

/** Copilot sessions on this computer now, by id. */
export function copilotSessionIds(): Set<string> {
  try {
    return new Set(readdirSync(stateRoot()).filter((name) => SESSION_ID.test(name)));
  } catch {
    return new Set();
  }
}

export class SessionLedger {
  private readonly rows = new Map<string, LedgerEntry>();

  /** `before`: sessions that existed when the run began; `protect`: ids never to touch. */
  constructor(private readonly file: string, private readonly before: ReadonlySet<string>, private readonly protect: ReadonlySet<string>) {}

  /** Records a session the run made (written to the ledger file at once). False when it is not the run's to delete. */
  record(entry: LedgerEntry): boolean {
    if (!SESSION_ID.test(entry.id) || this.protect.has(entry.id) || this.before.has(entry.id)) return false;
    const key = `${entry.agent}:${entry.id}`;
    if (this.rows.has(key)) return false;
    this.rows.set(key, entry);
    appendFileSync(this.file, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`);
    return true;
  }

  entries(task?: string | null): LedgerEntry[] {
    return [...this.rows.values()].filter((row) => task === undefined || row.task === task);
  }

  mayDelete(id: string): boolean {
    return SESSION_ID.test(id) && !this.protect.has(id) && !this.before.has(id) && [...this.rows.values()].some((row) => row.id === id);
  }
}

/** A node's conversation sessions on this computer (turn-sessions.ts), with the ones they replaced. */
export function turnSessions(stateDir: string): Array<{ agent: string; id: string; folder: string | null }> {
  const file = join(stateDir, "assistant-sessions.json");
  if (!existsSync(file)) return [];
  try {
    const store = JSON.parse(readFileSync(file, "utf8")) as Record<string, { agent?: string; id?: string; retired?: string[]; folder?: string; dir?: string }>;
    return Object.entries(store).flatMap(([key, entry]) => {
      const folder = entry.folder ?? join(stateDir, "assistant", entry.dir ?? key);
      return [entry.id, ...(entry.retired ?? [])].filter((id): id is string => Boolean(id)).map((id) => ({ agent: entry.agent ?? "copilot-cli", id, folder }));
    });
  } catch {
    return [];
  }
}

/** Coding sessions the runs on this computer started (an `engine` event names each). */
export async function codingSessions(prisma: World["prisma"]): Promise<Array<{ agent: string; id: string; folder: string | null }>> {
  const events = await prisma.workspaceEvent.findMany({ where: { kind: "engine" }, select: { jobId: true, data: true } });
  if (!events.length) return [];
  const jobs = await prisma.workspaceJob.findMany({ where: { id: { in: [...new Set(events.map((row) => row.jobId))] } }, select: { id: true, provider: true, externalRoot: true, repoPath: true } });
  return events.flatMap((event) => {
    const session = (event.data as { session?: unknown } | null)?.session;
    const job = jobs.find((row) => row.id === event.jobId);
    if (typeof session !== "string" || !job?.provider) return [];
    return [{ agent: job.provider, id: session, folder: job.externalRoot ?? (job.repoPath || null) }];
  });
}

/** Copilot sessions whose working folder is inside `root` (made by this run, whatever started them). */
export function copilotSessionsIn(root: string): string[] {
  const found: string[] = [];
  for (const id of copilotSessionIds()) {
    try {
      const yaml = readFileSync(join(stateRoot(), id, "workspace.yaml"), "utf8");
      const cwd = /^cwd:\s*(.+)$/m.exec(yaml)?.[1]?.trim().replace(/^["']|["']$/g, "");
      if (cwd && (cwd === root || cwd.startsWith(`${root}/`))) found.push(id);
    } catch {
      // A session folder without its workspace file is not one this run can place.
    }
  }
  return found;
}

export type SessionUsage = { modelCalls: number; tokensIn: number; tokensOut: number; nanoAiu: number; models: string[]; tools: string[] };

/** What a Copilot session's own log records: each model call with its tokens, and each tool the agent called. */
export function copilotUsage(id: string): SessionUsage | null {
  const file = join(stateRoot(), id, "events.jsonl");
  if (!existsSync(file)) return null;
  const usage: SessionUsage = { modelCalls: 0, tokensIn: 0, tokensOut: 0, nanoAiu: 0, models: [], tools: [] };
  const models = new Set<string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let event: { type?: string; data?: Record<string, unknown> };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const data = event.data ?? {};
    if (event.type === "session.usage_record") {
      const row = (data.usage ?? {}) as { model?: unknown; inputTokens?: unknown; outputTokens?: unknown; copilotUsage?: { totalNanoAiu?: unknown } };
      usage.modelCalls += 1;
      if (typeof row.inputTokens === "number") usage.tokensIn += row.inputTokens;
      if (typeof row.outputTokens === "number") usage.tokensOut += row.outputTokens;
      if (typeof row.copilotUsage?.totalNanoAiu === "number") usage.nanoAiu += row.copilotUsage.totalNanoAiu;
      if (typeof row.model === "string") models.add(row.model);
    } else if (event.type === "tool.execution_start" && typeof data.toolName === "string") {
      usage.tools.push(data.toolName);
    }
  }
  usage.models = [...models];
  return usage;
}

/** Rows of a session in Copilot's session store, table by table (an empty object when none or no store). */
async function storeRows(id: string, remove: boolean): Promise<Record<string, number>> {
  const file = join(copilotHome(), "session-store.db");
  if (!existsSync(file)) return {};
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, remove ? {} : { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const tables = (db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string; sql: string | null }>).filter(
      (row) => /\bsession_id\b/.test(row.sql ?? "") && !/^search_index_/.test(row.name),
    );
    const counts: Record<string, number> = {};
    const where = (table: string) => (table === "sessions" ? "id" : "session_id");
    const all = [...tables.map((row) => row.name), ...((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").all() as Array<{ name: string }>).length ? ["sessions"] : [])];
    for (const table of all) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${where(table)} = ?`).get(id) as { n: number };
      if (row.n) counts[table] = row.n;
    }
    if (remove && Object.keys(counts).length) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const table of Object.keys(counts).filter((name) => name !== "sessions")) db.prepare(`DELETE FROM "${table}" WHERE session_id = ?`).run(id);
        if (counts.sessions) db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    return counts;
  } finally {
    db.close();
  }
}

/**
 * Deletes each recorded session with Ensemble's own deletion (the agent's), then makes sure Copilot
 * kept nothing of it: its session folder and its store rows go too. Only sessions the ledger may delete.
 */
export async function deleteSessions(ledger: SessionLedger, entries: LedgerEntry[], log: (line: string) => void): Promise<CleanupEntry[]> {
  const { deleteNativeSession } = await import("../../../apps/hub-api/src/workspace/engines/delete-session.js");
  const done: CleanupEntry[] = [];
  for (const entry of entries) {
    if (!ledger.mayDelete(entry.id)) {
      done.push({ agent: entry.agent, id: entry.id, kind: entry.kind, task: entry.task, deleted: false, note: "not this run's to delete" });
      continue;
    }
    const notes: string[] = [];
    try {
      await deleteNativeSession(entry.agent as never, entry.id, entry.folder && existsSync(entry.folder) ? entry.folder : process.cwd());
    } catch (error) {
      notes.push(error instanceof Error ? error.message.slice(0, 200) : String(error));
    }
    let gone = true;
    if (entry.agent === "copilot-cli") {
      const folder = join(stateRoot(), entry.id);
      if (existsSync(folder) && UUID.test(entry.id)) {
        rmSync(folder, { recursive: true, force: true });
        notes.push("its session folder was removed by the harness");
      }
      try {
        const left = await storeRows(entry.id, true);
        if (Object.keys(left).length) notes.push(`its session-store rows were removed by the harness (${Object.entries(left).map(([table, n]) => `${table} ${n}`).join(", ")})`);
        gone = !existsSync(folder) && !Object.keys(await storeRows(entry.id, false)).length;
      } catch (error) {
        notes.push(`session store: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`);
        gone = !existsSync(folder);
      }
    }
    done.push({ agent: entry.agent, id: entry.id, kind: entry.kind, task: entry.task, deleted: gone, ...(notes.length ? { note: notes.join("; ") } : {}) });
    log(`session ${entry.id} (${entry.kind}): ${gone ? "deleted" : "left"}${notes.length ? ` · ${notes.join("; ")}` : ""}`);
  }
  return done;
}
