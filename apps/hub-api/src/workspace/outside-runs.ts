/**
 * What the person did in an agent's own app, for coding runs (docs/41 §1, §2; subscriptions/outside.ts for
 * chats). Nothing is watched: only when Ensemble is about to use something it owns.
 *
 * - A run that continues a session brings in what the person said in it since Ensemble's last run there: a
 *   step on the run ("From the Claude app") and a short note leading its brief, then the session goes on.
 *   Each run notes how many prompts its session holds when it ends (`session_prompts`, a local event).
 * - A new task in an Ensemble project lists the sessions the person started themselves in the project's
 *   folder since the project's last Ensemble run (a Claude Code or Copilot session there, a thread in its
 *   Codex project): title, last message and files changed. Ensemble only reads them, and never resumes,
 *   renames, moves or deletes them; its clean-up deletes only sessions its own runs recorded.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { CodeEngine, SubscriptionProvider } from "@ensemble/shared-types";
import { claudeTurns, codexTurns, copilotTurns, outsideOf, readOutside, type Outside, type OutsideTurn } from "../subscriptions/outside.js";
import { claudeProjectName, sessionPrompts } from "../subscriptions/session-touch.js";

type Events = Pick<PrismaClient, "workspaceEvent">;

/** The Codex thread's turns as exchanges, read on a short-lived app-server; null without Codex or `thread/read`. */
async function codexThread(threadId: string): Promise<OutsideTurn[] | null> {
  const { withCodexServer } = await import("./engines/delete-session.js");
  const read = await withCodexServer(async (rpc) => (await rpc.request("thread/read", { threadId, includeTurns: true })) as { thread?: Parameters<typeof codexTurns>[0] }).catch(() => null);
  return read?.value ? codexTurns(read.value.thread) : null;
}

/** How many prompts the agent's session holds now; null when that cannot be read here (other agents). */
export async function sessionPromptCount(engine: CodeEngine, session: string, folder: string): Promise<number | null> {
  if (engine === "codex") return (await codexThread(session))?.length ?? null;
  if (engine === "claude-code" || engine === "copilot-cli") return sessionPrompts(engine as SubscriptionProvider, session, folder);
  return null;
}

/** Notes how many prompts a run's session holds as it ends, for the next run in it. Never fails the run. */
export async function noteSessionPrompts(ctx: { event: (kind: string, data: Record<string, unknown>) => Promise<void> }, engine: CodeEngine, session: string, folder: string): Promise<void> {
  const prompts = await sessionPromptCount(engine, session, folder).catch(() => null);
  if (prompts !== null) await ctx.event("session_prompts", { session, prompts }).catch(() => undefined);
}

/**
 * What the person said in this agent session since Ensemble's last run in it, or null: nothing was, the
 * agent's history cannot be read here, or no run noted the session's prompts yet.
 */
export async function runOutside(prisma: Events, engine: CodeEngine, session: string, folder: string): Promise<Outside | null> {
  const mark = await prisma.workspaceEvent.findFirst({ where: { kind: "session_prompts", data: { path: ["session"], equals: session } }, orderBy: { sequence: "desc" }, select: { data: true } });
  const since = (mark?.data as { prompts?: unknown } | null)?.prompts;
  if (typeof since !== "number") return null;
  if (engine === "codex") {
    const turns = await codexThread(session);
    return turns ? outsideOf("Codex", turns, since) : null;
  }
  if (engine === "claude-code" || engine === "copilot-cli") return readOutside(engine as SubscriptionProvider, session, folder, since);
  return null;
}

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/** The step on the run: each exchange, the person's words and the agent's answer. */
export function outsideStep(outside: Outside, person: string | null): string {
  const who = person?.trim() || "You";
  const lines = outside.turns.flatMap((turn) => [`${who}: ${clip(turn.prompt, 600)}`, ...(turn.answer || turn.tools ? [`Agent: ${clip([turn.answer, turn.tools ? `(${turn.tools})` : ""].filter(Boolean).join(" "), 600)}`] : []), ""]);
  return [outside.earlier ? `…and ${outside.earlier} earlier message${outside.earlier === 1 ? "" : "s"} in ${outside.app}.` : "", ...lines].filter((line, index) => line || index).join("\n").trim();
}

