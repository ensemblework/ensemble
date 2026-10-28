/**
 * Ensemble Node as the controller of its owner's coding-agent sessions (docs/35 §8). The work itself
 * happens in the owner's own agent (Claude Code, Codex, Cursor, GitHub Copilot, Grok Build, OpenCode,
 * Gemini CLI, Antigravity) on their paired computer and their own subscription; a node starts a
 * session there, sends it the next message (after what is queued, as a change to the run going on,
 * or in place of it), stops it, and summarises what each session did. Every run is an Ensemble job,
 * so the computer's rules, Needs me and the run's record apply as for any task.
 *
 * Isolation: a session belongs to the node whose run it started with (its first node run). Other
 * nodes never see or touch it. A session started outside Node (the Hub, the CLI) belongs to no node
 * until one continues it.
 *
 * A run a node starts on its own keeps its record on an internal task that stays off the board
 * (lib/node-tasks.ts); a run on a board task the owner named stays on that task.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { NodeAgent, NodeMessage, NodeRoom, PrismaClient } from "@prisma/client";
import { CODE_ENGINES, ENGINE_LABELS, isCodeEngine, type CodeEngine } from "@ensemble/shared-types";
import { AssignInput, chooseComputer, chooseProfile, plan, type Plan } from "../assistant/tools/agent-assign.js";
import { defineTool, toolOk, ToolBlockedError, type AnyHubTool, type ToolContext, type ToolResult } from "../assistant/types.js";
import { isPaused } from "../lib/activity.js";
import { nodeTaskRef } from "../lib/node-tasks.js";
import { loadSettings } from "../lib/settings.js";
import { truncateText } from "../lib/text.js";
import { computerAgents } from "../subscriptions/turn.js";
import { createJob, inSession, type AssignInput as JobRequest } from "../workspace/assign.js";
import { LIVE_RUN, listSessions, resolveSession, runsOfSession, summaryLine, type AgentSession, type SessionRun } from "../workspace/sessions.js";
import { steerOf } from "../workspace/trust.js";
import { stopJob } from "../workspace/worker.js";
import { postMessage, roomPeople, updateMessageData } from "./store.js";

export type SessionLineage = { rootMessageId: string | null; botDepth: number; fromNonOwner: boolean };

/** Where a session call runs from: a node turn, or an approval its owner gave. */
export type SessionEnv = {
  ctx: ToolContext;
  prisma: PrismaClient;
  app: FastifyInstance;
  node: NodeAgent;
  room: NodeRoom;
  lineage: SessionLineage;
  privateTo: string[] | null;
};

const Agent = z.enum(["ensemble", ...CODE_ENGINES]);
export const DELIVERIES = ["queue", "steer", "replace"] as const;
export type Delivery = (typeof DELIVERIES)[number];

const options = AssignInput.omit({ taskId: true, instructions: true, session: true });

export const StartInput = options
  .extend({
    title: z.string().min(1).max(120).describe("A short name for this piece of work, shown on the run card (“Fix the login redirect”)."),
    prompt: z
      .string()
      .min(1)
      .max(6000)
      .describe("The message for the agent, sent as written: what to do and where, how to check it, what done looks like. Write it as the owner would to their agent."),
    taskId: z
      .string()
      .uuid()
      .optional()
      .describe("Only when your owner wants this work on their Ensemble board: the board task it belongs to (make one with hub_create_tasks). Leave out to keep the run off the board."),
    agent: Agent.optional().describe("Only when your owner names the agent: claude-code, codex, cursor-agent, copilot-cli (GitHub Copilot), grok-cli, opencode, gemini-cli, antigravity. Leave out for their run profile's agent, else one signed in on the computer."),
  })
  .strict();
export type StartInput = z.infer<typeof StartInput>;

export const SendInput = z
  .object({
    session: z.string().uuid().describe("The session's id, from node_sessions."),
    prompt: z.string().min(1).max(6000).describe("The message for the agent, sent as written. For steer: only the change."),
    title: z.string().min(1).max(120).optional().describe("A short name for this piece of work, for the run card. Leave out for steer."),
    delivery: z
      .enum(DELIVERIES)
      .default("queue")
      .describe(
        "queue: after what the session is doing and what is queued in it (now, when it is idle). " +
          "steer: change the run going on now: it is interrupted and goes on at once in the same conversation with this update, keeping what it did; what is queued stays after it. " +
          "replace: stop the run going on and drop what is queued, then do this instead.",
      ),
    taskId: z.string().uuid().optional().describe("Only when your owner wants this work on their Ensemble board: the board task it belongs to."),
    model: z.string().max(120).optional().describe("Only when your owner names a model for the agent."),
    effort: z.string().max(20).optional().describe("Only when your owner names a thinking level."),
    mode: z.enum(["ask", "review", "unattended"]).optional().describe("Only when your owner says: ask, review or unattended."),
  })
  .strict();
