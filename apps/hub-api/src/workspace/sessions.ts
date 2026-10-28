/**
 * Agent sessions: the person's own coding agent (Claude Code, Codex, Cursor, GitHub Copilot and the
 * ACP agents) keeps a conversation per run (Claude Code's session, Codex's thread, an ACP session),
 * recorded on the run's `engine` event. A run that continues an earlier run by the same agent
 * (`continueFromJobId`: Continue an earlier task, Run again, a carry-on, a chat message, the
 * assistant assigning into a session) resumes that conversation, so a session is the chain of such
 * runs. Its id is the first run's job id, which never changes. Nothing is stored beyond the jobs and
 * their events, so every earlier chain is a session too, on this server and on a paired computer's
 * own runtime alike.
 */
import type { Prisma, PrismaClient, WorkspaceJobStatus } from "@prisma/client";
import { CODE_ENGINES, ENGINE_LABELS, isCodeEngine, type CodeEngine } from "@ensemble/shared-types";
import { currentDevices } from "../devices/successor.js";

/** Whose runs: the space, and in a space shared with someone, only the runs they started. */
export type SessionScope = { space: string; runner: string | null };

export type AgentSessionStatus = "working" | "waiting" | "queued" | "idle";

export type AgentSession = {
  id: string;
  agent: CodeEngine;
  agentName: string;
  /** The model the latest run asked for ("default": the agent's own), and its tuning, which a new task in the session keeps. */
  model: string;
  effort: string | null;
  contextTier: "long_context" | null;
  fast: boolean;
  /** The paired computer it runs on (its current pairing's id on this server), or null for this computer. */
  deviceId: string | null;
  computer: string | null;
  /** A folder the computer shares, the folder's name, or "its own checkout". */
  folder: string;
  /** The first task's title. */
  title: string;
  latestTask: { id: string; title: string };
  /** One or two lines: what the latest run did, or what it is doing. */
  summary: string;
  status: AgentSessionStatus;
  /** How the latest run ended or where it is (succeeded, failed, running…). */
  lastStatus: string;
  /** The run a new task in this session continues from. */
  lastJobId: string;
  runs: number;
  tasks: number;
  /** The agent's own conversation is known, so the next run resumes it (else it starts one in the same folder). */
  resumable: boolean;
  chat: boolean;
  startedAt: string;
  lastActiveAt: string;
};

const WAITING: WorkspaceJobStatus[] = ["queued", "claimed", "running", "waiting_approval", "stopping"];
const SELECT = {
  id: true,
  taskId: true,
  status: true,
  provider: true,
  model: true,
  reasoningEffort: true,
  deviceId: true,
  folderLabel: true,
  repoPath: true,
  externalRoot: true,
  continueFromJobId: true,
  summary: true,
  progress: true,
  error: true,
  context: true,
  createdAt: true,
  startedAt: true,
  claimedAt: true,
  finishedAt: true,
  task: { select: { title: true } },
  device: { select: { name: true } },
} as const;

type Row = {
  id: string;
  taskId: string;
  status: string;
  provider: string | null;
  model: string;
  reasoningEffort: string | null;
  deviceId: string | null;
  folderLabel: string | null;
  repoPath: string | null;
  externalRoot: string | null;
  continueFromJobId: string | null;
  summary: string | null;
  progress: string | null;
  error: string | null;
  context: unknown;
  createdAt: Date;
  startedAt: Date | null;
  claimedAt: Date | null;
  finishedAt: Date | null;
  task: { title: string };
  device: { name: string } | null;
};

/** The first one or two sentences of a run's summary, within `max` characters. */
export function summaryLine(text: string | null | undefined, max = 220): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const sentences = flat.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [flat];
  let line = "";
  for (const sentence of sentences.slice(0, 2)) {
    if ((line + sentence).length > max && line) break;
    line += sentence;
  }
  line = (line || flat).trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function statusOf(status: string): AgentSessionStatus {
  if (status === "waiting_approval") return "waiting";
  if (status === "queued") return "queued";
  return ["claimed", "running", "stopping"].includes(status) ? "working" : "idle";
}

function folderOf(row: Row): string {
  if (row.folderLabel) return row.folderLabel;
  const path = row.externalRoot ?? "";
  return path ? (path.split(/[\\/]/).filter(Boolean).pop() ?? path) : "its own checkout";
}

const contextOf = (context: unknown) => (typeof context === "object" && context !== null ? (context as { chat?: unknown; contextTier?: unknown; fast?: unknown }) : {});
const isChat = (context: unknown) => contextOf(context).chat === true;

