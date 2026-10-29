/**
 * The session card's controls (docs/35 §8.9): its owner, signed in in the browser, reads a session one of
 * their nodes manages, sends it a message (queue, steer, replace), stops it, reorders or empties its
 * queue, and hands it to another of their nodes. Each action goes through exactly the functions the node's own tools use (node/sessions.ts), as
 * the node's run would, and is recorded for the node's work board, so the node always knows.
 */
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { ToolBlockedError } from "../assistant/types.js";
import { requireBrowserSession } from "../bridge/auth.js";
import { accountIdOf } from "../lib/auth.js";
import { truncateText } from "../lib/text.js";
import { isVisitor } from "../sharing/context.js";
import { listSessions, liveOrder, resolveSession, type SessionRun } from "../workspace/sessions.js";
import { stepLive } from "./plans.js";
import { sessionOwners, sessionSnapshot } from "./session-queue.js";
import { editSessionQueue, moveSession, ownerContext, sendToSession, stopSession, type SessionEnv } from "./sessions.js";

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** The account acting: its own browser session only (no link visitor, no key), as for the rest of Node. */
function owner(request: FastifyRequest): string {
  requireBrowserSession(request);
  const accountId = accountIdOf(request);
  if (request.authVia === "link" || isVisitor(accountId)) throw fail(403, "Sign in to use Ensemble Node.");
  if (request.tokenScope && request.tokenScope !== "full") throw fail(403, "This key cannot use Ensemble Node.");
  return accountId;
}

const Params = z.object({ id: z.string().uuid() });
const QueueParams = z.object({ id: z.string().uuid(), jobId: z.string().uuid() });
const Control = z
  .object({
    action: z.enum(["queue", "steer", "replace", "stop"]),
    prompt: z.string().trim().min(1).max(6000).optional(),
    title: z.string().trim().min(1).max(120).optional(),
    queued: z.enum(["keep", "drop"]).optional(),
  })
  .strict();
const Reorder = z.object({ order: z.array(z.string().uuid()).max(100) }).strict();
const HandOver = z.object({ nodeId: z.string().uuid() }).strict();
const ListQuery = z.object({ q: z.string().trim().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();

/**
 * The session's node acting for its owner's card: the node that manages it, in the conversation of its
 * newest run (its card's thread, private or not, and its plan step while that step goes on).
 */
async function cardEnv(app: FastifyInstance, accountId: string, id: string): Promise<SessionEnv & { sessionId: string }> {
  const prisma = app.prisma;
  const session = await resolveSession(prisma, { space: accountId, runner: null }, id);
  if (!session) throw fail(404, "That session is not available.");
  const nodeId = (await sessionOwners(prisma, accountId, [session.id])).get(session.id);
  const node = nodeId ? await prisma.nodeAgent.findFirst({ where: { id: nodeId, userId: accountId } }) : null;
  if (!node) throw fail(409, "None of your nodes manages this session yet. Ask a node to continue it first.");
  const latest = await prisma.nodeRun.findFirst({ where: { userId: accountId, nodeId: node.id, OR: [{ sessionId: session.id }, { sessionId: null, jobId: session.id }] }, orderBy: { createdAt: "desc" } });
  // A node the session was handed to may not have run in it yet: it acts from its own chat.
  const room = latest
    ? await prisma.nodeRoom.findUnique({ where: { id: latest.roomId } })
    : await prisma.nodeRoom.findFirst({ where: { kind: "dm", userId: accountId, archivedAt: null, members: { some: { nodeId: node.id } } } });
  if (!room || room.archivedAt) throw fail(409, "The conversation this session's runs were in is gone.");
  const card = latest?.messageId ? await prisma.nodeMessage.findUnique({ where: { id: latest.messageId } }) : null;
  const step = latest?.planId && latest.planStep && (await stepLive(prisma, latest.planId, latest.planStep)) ? { planId: latest.planId, planStep: latest.planStep } : null;
  return {
    ctx: await ownerContext(app, accountId),
    prisma,
    app,
    node,
    room,
    lineage: { rootMessageId: card?.rootMessageId ?? null, botDepth: card?.botDepth ?? 0, fromNonOwner: false },
    privateTo: (card?.data as { private?: unknown } | null)?.private === true ? [accountId] : null,
    plan: step,
    via: "card",
    sessionId: session.id,
  };
}

/** The node tools' refusals are the card's answers: what was refused and what to do instead. */
async function acting<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ToolBlockedError) throw Object.assign(new Error([error.message, error.remedy].filter(Boolean).join(" ")), { statusCode: 409 });
    throw error;
  }
}