export type SendInput = z.infer<typeof SendInput>;

export const StopInput = z
  .object({
    session: z.string().uuid().describe("The session's id, from node_sessions."),
    queued: z.enum(["drop", "keep"]).default("drop").describe("drop: also drop the messages queued in it. keep: they run after the stop."),
  })
  .strict();

export type SessionCall = { action: "start"; input: StartInput } | { action: "send"; input: SendInput };

/** Whether the owner asked this node to check with them before it starts work on their computer. */
export function computerWorkAsks(node: Pick<NodeAgent, "autonomy">): boolean {
  const autonomy = (node.autonomy && typeof node.autonomy === "object" ? node.autonomy : {}) as Record<string, unknown>;
  return autonomy.computerWork === "ask";
}

const scopeOf = (node: Pick<NodeAgent, "userId">) => ({ space: node.userId, runner: null });

/** The node that owns each session: the node of the session's first node run. Unowned sessions are missing. */
export async function sessionOwners(prisma: PrismaClient, accountId: string, sessionIds: string[]): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  if (!sessionIds.length) return owners;
  const rows = await prisma.nodeRun.findMany({
    where: { userId: accountId, OR: [{ sessionId: { in: sessionIds } }, { sessionId: null, jobId: { in: sessionIds } }] },
    orderBy: { createdAt: "asc" },
    select: { sessionId: true, jobId: true, nodeId: true },
  });
  for (const row of rows) {
    const id = row.sessionId ?? row.jobId;
    if (!owners.has(id)) owners.set(id, row.nodeId);
  }
  return owners;
}

export type NodeSession = AgentSession & { yours: boolean };

/** The sessions this node may use, most recently active first: its own, then those no node owns. Other nodes' never show. */
export async function sessionsForNode(prisma: PrismaClient, node: Pick<NodeAgent, "id" | "userId">, filter: { query?: string; limit?: number } = {}): Promise<NodeSession[]> {
  const all = await listSessions(prisma, scopeOf(node), { query: filter.query, limit: 100 });
  const owners = await sessionOwners(prisma, node.userId, all.map((row) => row.id));
  return all
    .filter((row) => {
      const owner = owners.get(row.id);
      return !owner || owner === node.id;
    })
    .map((row) => ({ ...row, yours: owners.get(row.id) === node.id }))
    .slice(0, Math.max(1, Math.min(filter.limit ?? 12, 50)));
}

/** A session this node may use, or why not. */
async function usableSession(prisma: PrismaClient, node: NodeAgent, id: string): Promise<AgentSession> {
  const session = await resolveSession(prisma, scopeOf(node), id);
  if (!session) throw new ToolBlockedError("There is no agent session with that id.", "List your sessions with node_sessions.");
  const owner = (await sessionOwners(prisma, node.userId, [session.id])).get(session.id);
  if (owner && owner !== node.id) {
    throw new ToolBlockedError("That session belongs to another of your owner's nodes; you cannot use it.", "Start a new session, or hand the work to that node (node_delegate).");
  }
  return session;
}

type WorkItem = { title: string; asked: string | null; result: string; status: string; at: string };

/** What a session did, one line per task in it (a steered run counts with the task it changed), newest last. */
async function workOf(prisma: PrismaClient, runs: SessionRun[], max: number): Promise<WorkItem[]> {
  const asked = await prisma.nodeRun.findMany({ where: { jobId: { in: runs.map((row) => row.id) } }, select: { jobId: true, prompt: true } });
  const prompts = new Map(asked.map((row) => [row.jobId, row.prompt]));
  const byTask = new Map<string, SessionRun[]>();
  for (const run of runs) byTask.set(run.taskId, [...(byTask.get(run.taskId) ?? []), run]);
  return [...byTask.values()].slice(-max).map((group) => {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const said = group.map((row) => prompts.get(row.id)).filter((text): text is string => Boolean(text?.trim()));
    return {
      title: first.title,
      asked: said.length ? truncateText(said.join(" · then: "), 400) : null,
      result: summaryLine(last.summary || last.error || last.progress) || (LIVE_RUN.has(last.status) ? "Not done yet." : "No summary."),
      status: last.status,
      at: (last.finishedAt ?? last.createdAt).toISOString(),
    };
  });
}