/** The runs of the scope's agent sessions, newest first, with the earlier runs their chains start from. */
async function sessionRuns(prisma: PrismaClient, scope: SessionScope, where: Prisma.WorkspaceJobWhereInput = {}, take = 300, onlyRan = true): Promise<Map<string, Row>> {
  const base = { userId: scope.space, runnerAccountId: scope.runner, kind: "code", provider: { in: [...CODE_ENGINES] } };
  const rows = (await prisma.workspaceJob.findMany({
    where: { ...base, ...where, ...(onlyRan ? { OR: [{ startedAt: { not: null } }, { claimedAt: { not: null } }, { status: { in: WAITING } }] } : {}) },
    orderBy: { createdAt: "desc" },
    take,
    select: SELECT,
  })) as Row[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  // The chains may start before the newest runs: bring in the earlier runs they continue.
  for (let round = 0; round < 6; round += 1) {
    const missing = [...new Set([...byId.values()].map((row) => row.continueFromJobId).filter((id): id is string => Boolean(id) && !byId.has(id!)))];
    if (!missing.length) break;
    const earlier = (await prisma.workspaceJob.findMany({ where: { ...base, id: { in: missing } }, select: SELECT })) as Row[];
    if (!earlier.length) break;
    for (const row of earlier) byId.set(row.id, row);
  }
  return byId;
}

/** A run's session: walk back while the earlier run is by the same agent. */
function rootOf(byId: Map<string, Row>, id: string): string {
  let root = byId.get(id);
  for (let hops = 0; root && hops < 200; hops += 1) {
    const parent = root.continueFromJobId ? byId.get(root.continueFromJobId) : undefined;
    if (!parent || parent.provider !== root.provider) break;
    root = parent;
  }
  return root?.id ?? id;
}

async function resumableJobs(prisma: PrismaClient, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const events = await prisma.workspaceEvent.findMany({ where: { jobId: { in: ids }, kind: "engine" }, select: { jobId: true, data: true } });
  return new Set(events.filter((event) => typeof (event.data as { session?: unknown } | null)?.session === "string").map((event) => event.jobId));
}

/** The run reached its computer (or is on its way): a later run can continue its folder and conversation. */
const ran = (row: Row) => Boolean(row.startedAt || row.claimedAt) || (WAITING as string[]).includes(row.status);

function build(rootId: string, runs: Row[], resumable: Set<string>): AgentSession {
  const ordered = [...runs].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const first = ordered[0]!;
  const last = [...ordered].reverse().find(ran) ?? ordered[ordered.length - 1]!;
  const finished = [...ordered].reverse().find((row) => row.summary?.trim());
  // A new task continues the end of the chain, which a steer (Ensemble Node) may have moved off the newest run.
  const continued = new Set(ordered.map((row) => row.continueFromJobId).filter((id): id is string => Boolean(id)));
  const tail = [...ordered].reverse().find((row) => !continued.has(row.id) && ran(row)) ?? last;
  const live = statusOf(last.status);
  const summary = live === "idle" ? summaryLine(last.summary || last.error || finished?.summary) : summaryLine(last.progress || finished?.summary) || "Starting";
  const agent = first.provider as CodeEngine;
  return {
    id: rootId,
    agent,
    agentName: ENGINE_LABELS[agent],
    model: last.model,
    effort: last.reasoningEffort,
    contextTier: contextOf(last.context).contextTier === "long_context" ? "long_context" : null,
    fast: contextOf(last.context).fast === true,
    deviceId: last.deviceId,
    computer: last.device?.name ?? null,
    // A continued run carries no folder label of its own: the session's folder is its nearest run's.
    folder: folderOf([...ordered].reverse().find((row) => row.folderLabel || row.externalRoot) ?? last),
    title: first.task.title,
    latestTask: { id: last.taskId, title: last.task.title },
    summary,
    status: live,
    lastStatus: last.status,
    lastJobId: tail.id,
    runs: ordered.length,
    tasks: new Set(ordered.map((row) => row.taskId)).size,
    resumable: ordered.some((row) => resumable.has(row.id)),
    chat: ordered.every((row) => isChat(row.context)),
    startedAt: first.createdAt.toISOString(),
    lastActiveAt: (last.finishedAt ?? last.createdAt).toISOString(),
  };
}

/** Sessions on a computer paired again point at its current pairing, where a new task in them goes. */
async function onCurrentPairing(prisma: PrismaClient, sessions: AgentSession[]): Promise<AgentSession[]> {
  const ids = [...new Set(sessions.map((row) => row.deviceId).filter((id): id is string => Boolean(id)))];
  if (!ids.length) return sessions;
  const current = await currentDevices(prisma, await prisma.device.findMany({ where: { id: { in: ids } } }));
  return sessions.map((row) => {
    const now = row.deviceId ? current.get(row.deviceId) : null;
    return now && now.id !== row.deviceId ? { ...row, deviceId: now.id, computer: now.name } : row;
  });
}

/** The scope's agent sessions, most recently active first. */
export async function listSessions(
  prisma: PrismaClient,
  scope: SessionScope,
  filter: { taskId?: string | null; deviceIds?: string[] | null; query?: string | null; limit?: number } = {},
): Promise<AgentSession[]> {
  const byId = await sessionRuns(prisma, scope);
  const groups = new Map<string, Row[]>();
  for (const row of byId.values()) {
    const root = rootOf(byId, row.id);
    groups.set(root, [...(groups.get(root) ?? []), row]);
  }
  const resumable = await resumableJobs(prisma, [...byId.keys()]);
  const needle = filter.query?.trim().toLowerCase();
  const built = [...groups.entries()].map(([root, runs]) => ({ root, runs }));
  const sessions = await onCurrentPairing(prisma, built.map(({ root, runs }) => build(root, runs, resumable)));
  return built
    .map(({ runs }, index) => ({ session: sessions[index]!, runs }))
    .filter(({ session, runs }) => !filter.taskId || runs.some((row) => row.taskId === filter.taskId) || session.latestTask.id === filter.taskId)
    .filter(({ session }) => !filter.deviceIds?.length || (session.deviceId !== null && filter.deviceIds.includes(session.deviceId)))
    .filter(({ session, runs }) => !needle || [session.title, session.summary, session.folder, session.agentName, session.computer ?? "", ...runs.map((row) => row.task.title)].some((text) => text.toLowerCase().includes(needle)))
    .map(({ session }) => session)
    .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
    .slice(0, Math.max(1, Math.min(filter.limit ?? 20, 100)));
}

/**
 * A session by its id, or by any run in it: every run of it, the newest being the one a new task
 * continues from. Null when it is not the scope's, or not a coding agent's run.
 */
export async function resolveSession(prisma: PrismaClient, scope: SessionScope, id: string): Promise<AgentSession | null> {
  // Any run, as listSessions roots a chain at its first run even when that one never started; walked to the real root however long the chain.
  const job = await prisma.workspaceJob.findFirst({ where: { id, userId: scope.space, runnerAccountId: scope.runner }, select: { id: true, userId: true, runnerAccountId: true, provider: true, kind: true } });
  const root = job ? await sessionOfJob(prisma, job) : null;
  return root ? sessionFrom(prisma, scope, root.id) : null;
}

/** The runs of the session that starts at `root`: it and the runs that continue it by the same agent, transitively. */
async function chainFrom(prisma: PrismaClient, scope: SessionScope, root: string): Promise<Row[]> {
  const first = (await prisma.workspaceJob.findFirst({ where: { id: root, userId: scope.space, runnerAccountId: scope.runner }, select: SELECT })) as Row | null;
  if (!first || !isCodeEngine(first.provider)) return [];
  const runs: Row[] = [first];
  let frontier = [root];
  for (let round = 0; frontier.length && round < 200 && runs.length < 500; round += 1) {
    const next = (await prisma.workspaceJob.findMany({ where: { userId: scope.space, runnerAccountId: scope.runner, continueFromJobId: { in: frontier }, provider: first.provider }, select: SELECT })) as Row[];
    runs.push(...next);
    frontier = next.map((row) => row.id);
  }
  return runs;
}

async function sessionFrom(prisma: PrismaClient, scope: SessionScope, root: string): Promise<AgentSession | null> {
  const runs = await chainFrom(prisma, scope, root);
  if (!runs.length) return null;
  const [session] = await onCurrentPairing(prisma, [build(root, runs, await resumableJobs(prisma, runs.map((row) => row.id)))]);
  return session ?? null;
}

export type SessionRun = {
  id: string;
  taskId: string;
  title: string;
  status: string;
  continueFromJobId: string | null;
  summary: string | null;
  progress: string | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  claimedAt: Date | null;
  finishedAt: Date | null;
};

/** Every run of a session (`root` is its id), oldest first: what Ensemble Node steers, queues behind and stops. */
export async function runsOfSession(prisma: PrismaClient, scope: SessionScope, root: string): Promise<SessionRun[]> {
  const runs = await chainFrom(prisma, scope, root);
  return runs
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((row) => ({
      id: row.id,
      taskId: row.taskId,
      title: row.task.title,
      status: row.status,
      continueFromJobId: row.continueFromJobId,
      summary: row.summary,
      progress: row.progress,
      error: row.error,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      claimedAt: row.claimedAt,
      finishedAt: row.finishedAt,
    }));
}

/** Still to finish: queued, or on its computer (working, waiting on Needs me, stopping). */
export const LIVE_RUN = new Set<string>(WAITING);

/** The session a run belongs to, for its detail view: its id, and whether the agent's own conversation is known. */
export async function sessionOfJob(prisma: PrismaClient, job: { id: string; userId: string; runnerAccountId: string | null; provider: string | null; kind: string }): Promise<{ id: string; resumable: boolean } | null> {
  if (job.kind !== "code" || !isCodeEngine(job.provider)) return null;
  let current: { id: string; provider: string | null; continueFromJobId: string | null } | null = { id: job.id, provider: job.provider, continueFromJobId: null };
  const own = await prisma.workspaceJob.findUnique({ where: { id: job.id }, select: { continueFromJobId: true } });
  current.continueFromJobId = own?.continueFromJobId ?? null;
  for (let hops = 0; current?.continueFromJobId && hops < 200; hops += 1) {
    const parent: { id: string; provider: string | null; continueFromJobId: string | null } | null = await prisma.workspaceJob.findFirst({
      where: { id: current.continueFromJobId, userId: job.userId },
      select: { id: true, provider: true, continueFromJobId: true },
    });
    if (!parent || parent.provider !== job.provider) break;
    current = parent;
  }
  const resumable = (await resumableJobs(prisma, [job.id])).has(job.id);
  return { id: current?.id ?? job.id, resumable };
}