/** The note leading the brief of a run that goes on after the person used the session in the agent's app. */
export function outsideNote(outside: Outside, person: string | null): string {
  const who = person?.trim() || "The person";
  const said = outside.turns.map((turn) => `- "${clip(turn.prompt, 300)}"${turn.tools ? ` (you ${turn.tools[0]!.toLowerCase()}${turn.tools.slice(1)})` : ""}`);
  return [
    `(Since the last Ensemble run, ${who} said in ${outside.app}${outside.earlier ? `, after ${outside.earlier} earlier message${outside.earlier === 1 ? "" : "s"}` : ""}:`,
    ...said,
    "That is part of this conversation already: take it into account.)",
  ].join("\n");
}

/** A session the person started themselves in a project's folder. */
export type OwnSession = { app: string; title: string; last: string; files: string[]; at: string };

const SEEN_FILES = 5;
const MAX_LISTED = 5;
/** Edited files in a tool line are counted, not named: their names come from the turns' tools where an agent records them. */
const filesOf = (turns: OutsideTurn[]) => [...new Set(turns.flatMap((turn) => turn.files ?? []))].slice(0, SEEN_FILES);

/** Sessions Ensemble itself made (its runs' `engine` events and its chats' sessions on this computer): never listed. */
async function ensembleSessions(prisma: Events): Promise<Set<string>> {
  const rows = await prisma.workspaceEvent.findMany({ where: { kind: "engine" }, select: { data: true }, orderBy: { sequence: "desc" }, take: 5_000 });
  const ids = new Set(rows.map((row) => (row.data as { session?: unknown } | null)?.session).filter((id): id is string => typeof id === "string" && Boolean(id)));
  const { stateDir } = await import("../remote/store.js");
  const store = await readFile(join(stateDir(), "assistant-sessions.json"), "utf8").then((text) => JSON.parse(text) as Record<string, { id?: string; retired?: string[] }>, () => ({}) as Record<string, { id?: string; retired?: string[] }>);
  for (const entry of Object.values(store)) for (const id of [entry?.id, ...(entry?.retired ?? [])]) if (typeof id === "string" && id) ids.add(id);
  return ids;
}

const modified = (path: string) => stat(path).then((info) => info.mtimeMs, () => 0);

async function claudeSessions(folder: string, since: number, ours: Set<string>): Promise<OwnSession[]> {
  const dir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects", claudeProjectName(folder));
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".jsonl") && !ours.has(name.slice(0, -6)));
  const recent = (await Promise.all(names.map(async (name) => ({ name, at: await modified(join(dir, name)) })))).filter((row) => row.at > since).sort((a, b) => b.at - a.at).slice(0, MAX_LISTED);
  const out: OwnSession[] = [];
  for (const row of recent) {
    const { turns, app } = await claudeTurns(join(dir, row.name));
    if (!turns.length) continue;
    out.push({ app, title: clip(turns[0]!.prompt, 80), last: clip(turns.at(-1)!.prompt, 200), files: filesOf(turns), at: new Date(row.at).toISOString() });
  }
  return out;
}