function sessionView(row: NodeSession, work: WorkItem[]) {
  return {
    id: row.id,
    yours: row.yours,
    agent: row.agentName,
    model: row.model === "default" ? null : row.model,
    computer: row.computer ?? "a paired computer",
    folder: row.folder,
    status: row.status,
    lastActive: row.lastActiveAt,
    tasks: row.tasks,
    runs: row.runs,
    work,
  };
}

const agentLabel = (engine: string | null | undefined) => (engine && isCodeEngine(engine) ? ENGINE_LABELS[engine] : "Ensemble's agent");

/** A coding agent signed in on the computer, for a run whose profile names none. */
async function agentOn(prisma: PrismaClient, deviceId: string | undefined, engines: string[]): Promise<CodeEngine> {
  const device = deviceId ? await prisma.device.findUnique({ where: { id: deviceId } }) : null;
  const signedIn = device ? computerAgents(device).agents.filter((agent) => agent.signedIn !== false).map((agent) => agent.id as string) : [];
  const runnable: string[] = engines.filter(isCodeEngine);
  return (signedIn.find((id) => runnable.includes(id)) ?? runnable[0] ?? "claude-code") as CodeEngine;
}

/** The task a run keeps its record on: the board task named, else a new internal one off the board. */
async function taskFor(env: SessionEnv, input: { taskId?: string; title: string; prompt: string }): Promise<{ id: string; direct: boolean; made: boolean }> {
  if (input.taskId) {
    const task = await env.prisma.task.findFirst({ where: { id: input.taskId, userId: env.node.userId, deletedAt: null }, select: { id: true } });
    if (!task) throw new ToolBlockedError("That task is not on your owner's board.", "Use the id hub_create_tasks or hub_list_tasks gave, or leave taskId out to keep the run off the board.");
    return { id: task.id, direct: false, made: false };
  }
  const task = await env.prisma.task.create({
    data: {
      userId: env.node.userId,
      title: truncateText(input.title.trim(), 300),
      description: input.prompt,
      owner: "agent",
      status: "todo",
      sourceKind: "other",
      sourceRef: nodeTaskRef(env.node.id),
      createdBy: "agent",
    },
  });
  return { id: task.id, direct: true, made: true };
}

async function refuseWhenPaused(env: SessionEnv): Promise<void> {
  if (env.app.redis && (await isPaused(env.app.redis as never, env.node.userId))) {
    throw new ToolBlockedError("Your owner stopped all agent work in Ensemble (Stop everything), so nothing new can start.", "They resume it in Ensemble first.");
  }
}

async function queueJob(env: SessionEnv, body: JobRequest, context: Record<string, unknown>, cleanup?: () => Promise<unknown>): Promise<string> {
  try {
    const created = await createJob(env.prisma, env.node.userId, body, { actor: "agent", context: { node: { nodeId: env.node.id }, ...context } as never });
    if (!created) throw new ToolBlockedError("That task is not available any more.");
    return created.jobId;
  } catch (error) {
    await cleanup?.().catch(() => undefined);
    if (error instanceof ToolBlockedError) throw error;
    // Trust, engine, folder and computer refusals are the owner's to resolve; say exactly what.
    throw new ToolBlockedError(error instanceof Error ? error.message : String(error));
  }
}

type Follow = { jobId: string; taskId: string; title: string; prompt: string; sessionId: string | null; direct: boolean; delivery: "new" | Delivery };

/** A run card in the room and the node run that follows the job (node/runs.ts reports when it ends). */
async function followRun(env: SessionEnv, info: Follow): Promise<NodeMessage> {
  const { prisma, node, room } = env;
  const job = await prisma.workspaceJob.findUniqueOrThrow({
    where: { id: info.jobId },
    select: { status: true, progress: true, provider: true, folderLabel: true, repoUrl: true, device: { select: { name: true } } },
  });
  const people = await roomPeople(prisma, room.id);
  // The computer and its work are the owner's: other people in a room do not see the card.
  const visibleTo = env.privateTo || people.some((id) => id !== node.userId) ? [node.userId] : [];
  const { message } = await postMessage(prisma, {
    roomId: room.id,
    userId: node.userId,
    authorKind: "node",
    authorNodeId: node.id,
    kind: "run",
    body: info.title,
    data: {
      jobId: info.jobId,
      ...(info.direct ? { direct: true } : { taskId: info.taskId }),
      sessionId: info.sessionId,
      delivery: info.delivery,
      agent: agentLabel(job.provider),
      status: job.status,
      computer: job.device?.name ?? null,
      progress: job.progress,
      summary: null,
      error: null,
      private: Boolean(env.privateTo),
    },
    visibleTo,
    rootMessageId: env.lineage.rootMessageId,
    botDepth: env.lineage.botDepth,
  });
  await prisma.nodeRun.create({
    data: {
      userId: node.userId,
      nodeId: node.id,
      roomId: room.id,
      messageId: message.id,
      jobId: info.jobId,
      taskId: info.taskId,
      status: job.status,
      sessionId: info.sessionId,
      prompt: truncateText(info.prompt, 4000),
      direct: info.direct,
    },
  });
  return message;
}