/** The session's recent runs, newest first, as the card lists them. */
async function recentRuns(prisma: PrismaClient, runs: SessionRun[], rootId: string, take = 20) {
  const order = new Map(liveOrder(runs, rootId).map((row, index) => [row.id, index]));
  const recent = [...runs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, take);
  const nodeRuns = await prisma.nodeRun.findMany({ where: { jobId: { in: recent.map((row) => row.id) } }, select: { jobId: true, prompt: true, settings: true, messageId: true } });
  const byJob = new Map(nodeRuns.map((row) => [row.jobId, row]));
  return recent.map((row) => ({
    jobId: row.id,
    title: row.title,
    prompt: byJob.get(row.id)?.prompt ?? null,
    status: row.status,
    position: order.has(row.id) ? order.get(row.id)! + 1 : null,
    summary: row.summary ? truncateText(row.summary, 600) : null,
    error: row.error ? truncateText(row.error, 300) : null,
    settings: byJob.get(row.id)?.settings ?? null,
    messageId: byJob.get(row.id)?.messageId ?? null,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }));
}

export function registerSessionRoutes(app: FastifyInstance): void {
  const prisma = app.prisma;

  /**
   * My agent sessions, most recently active first, each with the node that manages it (null: none, such
   * as one started in the Hub or the CLI), so I can give one to a node.
   */
  app.get("/api/node/sessions", async (request) => {
    const accountId = owner(request);
    const query = ListQuery.parse(request.query ?? {});
    const sessions = await listSessions(prisma, { space: accountId, runner: null }, { query: query.q, limit: query.limit });
    const owners = await sessionOwners(prisma, accountId, sessions.map((row) => row.id));
    return {
      sessions: sessions.map((row) => ({
        id: row.id,
        nodeId: owners.get(row.id) ?? null,
        status: row.status,
        agent: row.agent,
        agentName: row.agentName,
        model: row.model && row.model !== "default" ? row.model : null,
        computer: row.computer,
        folder: row.folder,
        title: row.title,
        latestTask: row.latestTask.title,
        summary: truncateText(row.summary, 300),
        runs: row.runs,
        lastActiveAt: row.lastActiveAt,
      })),
    };
  });

  /** One of my sessions: its state, the run going on, the queue in order and its recent runs. */
  app.get("/api/node/sessions/:id", async (request) => {
    const accountId = owner(request);
    const { id } = Params.parse(request.params);
    const view = await sessionSnapshot(prisma, accountId, id);
    if (!view) throw fail(404, "That session is not available.");
    return { session: { ...view.snapshot, runs: await recentRuns(prisma, view.runs, view.session.id) } };
  });

  /** Queue, steer, replace or stop, as the node's node_session_send and node_session_stop do. */
  app.post("/api/node/sessions/:id/control", async (request) => {
    const accountId = owner(request);
    const { id } = Params.parse(request.params);
    const body = Control.parse(request.body);
    const env = await cardEnv(app, accountId, id);
    if (body.action === "stop") {
      await acting(() => stopSession(env, { session: env.sessionId, queued: body.queued ?? "drop" }));
      return { ok: true };
    }
    if (!body.prompt) throw fail(400, "Say what the agent should do.");
    const done = await acting(() => sendToSession(env, { session: env.sessionId, prompt: body.prompt!, delivery: body.action as "queue" | "steer" | "replace", ...(body.title ? { title: body.title } : {}) }));
    return { ok: true, jobId: (done.data as { jobId?: string }).jobId };
  });

  /** The queued messages in a new order: every one of them, as the session listed them. */
  app.post("/api/node/sessions/:id/queue", async (request) => {
    const accountId = owner(request);
    const { id } = Params.parse(request.params);
    const body = Reorder.parse(request.body);
    const env = await cardEnv(app, accountId, id);
    await acting(() => editSessionQueue(env, { session: env.sessionId, order: body.order }));
    return { ok: true };
  });

  /**
   * Hands the session to another of my nodes (or gives a session no node manages to one): from now on
   * that node sees it, sends it messages and answers for it. Runs already started report to their node.
   */
  app.post("/api/node/sessions/:id/hand-over", async (request) => {
    const accountId = owner(request);
    const { id } = Params.parse(request.params);
    const body = HandOver.parse(request.body);
    const session = await resolveSession(prisma, { space: accountId, runner: null }, id);
    if (!session) throw fail(404, "That session is not available.");
    const to = await prisma.nodeAgent.findFirst({ where: { id: body.nodeId, userId: accountId, parentNodeId: null } });
    if (!to) throw fail(404, "That node is not one of yours.");
    const fromId = (await sessionOwners(prisma, accountId, [session.id])).get(session.id) ?? null;
    if (fromId !== to.id) {
      const from = fromId ? await prisma.nodeAgent.findUnique({ where: { id: fromId }, select: { id: true, slug: true } }) : null;
      await moveSession(prisma, { accountId, sessionId: session.id, to, from, actor: "owner", via: "card" });
    }
    return { ok: true, nodeId: to.id };
  });

  /** Takes one queued message out of the session; it never starts. */
  app.delete("/api/node/sessions/:id/queue/:jobId", async (request, reply) => {
    const accountId = owner(request);
    const { id, jobId } = QueueParams.parse(request.params);
    const env = await cardEnv(app, accountId, id);
    const view = await sessionSnapshot(prisma, accountId, env.sessionId);
    if (!view?.runs.some((row) => row.id === jobId)) throw fail(404, "That message is not in this session.");
    await acting(() => editSessionQueue(env, { session: env.sessionId, cancel: [jobId] }));
    return reply.code(204).send();
  });
}
