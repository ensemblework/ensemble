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
  queuePosition: true,
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
  queuePosition: number | null;
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
  /** Its place among the session's queued runs (`queuedOrder`); null: creation order. */
  queuePosition: number | null;
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
      queuePosition: row.queuePosition,
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

// ── A session's queue (Ensemble Node's session manager, docs/35 §8.9) ────────────────────────────

/** On a computer, or on its way there: a session runs one of these at a time. */
const ON_COMPUTER = new Set<string>(["claimed", "running", "waiting_approval", "stopping"]);

export type QueueEntry = { id: string; status: string; continueFromJobId: string | null; queuePosition: number | null; createdAt: Date };

const byCreated = (a: { createdAt: Date }, b: { createdAt: Date }) => a.createdAt.getTime() - b.createdAt.getTime();

/** Live runs along `continueFromJobId`: how a queue from before queue positions runs. */
function chainOrder<T extends QueueEntry>(runs: readonly T[]): T[] {
  const live = runs.filter((row) => LIVE_RUN.has(row.status));
  const ids = new Set(live.map((row) => row.id));
  const after = new Map<string, T[]>();
  for (const row of live) if (row.continueFromJobId && ids.has(row.continueFromJobId)) after.set(row.continueFromJobId, [...(after.get(row.continueFromJobId) ?? []), row]);
  const out: T[] = [];
  const seen = new Set<string>();
  const walk = (row: T) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    out.push(row);
    for (const next of [...(after.get(row.id) ?? [])].sort(byCreated)) walk(next);
  };
  for (const head of live.filter((row) => !row.continueFromJobId || !ids.has(row.continueFromJobId)).sort(byCreated)) walk(head);
  return out;
}

/**
 * A session's queued runs in the order they start. Its first run (`rootId`) always goes first; the
 * others by queue position (set when a message is queued or steers, and when the queue is reordered),
 * then by when they were made. A queue from before positions follows `continueFromJobId`. The order is
 * separate from `continueFromJobId`, which is set to the run that actually ran before when a run is
 * claimed (`sessionTurn`).
 */
export function queuedOrder<T extends QueueEntry>(runs: readonly T[], rootId: string): T[] {
  const queued = runs.filter((row) => row.status === "queued");
  if (!queued.some((row) => row.queuePosition !== null)) return chainOrder(runs).filter((row) => row.status === "queued");
  const rank = (row: T) => row.queuePosition ?? Number.MAX_SAFE_INTEGER;
  return [...queued.filter((row) => row.id === rootId), ...queued.filter((row) => row.id !== rootId).sort((a, b) => rank(a) - rank(b) || byCreated(a, b))];
}

/** A session's runs still to finish, in the order they run: the one on its computer, then the queue. */
export function liveOrder<T extends QueueEntry>(runs: readonly T[], rootId: string): T[] {
  return [...runs.filter((row) => ON_COMPUTER.has(row.status)).sort(byCreated), ...queuedOrder(runs, rootId)];
}

/** When a run reached its computer: claimed there, or started on this one. */
const ranAt = (row: { claimedAt: Date | null; startedAt: Date | null }) => row.claimedAt ?? row.startedAt;

type Db = PrismaClient | Prisma.TransactionClient;

const QUEUE_SELECT = {
  id: true,
  userId: true,
  runnerAccountId: true,
  kind: true,
  provider: true,
  status: true,
  continueFromJobId: true,
  queuePosition: true,
  createdAt: true,
  claimedAt: true,
  startedAt: true,
  folderLabel: true,
  repoUrl: true,
} as const;
type QueueRow = Prisma.WorkspaceJobGetPayload<{ select: typeof QUEUE_SELECT }>;
type Owner = { userId: string; runnerAccountId: string | null };

/**
 * The session's lock, held to the end of the transaction. Every claim of one of its queued runs and
 * every change to its queue take it, so a reorder, a cancel or a steer never interleaves with a claim.
 */