/**
 * Runs this node started that a newer call took over (steered, replaced, stopped, paused): their
 * cards say so, and node/runs.ts does not wake the node when they end.
 */
async function quiet(prisma: PrismaClient, jobIds: string[], why: "steered" | "replaced" | "stopped" | "paused"): Promise<void> {
  if (!jobIds.length) return;
  const runs = await prisma.nodeRun.findMany({ where: { jobId: { in: jobIds }, reportedAt: null } });
  for (const run of runs) {
    const card = run.messageId ? await prisma.nodeMessage.findUnique({ where: { id: run.messageId } }) : null;
    if (card) await updateMessageData(prisma, card, { quiet: why });
  }
}

export type Started = { summary: string; data: Record<string, unknown> };

function placeLine(found: Plan): string {
  const where = found.where.computer ? ` on ${found.where.computer.name}${found.where.computer.online ? "" : " (offline now: it starts when that computer is back)"}` : "";
  const folder = found.session ? ` in ${found.session.folder}` : found.body.repoUrl ? ` in a fresh clone of ${found.body.repoUrl}` : found.body.folderLabel ? ` in “${found.body.folderLabel}”` : " in a new folder";
  return `${where}${folder}`;
}

/** A new session with one of the owner's coding agents. */
export async function startSession(env: SessionEnv, input: StartInput): Promise<Started> {
  await refuseWhenPaused(env);
  const profile = chooseProfile(env.ctx, input.profile);
  let agent: z.infer<typeof Agent> | undefined = input.agent ?? (isCodeEngine(profile.engine) ? profile.engine : undefined);
  const where = await chooseComputer(env.ctx, profile, agent ?? "claude-code", input.computer);
  if (!agent) agent = await agentOn(env.prisma, where.deviceId, where.computer?.engines ?? []);
  const task = await taskFor(env, input);
  const cleanup = task.made ? () => env.prisma.task.delete({ where: { id: task.id } }) : undefined;
  let found: Plan;
  try {
    const { prompt: _prompt, title: _title, taskId: _taskId, ...rest } = input;
    found = await plan(env.ctx, { ...rest, taskId: task.id, agent, profile: profile.id, ...(where.deviceId ? { computer: where.deviceId } : {}), ...(task.direct ? {} : { instructions: input.prompt }) });
  } catch (error) {
    await cleanup?.().catch(() => undefined);
    throw error;
  }
  const jobId = await queueJob(env, found.body, {}, cleanup);
  const sessionId = isCodeEngine(found.engine) ? jobId : null;
  await followRun(env, { jobId, taskId: task.id, title: input.title, prompt: input.prompt, sessionId, direct: task.direct, delivery: "new" });
  return {
    summary: `Started ${agentLabel(found.engine)}${placeLine(found)}: “${input.title}”. You hear when it ends.`,
    data: { session: sessionId, jobId, agent: agentLabel(found.engine), computer: found.where.computer?.name ?? null, onBoard: !task.direct },
  };
}

const byCreated = (a: SessionRun, b: SessionRun) => a.createdAt.getTime() - b.createdAt.getTime();
const ranOnComputer = (run: SessionRun) => Boolean(run.startedAt || run.claimedAt);

/**
 * The session's runs still to finish, in the order they will run: along `continueFromJobId`, since a
 * steer moves what was queued behind it and creation order then no longer says what runs next.
 */
export function liveChain(runs: readonly SessionRun[]): SessionRun[] {
  const live = runs.filter((row) => LIVE_RUN.has(row.status));
  const ids = new Set(live.map((row) => row.id));
  const after = new Map<string, SessionRun[]>();
  for (const row of live) if (row.continueFromJobId && ids.has(row.continueFromJobId)) after.set(row.continueFromJobId, [...(after.get(row.continueFromJobId) ?? []), row]);
  const out: SessionRun[] = [];
  const seen = new Set<string>();
  const walk = (row: SessionRun) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    out.push(row);
    for (const next of [...(after.get(row.id) ?? [])].sort(byCreated)) walk(next);
  };
  for (const head of live.filter((row) => !row.continueFromJobId || !ids.has(row.continueFromJobId)).sort(byCreated)) walk(head);
  return out;
}