async function copilotSessions(folder: string, since: number, ours: Set<string>): Promise<OwnSession[]> {
  const root = join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "session-state");
  const ids = (await readdir(root).catch(() => [] as string[])).filter((id) => !ours.has(id));
  const recent = (await Promise.all(ids.map(async (id) => ({ id, at: await modified(join(root, id, "events.jsonl")) })))).filter((row) => row.at > since).sort((a, b) => b.at - a.at);
  const out: OwnSession[] = [];
  for (const row of recent) {
    if (out.length >= MAX_LISTED) break;
    const path = join(root, row.id, "events.jsonl");
    const first = (await readFile(path, "utf8").catch(() => "")).split("\n", 1)[0] ?? "";
    let cwd: unknown;
    try {
      cwd = (JSON.parse(first) as { data?: { context?: { cwd?: unknown } } }).data?.context?.cwd;
    } catch {
      continue;
    }
    if (typeof cwd !== "string" || cwd.replace(/[\\/]+$/, "") !== folder.replace(/[\\/]+$/, "")) continue;
    const turns = await copilotTurns(path);
    if (!turns.length) continue;
    out.push({ app: "GitHub Copilot", title: clip(turns[0]!.prompt, 80), last: clip(turns.at(-1)!.prompt, 200), files: filesOf(turns), at: new Date(row.at).toISOString() });
  }
  return out;
}

async function codexSessions(project: { id: string; folder: string }, since: number, ours: Set<string>): Promise<OwnSession[]> {
  const { withCodexServer } = await import("./engines/delete-session.js");
  const { listCodexProjects } = await import("./engines/app-sessions.js");
  const found = await withCodexServer(async (rpc) => {
    // Only a Codex project that is there already: listing never makes one.
    const rows = await listCodexProjects(rpc);
    const ours_ = rows.find((row) => row.metadata?.ensembleProjectId === project.id) ?? rows.find((row) => (row.roots ?? []).some((root) => root.path?.replace(/[\\/]+$/, "") === project.folder.replace(/[\\/]+$/, "")));
    if (!ours_?.id) return [];
    const listed = (await rpc.request("thread/list", { projectId: ours_.id, archived: false, useStateDbOnly: true, limit: 50 })) as { data?: Array<{ id?: unknown }> };
    const out: OwnSession[] = [];
    for (const thread of listed.data ?? []) {
      if (out.length >= MAX_LISTED || typeof thread.id !== "string" || ours.has(thread.id)) continue;
      const read = (await rpc.request("thread/read", { threadId: thread.id, includeTurns: true }).catch(() => null)) as { thread?: Parameters<typeof codexTurns>[0] } | null;
      const turns = codexTurns(read?.thread);
      const at = Date.parse(turns.at(-1)?.at ?? "");
      if (!turns.length || !(at > since)) continue;
      out.push({ app: "Codex", title: clip(turns[0]!.prompt, 80), last: clip(turns.at(-1)!.prompt, 200), files: filesOf(turns), at: new Date(at).toISOString() });
    }
    return out;
  }).catch(() => null);
  return found?.value ?? [];
}

/**
 * The sessions the person started themselves in an Ensemble project's folder since `since` (the project's
 * last Ensemble run), newest first: Claude Code's and Copilot's there, and the threads of its Codex project.
 * Never those Ensemble made. Read only.
 */
export async function projectSessions(prisma: Events, project: { id: string; folder: string }, since: Date, engines: { codex?: boolean } = {}): Promise<OwnSession[]> {
  const ours = await ensembleSessions(prisma);
  const time = since.getTime();
  const found = (
    await Promise.all([
      claudeSessions(project.folder, time, ours).catch(() => []),
      copilotSessions(project.folder, time, ours).catch(() => []),
      engines.codex === false ? Promise.resolve([]) : codexSessions(project, time, ours).catch(() => []),
    ])
  ).flat();
  return found.sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_LISTED);
}

/** The brief's section listing them, so the task knows what the person did there on their own. */
export function projectSessionsNote(sessions: OwnSession[], person: string | null): string {
  if (!sessions.length) return "";
  const who = person?.trim() || "The person";
  return [
    `## Sessions ${who} started in this project outside Ensemble`,
    `Since this project's last Ensemble run, ${who} worked in its folder in these sessions of their own. They are theirs: read them for context if it helps, but do not continue, rename or delete them.`,
    ...sessions.map((session) => `- In ${session.app}: "${session.title}"; last message: "${session.last}"${session.files.length ? `; files changed: ${session.files.join(", ")}` : ""}`),
  ].join("\n");
}