export async function lockSession(tx: Prisma.TransactionClient, rootId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS held FROM pg_advisory_xact_lock(hashtext(${`ensemble:session:${rootId}`}))`;
}

/** The first run of the session a run belongs to: back along `continueFromJobId` while the earlier run is by the same agent. */
async function rootOfRun(db: Db, run: { id: string; userId: string; provider: string | null; continueFromJobId: string | null }): Promise<string> {
  let current: { id: string; continueFromJobId: string | null } = run;
  const seen = new Set([run.id]);
  for (let hops = 0; current.continueFromJobId && hops < 200; hops += 1) {
    const parent = await db.workspaceJob.findFirst({ where: { id: current.continueFromJobId, userId: run.userId }, select: { id: true, provider: true, continueFromJobId: true } });
    if (!parent || parent.provider !== run.provider || seen.has(parent.id)) break;
    seen.add(parent.id);
    current = parent;
  }
  return current.id;
}

/** Every run of the session that starts at `root`, by its agent (as `chainFrom`, inside a transaction too). */
async function queueRows(db: Db, owner: Owner, root: string): Promise<QueueRow[]> {
  const first = await db.workspaceJob.findFirst({ where: { id: root, userId: owner.userId, runnerAccountId: owner.runnerAccountId }, select: QUEUE_SELECT });
  if (!first) return [];
  const rows = [first];
  const seen = new Set([root]);
  let frontier = [root];
  for (let round = 0; frontier.length && round < 200 && rows.length < 500; round += 1) {
    const next = (await db.workspaceJob.findMany({ where: { userId: owner.userId, runnerAccountId: owner.runnerAccountId, continueFromJobId: { in: frontier }, provider: first.provider }, select: QUEUE_SELECT })).filter((row) => !seen.has(row.id));
    for (const row of next) seen.add(row.id);
    rows.push(...next);
    frontier = next.map((row) => row.id);
  }
  return rows;
}

export type SessionTurn = { wait: true } | { wait: false; links: { continueFromJobId: string; folderLabel?: string | null; repoUrl?: string | null } };

/**
 * Whether a queued run that continues an agent session may start now, and the run it continues. Called
 * inside the claim's transaction (`claimQueuedJob`, both the server's queue and a computer's claim),
 * under the session's lock. It waits while another of the session's runs is on a computer or ahead of
 * it in the queue. It then continues the run that actually ran last, so resume ancestry stays one true
 * line whatever was reordered, taken out or steered meanwhile; when nothing in the session ever reached
 * a computer, it starts afresh in the session's folder. Null: not a run that continues a session.
 */
export async function sessionTurn(tx: Prisma.TransactionClient, candidate: Pick<QueueRow, "id" | "userId" | "runnerAccountId" | "kind" | "provider" | "continueFromJobId" | "folderLabel" | "repoUrl">): Promise<SessionTurn | null> {
  if (candidate.kind !== "code" || !isCodeEngine(candidate.provider) || !candidate.continueFromJobId) return null;
  const root = await rootOfRun(tx, candidate);
  if (root === candidate.id) return null;
  await lockSession(tx, root);
  const rows = await queueRows(tx, candidate, root);
  const self = rows.find((row) => row.id === candidate.id);
  if (!self || self.status !== "queued") return { wait: true };
  if (rows.some((row) => row.id !== candidate.id && ON_COMPUTER.has(row.status))) return { wait: true };
  if (queuedOrder(rows, root)[0]?.id !== candidate.id) return { wait: true };
  const ran = rows
    .filter((row) => row.id !== candidate.id && ranAt(row))
    .sort((a, b) => ranAt(b)!.getTime() - ranAt(a)!.getTime() || byCreated(b, a))[0];
  if (ran) return { wait: false, links: { continueFromJobId: ran.id } };
  const first = rows.find((row) => row.id === root)!;
  return { wait: false, links: { continueFromJobId: root, ...(candidate.folderLabel || candidate.repoUrl ? {} : { folderLabel: first.folderLabel, repoUrl: first.repoUrl }) } };
}

/** A claimed run's links as its claim set them: the run it continues and, for a fresh start, its folder. */
export async function claimedLinks(db: Db, jobId: string): Promise<{ continueFromJobId: string | null; folderLabel: string | null; repoUrl: string | null }> {
  const row = await db.workspaceJob.findUnique({ where: { id: jobId }, select: { continueFromJobId: true, folderLabel: true, repoUrl: true } });
  return { continueFromJobId: row?.continueFromJobId ?? null, folderLabel: row?.folderLabel ?? null, repoUrl: row?.repoUrl ?? null };
}

/** The queue changed since the order was made: nothing was moved. */
export class QueueChangedError extends Error {
  readonly statusCode = 409;
  readonly expose = true;
  constructor(message = "The session's queue changed meanwhile. Read it again and reorder that.") {
    super(message);
    this.name = "QueueChangedError";
  }
}

/** Positions 1, 2, … in this order, each only while the run is still queued. */
async function writePositions(tx: Prisma.TransactionClient, ordered: readonly QueueRow[]): Promise<void> {
  for (const [index, row] of ordered.entries()) {
    if (row.queuePosition === index + 1) continue;
    const moved = await tx.workspaceJob.updateMany({ where: { id: row.id, status: "queued" }, data: { queuePosition: index + 1 } });
    if (moved.count !== 1) throw new QueueChangedError();
  }
}

/** The session's queue under its lock: its runs, and the queued ones that can move (all but its first run). */
async function heldQueue(tx: Prisma.TransactionClient, owner: Owner, rootId: string): Promise<{ rows: QueueRow[]; movable: QueueRow[] }> {
  await lockSession(tx, rootId);
  const rows = await queueRows(tx, owner, rootId);
  return { rows, movable: queuedOrder(rows, rootId).filter((row) => row.id !== rootId) };
}

const ownerOf = (scope: SessionScope): Owner => ({ userId: scope.space, runnerAccountId: scope.runner });

/**
 * Puts a new run in its session's queue: `first` (a steer, before everything queued) or `last` (a
 * queued message). Queued runs without a position get theirs in the order they would have run, so the
 * whole queue goes by position from then on. A run already claimed or ended is left alone.
 */
export async function placeInQueue(prisma: PrismaClient, scope: SessionScope, rootId: string, jobId: string, where: "first" | "last"): Promise<void> {
  if (jobId === rootId) return;
  await prisma.$transaction(async (tx) => {
    const { rows, movable } = await heldQueue(tx, ownerOf(scope), rootId);
    const target = rows.find((row) => row.id === jobId);
    if (!target || target.status !== "queued") return;
    const others = movable.filter((row) => row.id !== jobId);
    await writePositions(tx, where === "first" ? [target, ...others] : [...others, target]);
  });
}

/**
 * Puts the session's queued runs (all but its first run) in this order. Only runs not yet claimed move,
 * and only all of them at once: an order made from a queue that changed meanwhile (a run claimed, added
 * or taken out) is refused, so it never undoes what happened since.
 */
export async function reorderQueue(prisma: PrismaClient, scope: SessionScope, rootId: string, order: readonly string[]): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const { movable } = await heldQueue(tx, ownerOf(scope), rootId);
    const byId = new Map(movable.map((row) => [row.id, row]));
    if (order.length !== movable.length || new Set(order).size !== order.length || order.some((id) => !byId.has(id))) throw new QueueChangedError();
    await writePositions(tx, order.map((id) => byId.get(id)!));
  });
}

/**
 * Takes queued runs out of the session (cancelled, never started), under its lock, each only while it
 * is still queued; the rest of the queue keeps its order. Returns the runs taken out.
 */
export async function dropFromQueue(prisma: PrismaClient, scope: SessionScope, rootId: string, jobIds: readonly string[], error = "Removed from the queue."): Promise<string[]> {
  if (!jobIds.length) return [];
  return prisma.$transaction(async (tx) => {
    const { rows, movable } = await heldQueue(tx, ownerOf(scope), rootId);
    const ours = new Set(rows.map((row) => row.id));
    const dropped: string[] = [];
    for (const id of jobIds) {
      if (!ours.has(id)) continue;
      const cancelled = await tx.workspaceJob.updateMany({ where: { id, status: "queued" }, data: { status: "cancelled", finishedAt: new Date(), error, progress: "Cancelled", queuePosition: null } });
      if (cancelled.count === 1) dropped.push(id);
    }
    if (movable.some((row) => row.queuePosition !== null)) await writePositions(tx, movable.filter((row) => !dropped.includes(row.id)));
    return dropped;
  });
}