/**
 * Adds a change to a run that has not been claimed yet: a steer's change, or the brief of any other
 * run (both are read when the computer claims it). False when it was claimed meanwhile.
 */
async function amendQueued(prisma: PrismaClient, jobId: string, text: string): Promise<boolean> {
  const job = await prisma.workspaceJob.findUnique({ where: { id: jobId }, select: { instructions: true, context: true, status: true } });
  if (!job || job.status !== "queued") return false;
  const context = (job.context && typeof job.context === "object" ? job.context : {}) as Record<string, unknown>;
  const steer = steerOf(context);
  const data = steer
    ? { context: { ...context, steer: { update: truncateText(`${steer.update}\n\nAlso: ${text}`, 8000) } } as never }
    : { instructions: truncateText([job.instructions, `Update from your owner: ${text}`].filter((part) => part.trim()).join("\n\n"), 8000) };
  const changed = await prisma.workspaceJob.updateMany({ where: { id: jobId, status: "queued" }, data });
  if (changed.count !== 1) return false;
  const run = await prisma.nodeRun.findFirst({ where: { jobId }, select: { id: true, prompt: true } });
  if (run) await prisma.nodeRun.update({ where: { id: run.id }, data: { prompt: truncateText(`${run.prompt ?? ""}\n\nUpdate: ${text}`.trim(), 4000) } });
  return true;
}

/** The next message for one of this node's sessions: queued, steering the run going on, or replacing it. */
export async function sendToSession(env: SessionEnv, input: SendInput): Promise<Started> {
  const { prisma, node } = env;
  await refuseWhenPaused(env);
  const session = await usableSession(prisma, node, input.session);
  const runs = await runsOfSession(prisma, scopeOf(node), session.id);
  const chain = liveChain(runs);
  const active = chain[0];
  let delivery: Delivery = input.delivery;
  if (delivery === "steer" && !active) delivery = "queue";
  const where = `${session.agentName}${session.computer ? ` on ${session.computer}` : ""}, ${session.folder}`;

  if (delivery === "steer") {
    // Not started yet: the change goes into its brief.
    if (active!.status === "queued" && (await amendQueued(prisma, active!.id, input.prompt))) {
      return { summary: `“${active!.title}” had not started yet, so the change is in its brief (${where}).`, data: { session: session.id, jobId: active!.id } };
    }
    // A change already waiting to go on after the interrupted run: this one joins it, in order.
    const pending = chain[1];
    if (pending && pending.continueFromJobId === active!.id && steerOf((await prisma.workspaceJob.findUnique({ where: { id: pending.id }, select: { context: true } }))?.context) && (await amendQueued(prisma, pending.id, input.prompt))) {
      return { summary: `Added to the change already going in to “${active!.title}” (${where}).`, data: { session: session.id, jobId: pending.id } };
    }
  }

  const steering = delivery === "steer";
  const fallbackTitle = input.title ?? truncateText(input.prompt.split("\n")[0]!.trim(), 80);
  // A steer is the same task going on; anything else is a new task in the session.
  const task = steering
    ? { id: active!.taskId, direct: (await prisma.nodeRun.findFirst({ where: { jobId: active!.id }, select: { direct: true } }))?.direct ?? false, made: false }
    : await taskFor(env, { taskId: input.taskId, title: fallbackTitle, prompt: input.prompt });
  const cleanup = task.made ? () => prisma.task.delete({ where: { id: task.id } }) : undefined;

  let body: JobRequest;
  try {
    const found = await plan(env.ctx, {
      taskId: task.id,
      session: session.id,
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(steering || !task.direct ? { instructions: input.prompt } : {}),
    });
    body = await inSession(prisma, node.userId, found.body).catch((error: unknown) => {
      throw new ToolBlockedError(error instanceof Error ? error.message : String(error));
    });
  } catch (error) {
    await cleanup?.().catch(() => undefined);
    throw error;
  }
  delete (body as { session?: string }).session;

  // What the new run continues: a steer, the run it interrupts; a queued message, the end of the chain;
  // a replacement, the last run that reached the computer (a run never claimed has no folder there).
  const fresh = delivery === "replace" && !chain.some(ranOnComputer) && !runs.some((row) => !LIVE_RUN.has(row.status) && ranOnComputer(row));
  if (steering) body.continueFromJobId = active!.id;
  else if (delivery === "queue" && chain.length) body.continueFromJobId = chain[chain.length - 1]!.id;
  else if (delivery === "replace") {
    const anchor = chain.find(ranOnComputer) ?? [...runs].reverse().find((row) => !LIVE_RUN.has(row.status) && ranOnComputer(row));
    if (anchor) body.continueFromJobId = anchor.id;
    else if (fresh) {
      // Nothing of the session reached the computer: start over where it was to work.
      const first = await prisma.workspaceJob.findUniqueOrThrow({ where: { id: session.id }, select: { folderLabel: true, repoUrl: true } });
      delete body.continueFromJobId;
      if (first.folderLabel) body.folderLabel = first.folderLabel;
      if (first.repoUrl) body.repoUrl = first.repoUrl;
    }
  }
  const jobId = await queueJob(env, body, steering ? { steer: { update: input.prompt } } : {}, cleanup);

  // Only once the new run exists does anything stop.
  if (steering) {
    await prisma.workspaceJob.updateMany({ where: { continueFromJobId: active!.id, status: "queued", id: { not: jobId } }, data: { continueFromJobId: jobId } });
    const now = await prisma.workspaceJob.findUnique({ where: { id: active!.id }, select: { status: true, cancelRequestedAt: true } });
    if (now && now.status !== "stopping" && !now.cancelRequestedAt) await stopJob(env.app, node.userId, active!.id);
    await quiet(prisma, [active!.id], "steered");
  } else if (delivery === "replace" && chain.length) {
    // Newest first, so nothing queued starts on the way.
    for (const row of [...chain].reverse()) await stopJob(env.app, node.userId, row.id);
    await quiet(prisma, chain.map((row) => row.id), "replaced");
  }

  const title = steering ? `Update: ${active!.title}` : fallbackTitle;
  await followRun(env, { jobId, taskId: task.id, title: truncateText(title, 200), prompt: input.prompt, sessionId: fresh ? jobId : session.id, direct: task.direct, delivery });
  const waiting = delivery === "queue" && chain.length ? ` It starts after ${chain.length === 1 ? `“${chain[0]!.title}”` : `the ${chain.length} runs ahead of it`}.` : "";
  const verb = steering
    ? `Steered “${active!.title}”: it goes on with your change`
    : delivery === "replace"
      ? `Stopped what the session was doing${chain.length ? ` (${chain.length} run${chain.length === 1 ? "" : "s"})` : ""} and started this instead`
      : chain.length
        ? "Queued in the session"
        : "Sent to the session";
  return {
    summary: `${verb} (${where}).${waiting} You hear when it ends.`,
    data: { session: fresh ? jobId : session.id, jobId, delivery, queuedBehind: delivery === "queue" ? chain.length : 0 },
  };
}

/** Stops a session's run going on, and unless asked to keep them, what is queued in it. */
export async function stopSession(env: SessionEnv, input: z.infer<typeof StopInput>): Promise<Started> {
  const { prisma, node } = env;
  const session = await usableSession(prisma, node, input.session);
  const chain = liveChain(await runsOfSession(prisma, scopeOf(node), session.id));
  const targets = input.queued === "keep" ? chain.filter((row) => row.status !== "queued") : chain;
  if (!targets.length) return { summary: "Nothing is running in that session.", data: { session: session.id, stopped: 0 } };
  for (const row of [...targets].reverse()) await stopJob(env.app, node.userId, row.id);
  await quiet(prisma, targets.map((row) => row.id), "stopped");
  const kept = chain.length - targets.length;
  return {
    summary: `Stopped ${targets.map((row) => `“${row.title}”`).join(", ")}. What it changed so far stays.${kept ? ` ${kept} queued message${kept === 1 ? "" : "s"} will run next.` : ""}`,
    data: { session: session.id, stopped: targets.length },
  };
}

function describeCall(call: SessionCall, node: NodeAgent): string {
  const input = call.input;
  const agent = call.action === "start" && call.input.agent ? agentLabel(call.input.agent) : "your coding agent";
  const head =
    call.action === "start"
      ? `@${node.slug} wants to start ${agent}${call.input.computer && call.input.computer !== "any" ? ` on ${call.input.computer}` : " on your computer"}${call.input.folder ? ` in “${call.input.folder}”` : call.input.repoUrl ? ` in a clone of ${call.input.repoUrl}` : ""}: ${call.input.title}`
      : `@${node.slug} wants to ${call.input.delivery === "steer" ? "steer the run going on in" : call.input.delivery === "replace" ? "replace what is running in" : "send a message to"} one of its sessions${call.input.title ? `: ${call.input.title}` : ""}`;
  return `${head}\n\n${truncateText(input.prompt, 1200)}`;
}

/** One owner-only card with exactly this call; approvals.ts runs it when the owner approves. */
async function holdForOwner(env: SessionEnv, call: SessionCall): Promise<ToolResult> {
  const { message } = await postMessage(env.prisma, {
    roomId: env.room.id,
    userId: env.node.userId,
    authorKind: "node",
    authorNodeId: env.node.id,
    kind: "approval",
    body: describeCall(call, env.node),
    data: { type: "session", status: "pending", action: call.action, input: call.input, private: Boolean(env.privateTo), fromNonOwner: env.lineage.fromNonOwner },
    visibleTo: [env.node.userId],
    rootMessageId: env.lineage.rootMessageId,
    botDepth: env.lineage.botDepth,
  });
  return toolOk("Waiting for your owner's approval: they see a card with exactly this request and approve or discard it. Say so in one short line.", { approvalId: message.id });
}

export async function runSessionCall(env: SessionEnv, call: SessionCall): Promise<Started> {
  return call.action === "start" ? startSession(env, StartInput.parse(call.input)) : sendToSession(env, SendInput.parse(call.input));
}

/** A ToolContext for session calls made outside a model turn (an owner's approval). */
export async function ownerContext(app: FastifyInstance, ownerId: string): Promise<ToolContext> {
  return { app, prisma: app.prisma, userId: ownerId, actor: "agent", settings: await loadSettings(app.prisma, ownerId) };
}

export type SessionToolScope = {
  prisma: PrismaClient;
  node: NodeAgent;
  room: NodeRoom;
  lineage: SessionLineage;
  privateTo: string[] | null;
  /** Only the owner reads this turn's thread and only the owner started it (a DM, a crew, their private thread). */
  ownerOnly: boolean;
};

/**
 * The session tools for a node turn. Where only the owner reads and the owner started the turn, it
 * gets them all, acting at once unless the owner asked this node to check first. Anywhere other
 * people read (a room's shared thread, even in a turn a run's report started) it may only ask to
 * start work or send a session a message, which waits for the owner's card, and never lists the
 * owner's sessions.
 */
export function sessionTools(scope: SessionToolScope): AnyHubTool[] {
  const fromOwner = scope.ownerOnly && !scope.lineage.fromNonOwner;
  const asks = !fromOwner || computerWorkAsks(scope.node);
  const env = (ctx: ToolContext): SessionEnv => ({ ctx, prisma: scope.prisma, app: ctx.app, node: scope.node, room: scope.room, lineage: scope.lineage, privateTo: scope.privateTo });
  const result = (done: Started) => toolOk(done.summary, done.data);

  const start = defineTool({
    name: "node_session_start",
    area: "tasks",
    description:
      "Start a new session with one of your owner's own coding agents (Claude Code, Codex, Cursor, GitHub Copilot, Grok Build, OpenCode, Gemini CLI, Antigravity) on their paired computer and their own subscription: the agent does the work in a folder that computer shares (folder), a fresh clone (repoUrl) or a new empty folder, and you hear when it ends. " +
      "Their default run profile decides the agent, computer, mode and git rules unless you name others (profile, agent, computer, model, effort, mode, branch, pullRequest). " +
      "For work that builds on what one of your sessions already did, use node_session_send instead. Off the board unless you pass taskId.",
    input: StartInput,
    isWrite: false,
    risk: "medium",
    async run(ctx, input) {
      if (asks) return holdForOwner(env(ctx), { action: "start", input });
      return result(await startSession(env(ctx), input));
    },
  });
  const send = defineTool({
    name: "node_session_send",
    area: "tasks",
    description:
      "Send the next message to one of your sessions (node_sessions): the same agent goes on in its own conversation, in the same folder, remembering what it did, and the provider reuses its cache. " +
      "delivery queue: after what it is doing (“then do Y”); steer: change the run going on (“do X this way instead”); replace: drop what it is doing and queued, do this instead (“stop X, do Y”).",
    input: SendInput,
    isWrite: false,
    risk: "medium",
    async run(ctx, input) {
      if (asks) return holdForOwner(env(ctx), { action: "send", input });
      return result(await sendToSession(env(ctx), input));
    },
  });
  if (scope.lineage.fromNonOwner) return [start];
  if (!fromOwner) return [start, send];

  return [
    defineTool({
      name: "node_sessions",
      area: "tasks",
      description:
        "Your agent sessions on your owner's computers, most recently active first: for each, the agent and model, computer, folder, whether it is working, waiting for your owner, queued or idle, and one line per task done in it (what was asked, what came of it). " +
        "Read it before choosing a session, and when your owner asks what you have been working on. Sessions no node owns yet (started in Ensemble or the CLI) show with yours: false; you may continue them. Other nodes' sessions never show.",
      input: z
        .object({
          session: z.string().uuid().optional().describe("One session's id, for all of its tasks."),
          query: z.string().max(200).optional().describe("Words to match in the tasks, summary, folder, agent or computer."),
          limit: z.number().int().min(1).max(30).default(10),
        })
        .strict(),
      isWrite: false,
      risk: "low",
      async run(_ctx, input) {
        if (input.session) {
          const session = await usableSession(scope.prisma, scope.node, input.session);
          const owner = (await sessionOwners(scope.prisma, scope.node.userId, [session.id])).get(session.id);
          const runs = await runsOfSession(scope.prisma, scopeOf(scope.node), session.id);
          return toolOk(`Session with ${session.agentName} in ${session.folder}.`, { session: sessionView({ ...session, yours: owner === scope.node.id }, await workOf(scope.prisma, runs, 40)) });
        }
        const sessions = await sessionsForNode(scope.prisma, scope.node, { query: input.query, limit: input.limit });
        const views = await Promise.all(
          sessions.map(async (row) => sessionView(row, await workOf(scope.prisma, await runsOfSession(scope.prisma, scopeOf(scope.node), row.id), 6))),
        );
        return toolOk(views.length ? `${views.length} session(s).` : "No sessions yet: node_session_start begins one.", { sessions: views });
      },
    }),
    start,
    send,
    defineTool({
      name: "node_session_stop",
      area: "tasks",
      description: "Stop the run going on in one of your sessions, and the messages queued in it unless queued is keep. What the agent changed so far stays; the session can go on later with node_session_send.",
      input: StopInput,
      isWrite: false,
      risk: "low",
      async run(ctx, input) {
        return result(await stopSession(env(ctx), input));
      },
    }),
  ];
}

export type StoppedRun = { title: string; agent: string; computer: string | null; started: boolean };

/** Pausing a node: every run it started that has not ended is stopped (queued ones leave the queue). */
export async function stopNodeRuns(app: FastifyInstance, node: Pick<NodeAgent, "id" | "userId">): Promise<StoppedRun[]> {
  const prisma = app.prisma;
  const runs = await prisma.nodeRun.findMany({ where: { nodeId: node.id, reportedAt: null }, orderBy: { createdAt: "desc" } });
  const jobs = await prisma.workspaceJob.findMany({
    // A run already being stopped (by an earlier pause, steer or stop) is not still going on.
    where: { id: { in: runs.map((row) => row.jobId) }, status: { in: [...LIVE_RUN].filter((status) => status !== "stopping") as never }, cancelRequestedAt: null },
    select: { id: true, status: true, provider: true, startedAt: true, claimedAt: true, task: { select: { title: true } }, device: { select: { name: true } } },
  });
  const order = new Map(runs.map((row, index) => [row.jobId, index]));
  const live = jobs.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  for (const job of live) await stopJob(app, node.userId, job.id);
  await quiet(prisma, live.map((job) => job.id), "paused");
  return live
    .reverse()
    .map((job) => ({ title: job.task.title, agent: agentLabel(job.provider), computer: job.device?.name ?? null, started: job.status !== "queued" || Boolean(job.startedAt || job.claimedAt) }));
}

/** What a node says in its DM when it is paused: only the work that was still going on, no model call. */
export function pausedNotice(stopped: readonly StoppedRun[]): string {
  if (!stopped.length) return "Paused, as you asked. Send me a message when you need me again.";
  const line = (row: StoppedRun) => `- “${row.title}” (${row.agent}${row.computer ? ` on ${row.computer}` : ""})`;
  const running = stopped.filter((row) => row.started);
  const queued = stopped.filter((row) => !row.started);
  return [
    "Paused, as you asked.",
    running.length ? `I stopped what I was running on your computer:\n${running.map(line).join("\n")}` : "",
    queued.length ? `I took ${queued.length === 1 ? "this" : "these"} out of the queue:\n${queued.map(line).join("\n")}` : "",
    "What was changed so far stays. Send me a message to pick up again.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
