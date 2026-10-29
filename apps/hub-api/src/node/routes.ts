/**
 * Ensemble Node's HTTP surface (docs/35 §10, docs/02). Every route acts for the signed-in
 * account (sharing class `personal`), whichever space is open; messages are read through
 * visibility, and only a room's people reach it.
 */
import { MESSAGE_FILES_MAX } from "../assistant/attachments.js";
import { filesByIds } from "../files/attached.js";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { NodeAgent, NodeRoom, Prisma, PrismaClient } from "@prisma/client";
import { accountIdOf } from "../lib/auth.js";
import { isHosted, requireVerifiedUser } from "../lib/hosted-access.js";
import { stripLoneSurrogates, truncateText } from "../lib/text.js";
import { isVisitor } from "../sharing/context.js";
import { includedUsage } from "../included/budget.js";
import { INCLUDED_PROVIDER } from "@ensemble/shared-types";
import { deviceOnline } from "../devices/constants.js";
import { abortAssistantTurn } from "../assistant/agent.js";
import { ApprovalError, settleApproval } from "./approvals.js";
import { mirrorNeedsMe, nodeEventStream, publishTo } from "./events.js";
import { NODE_DEFAULT_MODEL, includedOptions, modelProblem, nodeModelOptions } from "./model.js";
import { dispatchMessage, inBackground, stopTurns } from "./queue.js";
import { pausedNotice, stopNodeRuns } from "./sessions.js";
import { registerSessionRoutes } from "./session-routes.js";
import { saveSecret, SecretError, secretStuck } from "./node-secrets.js";
import { createCrew, deleteNode, MAX_NODES, promoteHelper } from "./helpers.js";
import { stopPlans } from "./plans.js";
import { SPECIAL_MENTIONS, uniqueHandle } from "./mentions.js";
import { ON_BOARD } from "../lib/node-tasks.js";
import { nodeWebOrigin } from "../lib/node-origin.js";
import {
  addNode,
  addPerson,
  announce,
  canSee,
  createNode,
  mentionsFor,
  nodeNameTaken,
  personIn,
  postMessage,
  publicNode,
  roomPeople,
  roomSettings,
  roomTitleTaken,
  takenHandles,
  visibleWhere,
  wireMessage,
  wireNode,
} from "./store.js";
import { CREW_TEMPLATES, NODE_TEMPLATES, nodeTemplate } from "./templates.js";
import { registerOutbox } from "./outbox.js";
import { registerRoutineRoutes } from "./routine-routes.js";
import { stopCommand, stoppedLine, stopWork } from "./stop.js";

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** The account a Node request acts for. Link visitors and narrow keys never reach Node. */
export function nodeAccount(request: FastifyRequest): string {
  const accountId = accountIdOf(request);
  if (request.authVia === "link" || isVisitor(accountId)) throw fail(403, "Sign in to use Ensemble Node.");
  if (request.tokenScope && request.tokenScope !== "full") throw fail(403, "This key cannot use Ensemble Node.");
  return accountId;
}

const Avatar = z.object({
  shape: z.enum(["orb", "square", "spark", "hex", "leaf", "compass"]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  eyes: z.enum(["dot", "line", "wide"]),
});
const Slug = z.string().min(1).max(24).regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, digits and dashes.");
const ModelPick = z.string().max(120).nullable();
const ProviderPick = z.string().max(40).regex(/^[a-z0-9][a-z0-9-]*$/).nullable();

/** At most this many people in a room, counting open requests to join. */
export const MAX_ROOM_PEOPLE = 10;
/** Each person brings 1–3 of their nodes to a room; one is their lead. */
export const MAX_NODES_PER_PERSON = 3;
export const MAX_CREW_NODES = 24;
/** After someone declines, the same room cannot ask them again for this long. */
export const DECLINE_BLOCK_MS = 30 * 86_400_000;
export const MAX_PINS = 25;
export const REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "✅", "🙏", "🔥"] as const;

async function checkModel(prisma: PrismaClient, accountId: string, provider: string | null | undefined, model: string | null | undefined): Promise<void> {
  const problem = await modelProblem(prisma, accountId, provider, model);
  if (problem) throw fail(400, problem);
}

const dayText = (date: Date) => date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export const messageDeleted = (message: { data: unknown }): boolean => Boolean((message.data as { deleted?: unknown } | null)?.deleted);

/** In a room with other people, a person reads only what was said after they joined. */
function joinedFilter(kind: string, joinedAt: Date | null | undefined): Prisma.NodeMessageWhereInput {
  if (kind !== "room") return {};
  return joinedAt ? { createdAt: { gte: joinedAt } } : { id: "" };
}

async function ownNode(prisma: PrismaClient, accountId: string, id: string) {
  const node = await prisma.nodeAgent.findFirst({ where: { id, userId: accountId } });
  if (!node) throw fail(404, "That node is not available.");
  return node;
}

/** The room, if this account is one of its people. */
async function roomFor(prisma: PrismaClient, accountId: string, id: string): Promise<NodeRoom> {
  const room = await prisma.nodeRoom.findUnique({ where: { id } });
  if (!room || room.archivedAt || !(await personIn(prisma, id, accountId))) throw fail(404, "That room is not available.");
  return room;
}

async function names(prisma: PrismaClient, ids: string[]): Promise<Map<string, { name: string; email: string }>> {
  const rows = await prisma.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true, email: true } });
  return new Map(rows.map((row) => [row.id, { name: row.name?.trim() || row.email.split("@")[0]!, email: row.email }]));
}

/** A room as one person sees it: other people's emails stay out, other people's nodes show only their public face. */
async function roomView(prisma: PrismaClient, accountId: string, room: NodeRoom) {
  const members = await prisma.nodeRoomMember.findMany({ where: { roomId: room.id }, include: { node: true }, orderBy: { joinedAt: "asc" } });
  const invites = room.kind === "room" && room.userId === accountId
    ? await prisma.nodeRoomInvite.findMany({ where: { roomId: room.id, status: { not: "cancelled" } }, orderBy: { createdAt: "desc" }, take: 50 })
    : [];
  const who = await names(prisma, [...members.map((row) => row.userId), ...invites.map((row) => row.inviteeId)]);
  const settings = roomSettings(room);
  return {
    id: room.id,
    kind: room.kind,
    title: room.title,
    createdBy: room.userId,
    lastSeq: room.lastSeq,
    lastMessageAt: room.lastMessageAt?.toISOString() ?? null,
    leadNodeIds: settings.leadNodeIds,
    pinned: settings.pinned,
    // Only the person who made a room sees its requests: whether each was accepted, declined or is open.
    invites: invites.map((row) => ({
      id: row.id,
      name: who.get(row.inviteeId)?.name ?? "Someone",
      email: who.get(row.inviteeId)?.email ?? null,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      respondedAt: row.respondedAt?.toISOString() ?? null,
      askAgainAfter: row.status === "declined" && row.respondedAt ? new Date(row.respondedAt.getTime() + DECLINE_BLOCK_MS).toISOString() : null,
    })),
    members: members.map((row) =>
      row.nodeId && row.node
        ? { id: row.id, kind: "node" as const, handle: row.handle, accountId: row.userId, representative: row.representative, lead: room.kind === "room" ? row.representative : settings.leadNodeIds.includes(row.nodeId), node: row.userId === accountId ? wireNode(row.node) : publicNode(row.node) }
        : { id: row.id, kind: "person" as const, handle: row.handle, accountId: row.userId, role: row.role, name: who.get(row.userId)?.name ?? "Someone", responsibility: settings.responsibilities[row.userId] ?? null, me: row.userId === accountId },
    ),
  };
}

async function roomList(prisma: PrismaClient, accountId: string) {
  const memberships = await prisma.nodeRoomMember.findMany({ where: { userId: accountId, nodeId: null }, include: { room: true } });
  const rooms = memberships.filter((row) => !row.room.archivedAt);
  const list = await Promise.all(
    rooms.map(async (row) => {
      const [last, unread, view] = await Promise.all([
        // Cards inside a plan card are not separate messages: no preview, no unread.
        prisma.nodeMessage.findFirst({ where: { roomId: row.roomId, planId: null, ...visibleWhere(accountId), ...joinedFilter(row.room.kind, row.joinedAt) }, orderBy: { seq: "desc" } }),
        prisma.nodeMessage.count({ where: { roomId: row.roomId, planId: null, seq: { gt: row.readSeq }, ...visibleWhere(accountId), ...joinedFilter(row.room.kind, row.joinedAt), NOT: { authorKind: "human", userId: accountId } } }),
        roomView(prisma, accountId, row.room),
      ]);
      return { ...view, unread, readSeq: row.readSeq, last: last ? { ...wireMessage(last), body: truncateText(last.body, 200) } : null };
    }),
  );
  return list.sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
}

/** Requests to join rooms waiting for this person's answer. */
async function incomingInvites(prisma: PrismaClient, accountId: string) {
  const rows = await prisma.nodeRoomInvite.findMany({ where: { inviteeId: accountId, status: "pending", room: { archivedAt: null } }, include: { room: true }, orderBy: { createdAt: "desc" } });
  const who = await names(prisma, rows.map((row) => row.inviterId));
  return Promise.all(rows.map(async (row) => ({
    id: row.id,
    room: { id: row.room.id, title: row.room.title, people: await prisma.nodeRoomMember.count({ where: { roomId: row.room.id, nodeId: null } }) },
    from: { name: who.get(row.inviterId)?.name ?? "Someone", email: who.get(row.inviterId)?.email ?? null },
    createdAt: row.createdAt.toISOString(),
  })));
}

async function computers(prisma: PrismaClient, accountId: string) {
  const rows = await prisma.device.findMany({ where: { userId: accountId, revokedAt: null }, orderBy: { createdAt: "asc" } });
  return rows.map((row) => ({ id: row.id, name: row.name, platform: row.platform, online: deviceOnline(row.lastSeenAt), lastSeenAt: row.lastSeenAt?.toISOString() ?? null }));
}

async function credits(accountId: string) {
  const usage = await includedUsage(accountId).catch(() => null);
  return usage ? { available: usage.available, limit: usage.limit, used: usage.used, remaining: usage.remaining, resetsAt: usage.resetsAt, paused: usage.paused } : null;
}

async function pendingApprovals(prisma: PrismaClient, accountId: string) {
  const rows = await prisma.nodeMessage.findMany({
    where: {
      kind: "approval",
      userId: accountId,
      visibleTo: { equals: [accountId] },
      // A secret card a restart left saving can be answered again (node-secrets.ts).
      OR: [{ data: { path: ["status"], equals: "pending" } }, { AND: [{ data: { path: ["type"], equals: "secret" } }, { data: { path: ["status"], equals: "saving" } }] }],
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return rows.filter((row) => (row.data as { status?: unknown }).status === "pending" || secretStuck(row.data)).map(wireMessage);
}

/** Pending approval cards with the node that asks and the conversation they are in: Needs me on Node, the Hub and the CLI. */
export async function approvalCards(prisma: PrismaClient, accountId: string) {
  const rows = await pendingApprovals(prisma, accountId);
  const [nodes, rooms] = await Promise.all([
    prisma.nodeAgent.findMany({ where: { id: { in: rows.map((row) => row.authorNodeId).filter((id): id is string => Boolean(id)) } } }),
    prisma.nodeRoom.findMany({ where: { id: { in: rows.map((row) => row.roomId) } }, select: { id: true, title: true, kind: true } }),
  ]);
  const nodeById = new Map(nodes.map((row) => [row.id, row]));
  const roomById = new Map(rooms.map((row) => [row.id, row]));
  return rows.map((row) => {
    const node = row.authorNodeId ? nodeById.get(row.authorNodeId) : undefined;
    return { ...row, node: node ? publicNode(node) : null, room: roomById.get(row.roomId) ?? null };
  });
}

/** Board tasks blocked or waiting for an approval: the same list as the Hub's Needs me. */
async function waitingTasks(prisma: PrismaClient, accountId: string) {
  const rows = await prisma.task.findMany({
    where: { userId: accountId, deletedAt: null, status: { in: ["blocked", "waiting_approval"] }, ...ON_BOARD },
    orderBy: { updatedAt: "asc" },
    take: 50,
    select: { id: true, title: true, status: true, updatedAt: true },
  });
  return rows.map((row) => ({ id: row.id, title: row.title, status: row.status, updatedAt: row.updatedAt.toISOString() }));
}

async function runList(prisma: PrismaClient, accountId: string, take = 30) {
  const runs = await prisma.nodeRun.findMany({ where: { userId: accountId }, orderBy: { createdAt: "desc" }, take });
  const jobs = await prisma.workspaceJob.findMany({
    where: { id: { in: runs.map((row) => row.jobId) } },
    select: { id: true, status: true, progress: true, summary: true, task: { select: { title: true } }, device: { select: { name: true } } },
  });
  const byId = new Map(jobs.map((row) => [row.id, row]));
  return runs.map((run) => {
    const job = byId.get(run.jobId);
    return {
      id: run.id,
      nodeId: run.nodeId,
      roomId: run.roomId,
      messageId: run.messageId,
      jobId: run.jobId,
      taskId: run.taskId,
      title: job?.task.title ?? "Task",
      status: job?.status ?? run.status,
      progress: job?.progress ?? null,
      summary: job?.summary ?? null,
      computer: job?.device?.name ?? null,
      createdAt: run.createdAt.toISOString(),
    };
  });
}

/** The read-only overview the CLI's Node tab shows. */
export async function nodeOverview(prisma: PrismaClient, accountId: string) {
  const [nodes, rooms, approvals, runs, turns, invites] = await Promise.all([
    prisma.nodeAgent.findMany({ where: { userId: accountId, parentNodeId: null }, orderBy: { createdAt: "asc" } }),
    roomList(prisma, accountId),
    approvalCards(prisma, accountId),
    runList(prisma, accountId, 10),
    prisma.nodeTurn.findMany({ where: { userId: accountId }, orderBy: { createdAt: "desc" }, take: 10 }),
    incomingInvites(prisma, accountId),
  ]);
  return {
    nodes: nodes.map((node) => ({ id: node.id, slug: node.slug, name: node.name, role: node.role, status: node.status, busy: turns.some((turn) => turn.nodeId === node.id && (turn.status === "running" || turn.status === "queued")) })),
    rooms: rooms.map((room) => ({ id: room.id, kind: room.kind, title: room.title, unread: room.unread, lastMessageAt: room.lastMessageAt, last: room.last ? { author: room.last.authorKind, body: room.last.body } : null })),
    approvals: approvals.map((row) => ({ id: row.id, roomId: row.roomId, body: truncateText(row.body, 200), type: (row.data as { type?: unknown } | null)?.type ?? null, node: row.node ? { slug: row.node.slug, name: row.node.name } : null, room: row.room?.title ?? null })),
    invites: invites.map((row) => ({ id: row.id, room: row.room.title, from: row.from.name })),
    runs,
    credits: await credits(accountId),
  };
}

/** The sender's own files for a message: name, kind and size, in the order given. Another account's id is refused. */
async function messageFiles(prisma: PrismaClient, accountId: string, ids: string[]): Promise<Array<{ id: string; name: string; kind: string; size: number }>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const found = await filesByIds(prisma, accountId, unique);
  if (found.length !== unique.length) throw fail(404, "One of those files is not in your Files.");
  return found.map((file) => ({ id: file.id, name: file.filename, kind: file.kind, size: file.byteSize }));
}

export async function nodeRoutes(app: FastifyInstance): Promise<void> {
  // Mission changes deliver their effects (node/outbox.ts) wherever the Node API runs.
  registerOutbox();
  registerRoutineRoutes(app);
  const prisma = app.prisma;

  async function sinceJoined(room: NodeRoom, accountId: string): Promise<Prisma.NodeMessageWhereInput> {
    if (room.kind !== "room") return {};
    return joinedFilter(room.kind, (await personIn(prisma, room.id, accountId))?.joinedAt);
  }

  app.get("/api/node/bootstrap", async (request) => {
    const accountId = nodeAccount(request);
    const [user, nodes, rooms, devices, usage, invites] = await Promise.all([
      prisma.user.findUnique({ where: { id: accountId }, select: { id: true, name: true, email: true, emailVerifiedAt: true } }),
      prisma.nodeAgent.findMany({ where: { userId: accountId, parentNodeId: null }, orderBy: { createdAt: "asc" } }),
      roomList(prisma, accountId),
      computers(prisma, accountId),
      credits(accountId),
      incomingInvites(prisma, accountId),
    ]);
    if (!user) throw fail(404, "Account not found.");
    return {
      // `verified`: may talk to nodes. Only the hosted server asks for a verified email.
      me: { id: user.id, name: user.name, email: user.email, verified: Boolean(user.emailVerifiedAt) || !isHosted() },
      nodes: nodes.map(wireNode),
      rooms,
      computers: devices,
      credits: usage,
      // The included models; GET /api/node/models adds own keys and AI plans, which may take a moment.
      models: (() => {
        const options = includedOptions();
        return { default: options.find((row) => row.default)?.model ?? NODE_DEFAULT_MODEL, options };
      })(),
      invites,
      limits: { roomPeople: MAX_ROOM_PEOPLE, nodesPerPerson: MAX_NODES_PER_PERSON, crewNodes: MAX_CREW_NODES, pins: MAX_PINS, reactions: REACTIONS, declineBlockDays: DECLINE_BLOCK_MS / 86_400_000 },
      // Suggestions for a new crew: the person picks, renames, adds or drops nodes before it is made.
      templates: { nodes: NODE_TEMPLATES, crews: CREW_TEMPLATES },
    };
  });

  mirrorNeedsMe();
  app.get("/api/node/events", async (request, reply) => nodeEventStream(request, reply, nodeAccount(request)));
  registerSessionRoutes(app);

  // ── nodes ────────────────────────────────────────────────────────────────────────────────
  app.get("/api/node/nodes", async (request) => {
    const accountId = nodeAccount(request);
    const nodes = await prisma.nodeAgent.findMany({ where: { userId: accountId, parentNodeId: null }, orderBy: { createdAt: "asc" } });
    return { nodes: nodes.map(wireNode) };
  });

  app.post("/api/node/nodes", async (request, reply) => {
    const accountId = nodeAccount(request);
    const body = z.object({
      templateId: z.string().max(40).optional(),
      name: z.string().min(1).max(60).optional(),
      slug: Slug.optional(),
      role: z.string().min(1).max(40).optional(),
      charter: z.string().max(8000).optional(),
      avatar: Avatar.optional(),
      provider: ProviderPick.optional(),
      model: ModelPick.optional(),
    }).strict().parse(request.body ?? {});
    if (body.templateId && !nodeTemplate(body.templateId)) throw fail(400, "Unknown node template.");
    const provider = body.model ? (body.provider ?? INCLUDED_PROVIDER) : null;
    await checkModel(prisma, accountId, provider, body.model);
    if (body.name?.trim() && (await nodeNameTaken(prisma, accountId, body.name))) throw fail(409, `You already have a node called “${body.name.trim()}”. Pick another name.`);
    if ((await prisma.nodeAgent.count({ where: { userId: accountId, parentNodeId: null } })) >= MAX_NODES) throw fail(409, `You have ${MAX_NODES} nodes, the most one account can have.`);
    const { node, room } = await createNode(prisma, accountId, { ...body, provider });
    publishTo([accountId], "node.room", { roomId: room.id });
    return reply.code(201).send({ node: wireNode(node), room: await roomView(prisma, accountId, room) });
  });

  app.patch("/api/node/nodes/:id", async (request) => {
    const accountId = nodeAccount(request);
    const node = await ownNode(prisma, accountId, (request.params as { id: string }).id);
    const body = z.object({
      name: z.string().min(1).max(60).optional(),
      slug: Slug.optional(),
      role: z.string().min(1).max(40).optional(),
      charter: z.string().max(8000).optional(),
      avatar: Avatar.optional(),
      provider: ProviderPick.optional(),
      model: ModelPick.optional(),
      runProfileId: z.string().max(60).nullable().optional(),
      autonomy: z.object({ sharedRooms: z.enum(["ask", "auto"]).optional(), computerFiles: z.boolean().optional(), computerWork: z.enum(["auto", "ask"]).optional(), answerAgentQuestions: z.boolean().optional() }).optional(),
      status: z.enum(["active", "paused"]).optional(),
      effort: z.enum(["low", "medium", "high"]).optional(),
    }).strict().parse(request.body ?? {});
    const provider = body.model ? (body.provider ?? INCLUDED_PROVIDER) : null;
    if (body.model !== undefined) await checkModel(prisma, accountId, provider, body.model);
    if (body.name !== undefined && (await nodeNameTaken(prisma, accountId, body.name, node.id))) throw fail(409, `You already have a node called “${body.name.trim()}”. Pick another name.`);
    const slug = body.slug !== undefined && body.slug !== node.slug ? body.slug : null;
    if (slug && (await prisma.nodeAgent.findFirst({ where: { userId: accountId, slug, id: { not: node.id } }, select: { id: true } }))) throw fail(409, `Another of your nodes is already @${slug}. Pick another handle.`);
    if (slug && (SPECIAL_MENTIONS as readonly string[]).includes(slug)) throw fail(400, `@${slug} mentions every node. Pick another handle.`);
    const autonomy = body.autonomy ? { ...((node.autonomy ?? {}) as Record<string, unknown>), ...body.autonomy } : null;
    const updated = await prisma.nodeAgent.update({
      where: { id: node.id },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(slug ? { slug } : {}),
        ...(body.effort ? { effort: body.effort } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.charter !== undefined ? { charter: body.charter } : {}),
        ...(body.avatar ? { avatar: body.avatar } : {}),
        ...(body.model !== undefined ? { model: body.model, provider } : {}),
        ...(body.runProfileId !== undefined ? { runProfileId: body.runProfileId } : {}),
        ...(autonomy ? { autonomy: autonomy as Prisma.InputJsonValue } : {}),
        ...(body.status ? { status: body.status } : {}),
      },
    });
    if (slug) await renameHandle(updated);
    if (body.name !== undefined && body.name.trim() !== node.name) {
      // A DM is named after its node.
      await prisma.nodeRoom.updateMany({ where: { userId: accountId, kind: "dm", members: { some: { nodeId: node.id } } }, data: { title: body.name.trim() } });
    }
    if (body.status === "paused" && node.status !== "paused") await pause(updated);
    if (slug || body.name !== undefined || body.status) publishTo([accountId], "node.room", { nodeId: node.id });
    return { node: wireNode(updated) };
  });

  /** A new handle: each room it is in uses it, unless someone there has it (then owner-handle). Mentions already sent keep their node. */
  async function renameHandle(node: NodeAgent): Promise<void> {
    const memberships = await prisma.nodeRoomMember.findMany({ where: { nodeId: node.id } });
    for (const member of memberships) {
      const taken = await takenHandles(prisma, member.roomId);
      taken.delete(member.handle);
      let handle = node.slug;
      if (taken.has(handle)) {
        const owner = await prisma.nodeRoomMember.findFirst({ where: { roomId: member.roomId, userId: node.userId, nodeId: null }, select: { handle: true } });
        handle = uniqueHandle(`${owner?.handle ?? "my"}-${node.slug}`, taken);
      }
      if (handle !== member.handle) await prisma.nodeRoomMember.update({ where: { id: member.id }, data: { handle } });
    }
  }

  /**
   * Pausing stops everything the node is doing: its reply, its queued turns and every run it started
   * on the owner's computer. Then it says so in its DM, naming only the work that was still going on.
   */
  async function pause(node: NodeAgent): Promise<void> {
    // Its helpers stop with it.
    const helpers = (await prisma.nodeAgent.findMany({ where: { parentNodeId: node.id }, select: { id: true } })).map((row) => row.id);
    const memberships = await prisma.nodeRoomMember.findMany({ where: { nodeId: { in: [node.id, ...helpers] } } });
    for (const member of memberships) {
      for (const conversationId of [member.conversationId, member.privateConversationId]) if (conversationId) abortAssistantTurn(conversationId);
    }
    await stopTurns(app, [node.id, ...helpers], null);
    const stopped = await stopNodeRuns(app, node);
    // The plans it leads stop; its steps in others' plans end as stopped and those plans go on.
    await stopPlans(app, { nodeId: node.id, userId: node.userId });
    const dm = memberships.length
      ? await prisma.nodeRoom.findFirst({ where: { id: { in: memberships.map((row) => row.roomId) }, kind: "dm", userId: node.userId, archivedAt: null } })
      : null;
    if (dm) {
      await postMessage(prisma, {
        roomId: dm.id,
        userId: node.userId,
        authorKind: "node",
        authorNodeId: node.id,
        body: pausedNotice(stopped),
        data: { notice: "paused", stopped: stopped.length },
        visibleTo: [node.userId],
      });
    }
  }

  app.delete("/api/node/nodes/:id", async (request, reply) => {
    const accountId = nodeAccount(request);
    const node = await ownNode(prisma, accountId, (request.params as { id: string }).id);
    // Its helpers go with it.
    for (const helper of await prisma.nodeAgent.findMany({ where: { parentNodeId: node.id } })) await deleteNode(app, helper);
    await deleteNode(app, node);
    return reply.code(204).send();
  });

  /** Keeps a helper as a lasting node: it leaves its parent and gets its own chat (node/helpers.ts). */
  app.post("/api/node/nodes/:id/promote", async (request, reply) => {
    const accountId = nodeAccount(request);
    try {
      const { node, room } = await promoteHelper(prisma, accountId, (request.params as { id: string }).id);
      publishTo([accountId], "node.room", { roomId: room.id });
      return reply.code(201).send({ node: wireNode(node), room: { id: room.id, title: room.title } });
    } catch (error) {
      if (error instanceof Error && error.name === "ToolBlockedError") throw fail(409, error.message);
      throw error;
    }
  });

  app.get("/api/node/nodes/:id/memory", async (request) => {
    const accountId = nodeAccount(request);
    const node = await ownNode(prisma, accountId, (request.params as { id: string }).id);
    const rows = await prisma.nodeMemory.findMany({ where: { nodeId: node.id }, orderBy: { createdAt: "desc" } });
    return { memories: rows.map((row) => ({ id: row.id, content: row.content, createdAt: row.createdAt.toISOString() })) };
  });

  app.post("/api/node/nodes/:id/memory", async (request, reply) => {
    const accountId = nodeAccount(request);
    const node = await ownNode(prisma, accountId, (request.params as { id: string }).id);
    const body = z.object({ content: z.string().min(1).max(500) }).strict().parse(request.body);
    const row = await prisma.nodeMemory.create({ data: { userId: accountId, nodeId: node.id, content: body.content.trim() } });
    return reply.code(201).send({ memory: { id: row.id, content: row.content, createdAt: row.createdAt.toISOString() } });
  });

  app.delete("/api/node/nodes/:id/memory/:memoryId", async (request, reply) => {
    const accountId = nodeAccount(request);
    const { id, memoryId } = request.params as { id: string; memoryId: string };
    const node = await ownNode(prisma, accountId, id);
    const deleted = await prisma.nodeMemory.deleteMany({ where: { id: memoryId, nodeId: node.id, userId: accountId } });
    if (!deleted.count) throw fail(404, "That memory is not available.");
    return reply.code(204).send();
  });

  // ── crews and rooms ──────────────────────────────────────────────────────────────────────
  // A crew is one person and nodes they choose. A room has other people too: its creator invites them,
  // and each person who accepts brings 1–3 of their own nodes, one of them their lead.

  app.post("/api/node/crews", async (request, reply) => {
    const accountId = nodeAccount(request);
    const body = z.object({
      title: z.string().min(1).max(80),
      nodeIds: z.array(z.string().uuid()).min(1).max(MAX_CREW_NODES),
      leadNodeId: z.string().uuid().optional(),
    }).strict().parse(request.body);
    const title = body.title.trim();
    if (!title) throw fail(400, "Give the crew a name.");
    if (await roomTitleTaken(prisma, accountId, title)) throw fail(409, `You already have a crew or room called “${title}”. Pick another name.`);
    const ids = [...new Set(body.nodeIds)];
    const found = await prisma.nodeAgent.findMany({ where: { id: { in: ids }, userId: accountId, parentNodeId: null } });
    if (found.length !== ids.length) throw fail(404, "That node is not available.");
    const nodes = ids.map((id) => found.find((node) => node.id === id)!);
    const lead = nodes.find((node) => node.id === body.leadNodeId) ?? nodes.find((node) => node.role === "manager") ?? nodes[0]!;
    const room = await createCrew(prisma, accountId, title, nodes, lead);
    publishTo([accountId], "node.room", { roomId: room.id });
    return reply.code(201).send({ room: await roomView(prisma, accountId, room) });
  });

  app.get("/api/node/rooms", async (request) => ({ rooms: await roomList(prisma, nodeAccount(request)) }));

  app.post("/api/node/rooms", async (request, reply) => {
    const accountId = nodeAccount(request);
    const body = z.object({
      title: z.string().min(1).max(80),
      nodeIds: z.array(z.string().uuid()).min(1).max(MAX_NODES_PER_PERSON),
      leadNodeId: z.string().uuid().optional(),
      invite: z.array(z.string().email().max(320)).max(MAX_ROOM_PEOPLE - 1).default([]),
    }).strict().parse(request.body);
    const title = body.title.trim();
    if (!title) throw fail(400, "Give the room a name.");
    if (await roomTitleTaken(prisma, accountId, title)) throw fail(409, `You already have a crew or room called “${title}”. Pick another name.`);
    const ids = [...new Set(body.nodeIds)];
    const nodes = await prisma.nodeAgent.findMany({ where: { id: { in: ids }, userId: accountId } });
    if (nodes.length !== ids.length) throw fail(404, "That node is not available.");
    const lead = nodes.find((node) => node.id === body.leadNodeId) ?? nodes[0]!;
    const room = await prisma.$transaction(async (tx) => {
      const created = await tx.nodeRoom.create({ data: { userId: accountId, kind: "room", title, settings: {} } });
      await addPerson(tx, created.id, accountId, "owner");
      for (const id of ids) await addNode(tx, created.id, nodes.find((node) => node.id === id)!, id === lead.id);
      return created;
    });
    const invited: Array<{ email: string; ok: boolean; error?: string }> = [];
    for (const email of [...new Set(body.invite.map((row) => row.trim().toLowerCase()))]) {
      try {
        await inviteToRoom(room, accountId, email);
        invited.push({ email, ok: true });
      } catch (error) {
        invited.push({ email, ok: false, error: error instanceof Error ? error.message : "Could not invite." });
      }
    }
    publishTo([accountId], "node.room", { roomId: room.id });
    return reply.code(201).send({ room: await roomView(prisma, accountId, room), invited });
  });

  app.get("/api/node/rooms/:id", async (request) => {
    const accountId = nodeAccount(request);
    const room = await roomFor(prisma, accountId, (request.params as { id: string }).id);
    return { room: await roomView(prisma, accountId, room) };
  });

  app.patch("/api/node/rooms/:id", async (request) => {
    const accountId = nodeAccount(request);
    const room = await roomFor(prisma, accountId, (request.params as { id: string }).id);
    const body = z.object({
      title: z.string().min(1).max(80).optional(),
      leadNodeIds: z.array(z.string().uuid()).max(3).optional(),
      responsibility: z.string().max(300).nullable().optional(),
    }).strict().parse(request.body ?? {});
    if ((body.title !== undefined || body.leadNodeIds !== undefined) && room.userId !== accountId) throw fail(403, "Only the person who made this room can rename it or pick its lead.");
    const title = body.title?.trim();
    if (title !== undefined) {
      if (!title) throw fail(400, "Give it a name.");
      if (room.kind !== "dm" && (await roomTitleTaken(prisma, accountId, title, room.id))) throw fail(409, `You already have a crew or room called “${title}”. Pick another name.`);
    }
    const settings = roomSettings(room);
    if (body.leadNodeIds) {
      const inRoom = await prisma.nodeRoomMember.count({ where: { roomId: room.id, nodeId: { in: body.leadNodeIds } } });
      if (inRoom !== new Set(body.leadNodeIds).size) throw fail(400, "A lead must be a node in this room.");
      settings.leadNodeIds = body.leadNodeIds;
    }
    if (body.responsibility !== undefined) {
      if (body.responsibility?.trim()) settings.responsibilities[accountId] = body.responsibility.trim();
      else delete settings.responsibilities[accountId];
    }
    const updated = await prisma.nodeRoom.update({
      where: { id: room.id },
      data: { ...(title ? { title } : {}), settings: settings as Prisma.InputJsonValue },
    });
    publishTo(await roomPeople(prisma, room.id), "node.room", { roomId: room.id });
    return { room: await roomView(prisma, accountId, updated) };
  });

  app.delete("/api/node/rooms/:id", async (request, reply) => {
    const accountId = nodeAccount(request);
    const room = await roomFor(prisma, accountId, (request.params as { id: string }).id);
    if (room.userId !== accountId) throw fail(403, "Only the person who made this room can delete it. You can leave it.");
    if (room.kind === "task") {
      // A helper's room goes with its helper.
      const helper = await prisma.nodeAgent.findFirst({ where: { userId: accountId, parentNodeId: { not: null }, memberships: { some: { roomId: room.id } } } });
      if (helper) await deleteNode(app, helper);
      else await prisma.nodeRoom.delete({ where: { id: room.id } });
      return reply.code(204).send();
    }
    const people = await roomPeople(prisma, room.id);
    await prisma.$transaction([
      prisma.nodeRoom.update({ where: { id: room.id }, data: { archivedAt: new Date() } }),
      prisma.nodeRoomInvite.updateMany({ where: { roomId: room.id, status: "pending" }, data: { status: "cancelled", respondedAt: new Date() } }),
    ]);
    publishTo(people, "node.room", { deleted: [room.id] });
    return reply.code(204).send();
  });

  // ── requests to join a room ──────────────────────────────────────────────────────────────

  /** Asks the person with this email to join; the guardrails are here, so every way in shares them. */
  async function inviteToRoom(room: NodeRoom, inviterId: string, email: string) {
    if (room.kind !== "room") throw fail(400, "Only rooms have other people. Make a room to invite someone.");
    if (room.userId !== inviterId) throw fail(403, "Only the person who made this room can invite people.");
    const person = await prisma.user.findFirst({ where: { email: { equals: email.trim(), mode: "insensitive" } }, select: { id: true, name: true, email: true } });
    if (!person) throw fail(404, `No Ensemble account uses ${email.trim()} yet. Ask them to sign up first.`);
    if (person.id === inviterId) throw fail(400, "You are already in this room.");
    const label = person.name?.trim() || person.email;
    if (await personIn(prisma, room.id, person.id)) throw fail(409, `${label} is already in this room.`);
    const last = await prisma.nodeRoomInvite.findFirst({ where: { roomId: room.id, inviteeId: person.id }, orderBy: { createdAt: "desc" } });
    if (last?.status === "pending") throw fail(409, `${label} already has a request to join.`);
    if (last?.status === "declined" && last.respondedAt && Date.now() - last.respondedAt.getTime() < DECLINE_BLOCK_MS) {
      const again = new Date(last.respondedAt.getTime() + DECLINE_BLOCK_MS);
      throw fail(409, `${label} declined on ${dayText(last.respondedAt)}. You can ask again after ${dayText(again)}.`);
    }
    const [people, pending] = await Promise.all([
      prisma.nodeRoomMember.count({ where: { roomId: room.id, nodeId: null } }),
      prisma.nodeRoomInvite.count({ where: { roomId: room.id, status: "pending" } }),
    ]);
    if (people + pending >= MAX_ROOM_PEOPLE) throw fail(409, `A room holds at most ${MAX_ROOM_PEOPLE} people, counting open requests.`);
    let invite;
    try {
      invite = await prisma.nodeRoomInvite.create({ data: { roomId: room.id, inviterId, inviteeId: person.id } });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") throw fail(409, `${label} already has a request to join.`);
      throw error;
    }
    publishTo([person.id], "node.invite", { inviteId: invite.id, roomId: room.id });
    publishTo([inviterId], "node.room", { roomId: room.id });
    return invite;
  }

  app.post("/api/node/rooms/:id/invites", async (request, reply) => {
    const accountId = nodeAccount(request);
    const room = await roomFor(prisma, accountId, (request.params as { id: string }).id);
    const body = z.object({ email: z.string().email().max(320) }).strict().parse(request.body);
    await requireVerifiedUser(accountId);
    const invite = await inviteToRoom(room, accountId, body.email);
    return reply.code(201).send({ invite: { id: invite.id, status: invite.status }, room: await roomView(prisma, accountId, room) });
  });

  app.delete("/api/node/rooms/:id/invites/:inviteId", async (request, reply) => {
    const accountId = nodeAccount(request);
    const { id, inviteId } = request.params as { id: string; inviteId: string };
    const room = await roomFor(prisma, accountId, id);
    if (room.userId !== accountId) throw fail(403, "Only the person who made this room can withdraw a request.");
    const done = await prisma.nodeRoomInvite.updateMany({ where: { id: inviteId, roomId: room.id, status: "pending" }, data: { status: "cancelled", respondedAt: new Date() } });
    if (!done.count) throw fail(404, "That request is not open.");
    publishTo([accountId], "node.room", { roomId: room.id });
    return reply.code(204).send();
  });

  app.get("/api/node/invites", async (request) => ({ invites: await incomingInvites(prisma, nodeAccount(request)) }));

  app.post("/api/node/invites/:id/accept", async (request, reply) => {
    const accountId = nodeAccount(request);
    const body = z.object({
      nodeIds: z.array(z.string().uuid()).min(1, "Pick at least one of your nodes to bring.").max(MAX_NODES_PER_PERSON, `Bring at most ${MAX_NODES_PER_PERSON} nodes.`),
      leadNodeId: z.string().uuid().optional(),
    }).strict().parse(request.body);
    const invite = await prisma.nodeRoomInvite.findFirst({ where: { id: (request.params as { id: string }).id, inviteeId: accountId } });
    if (!invite) throw fail(404, "That request is not available.");
    if (invite.status !== "pending") throw fail(409, "That request was already answered or withdrawn.");
    const room = await prisma.nodeRoom.findUnique({ where: { id: invite.roomId } });
    if (!room || room.archivedAt) {
      await prisma.nodeRoomInvite.update({ where: { id: invite.id }, data: { status: "cancelled", respondedAt: new Date() } });
      throw fail(409, "That room was deleted.");
    }
    const ids = [...new Set(body.nodeIds)];
    const nodes = await prisma.nodeAgent.findMany({ where: { id: { in: ids }, userId: accountId } });
    if (nodes.length !== ids.length) throw fail(404, "That node is not available.");
    const lead = nodes.find((node) => node.id === body.leadNodeId) ?? nodes.find((node) => node.id === ids[0])!;
    if ((await prisma.nodeRoomMember.count({ where: { roomId: room.id, nodeId: null } })) >= MAX_ROOM_PEOPLE) throw fail(409, `This room already has ${MAX_ROOM_PEOPLE} people.`);
    const handles = await prisma.$transaction(async (tx) => {
      const taken = await tx.nodeRoomInvite.updateMany({ where: { id: invite.id, status: "pending" }, data: { status: "accepted", respondedAt: new Date() } });
      if (!taken.count) throw fail(409, "That request was already answered or withdrawn.");
      await addPerson(tx, room.id, accountId);
      const added: string[] = [];
      for (const id of ids) added.push((await addNode(tx, room.id, nodes.find((node) => node.id === id)!, id === lead.id)).handle);
      return added;
    });
    const who = await names(prisma, [accountId]);
    await postMessage(prisma, { roomId: room.id, userId: accountId, authorKind: "system", kind: "status", body: `${who.get(accountId)?.name ?? "Someone"} joined with ${handles.map((handle) => `@${handle}`).join(", ")}.` });
    publishTo(await roomPeople(prisma, room.id), "node.room", { roomId: room.id });
    return reply.code(201).send({ room: await roomView(prisma, accountId, room) });
  });

  app.post("/api/node/invites/:id/decline", async (request, reply) => {
    const accountId = nodeAccount(request);
    const invite = await prisma.nodeRoomInvite.findFirst({ where: { id: (request.params as { id: string }).id, inviteeId: accountId } });
    if (!invite) throw fail(404, "That request is not available.");
    const done = await prisma.nodeRoomInvite.updateMany({ where: { id: invite.id, status: "pending" }, data: { status: "declined", respondedAt: new Date() } });
    if (!done.count) throw fail(409, "That request was already answered or withdrawn.");
    const room = await prisma.nodeRoom.findUnique({ where: { id: invite.roomId } });
    if (room && !room.archivedAt) {
      const who = await names(prisma, [accountId]);
      // Only the person who asked learns of it.
      await postMessage(prisma, { roomId: room.id, userId: invite.inviterId, authorKind: "system", kind: "status", body: `${who.get(accountId)?.name ?? "Someone"} declined to join.`, visibleTo: [invite.inviterId] });
      publishTo([invite.inviterId], "node.room", { roomId: room.id });
    }
    return reply.code(204).send();
  });

  // ── members ──────────────────────────────────────────────────────────────────────────────

  app.post("/api/node/rooms/:id/nodes", async (request, reply) => {
    const accountId = nodeAccount(request);
    const room = await roomFor(prisma, accountId, (request.params as { id: string }).id);
    if (room.kind === "dm") throw fail(400, "A direct chat has one node. Make a crew for more.");
    if (room.kind === "task") throw fail(400, "A helper's room holds the node and its helper only.");
    if (room.kind === "crew" && room.userId !== accountId) throw fail(403, "Only the person who made this crew can add nodes to it.");
    const body = z.object({ nodeId: z.string().uuid(), lead: z.boolean().optional() }).strict().parse(request.body);
    const node = await ownNode(prisma, accountId, body.nodeId);
    if (node.parentNodeId) throw fail(400, "A helper stays in its own room.");
    if (await prisma.nodeRoomMember.findFirst({ where: { roomId: room.id, nodeId: node.id }, select: { id: true } })) throw fail(409, `@${node.slug} is already here.`);
    if (room.kind === "crew" && (await prisma.nodeRoomMember.count({ where: { roomId: room.id, nodeId: { not: null } } })) >= MAX_CREW_NODES) {
      throw fail(409, `A crew holds at most ${MAX_CREW_NODES} nodes.`);
    }
    let lead = false;
    if (room.kind === "room") {
      const mine = await prisma.nodeRoomMember.findMany({ where: { roomId: room.id, userId: accountId, nodeId: { not: null } } });
      if (mine.length >= MAX_NODES_PER_PERSON) throw fail(409, `Each person brings at most ${MAX_NODES_PER_PERSON} nodes to a room.`);
      lead = body.lead === true || mine.length === 0;
    }
    const member = await prisma.$transaction(async (tx) => {
      if (lead) await tx.nodeRoomMember.updateMany({ where: { roomId: room.id, userId: accountId, nodeId: { not: null } }, data: { representative: false } });
      return addNode(tx, room.id, node, lead);
    });
    await postMessage(prisma, { roomId: room.id, userId: accountId, authorKind: "system", kind: "status", body: `@${member.handle} joined.` });
    publishTo(await roomPeople(prisma, room.id), "node.room", { roomId: room.id });
    return reply.code(201).send({ member: { id: member.id, handle: member.handle }, room: await roomView(prisma, accountId, room) });
  });

  /** Makes one of my nodes in this room my lead (in a crew: the crew's lead). */
  app.patch("/api/node/rooms/:id/members/:memberId", async (request) => {
    const accountId = nodeAccount(request);
    const { id, memberId } = request.params as { id: string; memberId: string };
    const room = await roomFor(prisma, accountId, id);
    z.object({ lead: z.literal(true) }).strict().parse(request.body);
    const member = await prisma.nodeRoomMember.findFirst({ where: { id: memberId, roomId: room.id, userId: accountId, nodeId: { not: null } } });
    if (!member) throw fail(404, "That is not one of your nodes in this room.");
    if (room.kind === "room") {
      await prisma.$transaction([
        prisma.nodeRoomMember.updateMany({ where: { roomId: room.id, userId: accountId, nodeId: { not: null } }, data: { representative: false } }),
        prisma.nodeRoomMember.update({ where: { id: member.id }, data: { representative: true } }),
      ]);
    } else {
      if (room.userId !== accountId) throw fail(403, "Only the person who made this crew can pick its lead.");
      await prisma.nodeRoom.update({ where: { id: room.id }, data: { settings: { ...roomSettings(room), leadNodeIds: [member.nodeId!] } as Prisma.InputJsonValue } });
    }
    publishTo(await roomPeople(prisma, room.id), "node.room", { roomId: room.id });
    return { room: await roomView(prisma, accountId, (await prisma.nodeRoom.findUnique({ where: { id: room.id } }))!) };
  });

  app.delete("/api/node/rooms/:id/members/:memberId", async (request, reply) => {
    const accountId = nodeAccount(request);
    const { id, memberId } = request.params as { id: string; memberId: string };
    const room = await roomFor(prisma, accountId, id);
    const member = await prisma.nodeRoomMember.findFirst({ where: { id: memberId, roomId: room.id } });
    if (!member) throw fail(404, "That member is not in this room.");
    if (member.userId !== accountId && room.userId !== accountId) throw fail(403, "You can remove yourself and your own nodes.");
    if (!member.nodeId && member.userId === room.userId) throw fail(400, "The person who made a room cannot leave it. Delete the room instead.");
    if (room.kind === "dm" && member.nodeId) throw fail(400, "A direct chat keeps its node. Delete the node instead.");
    const theirs = await prisma.nodeRoomMember.findMany({ where: { roomId: room.id, userId: member.userId, nodeId: { not: null } }, orderBy: { joinedAt: "asc" } });
    if (member.nodeId && room.kind === "room" && member.userId === accountId && theirs.length <= 1) {
      throw fail(400, "Keep at least one of your nodes in a room, or leave the room.");
    }
    const people = await roomPeople(prisma, room.id);
    await prisma.$transaction(async (tx) => {
      // A person who leaves takes their nodes along.
      await tx.nodeRoomMember.deleteMany({ where: member.nodeId ? { id: member.id } : { roomId: room.id, userId: member.userId } });
      const next = theirs.find((row) => row.id !== member.id);
      if (member.representative && next) await tx.nodeRoomMember.update({ where: { id: next.id }, data: { representative: true } });
      // A crew whose lead left is led by its manager, else its first remaining node.
      const settings = roomSettings(room);
      const gone = new Set(member.nodeId ? [member.nodeId] : theirs.map((row) => row.nodeId!));
      if (settings.leadNodeIds.some((id) => gone.has(id))) {
        const remaining = await tx.nodeRoomMember.findMany({ where: { roomId: room.id, nodeId: { not: null } }, include: { node: true }, orderBy: { joinedAt: "asc" } });
        const kept = settings.leadNodeIds.filter((id) => !gone.has(id));
        const lead = kept[0] ?? remaining.find((row) => row.node?.role === "manager")?.nodeId ?? remaining[0]?.nodeId;
        await tx.nodeRoom.update({ where: { id: room.id }, data: { settings: { ...settings, leadNodeIds: lead ? [lead] : [] } as Prisma.InputJsonValue } });
      }
    });
    if (member.nodeId) await stopTurns(app, [member.nodeId], room.id);
    else await stopTurns(app, theirs.map((row) => row.nodeId!), room.id);
    await postMessage(prisma, { roomId: room.id, userId: accountId, authorKind: "system", kind: "status", body: `@${member.handle} left.` });
    publishTo(people, "node.room", { roomId: room.id });
    return reply.code(204).send();
  });

  // ── messages ─────────────────────────────────────────────────────────────────────────────
  app.get("/api/node/rooms/:id/messages", async (request) => {
    const accountId = nodeAccount(request);
    const room = await roomFor(prisma, accountId, (request.params as { id: string }).id);
    const query = z.object({
      after: z.coerce.number().int().min(0).optional(),
      before: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(80),
      /** people: what people wrote (and system lines); nodes: what nodes wrote. */
      author: z.enum(["all", "people", "nodes"]).default("all"),
    }).parse(request.query ?? {});
    const rows = await prisma.nodeMessage.findMany({
      where: {
        roomId: room.id,
        ...(await sinceJoined(room, accountId)),
        ...visibleWhere(accountId),
        ...(query.author === "people" ? { authorKind: { in: ["human", "system"] } } : query.author === "nodes" ? { authorKind: "node" } : {}),
        ...(query.after !== undefined ? { seq: { gt: query.after } } : query.before !== undefined ? { seq: { lt: query.before } } : {}),
      },
      orderBy: { seq: query.after !== undefined ? "asc" : "desc" },
      take: query.limit,
    });
    if (query.after === undefined) rows.reverse();
    return { messages: rows.map(wireMessage) };
  });

  app.post("/api/node/rooms/:id/messages", async (request, reply) => {
    const accountId = nodeAccount(request);
    const room = await roomFor(prisma, accountId, (request.params as { id: string }).id);
    const body = z.object({
      body: z.string().max(8000).default(""),
      clientId: z.string().min(1).max(80).optional(),
      private: z.boolean().optional(),
      replyToId: z.string().uuid().optional(),
      files: z.array(z.string().uuid()).max(MESSAGE_FILES_MAX).optional(),
    }).strict().parse(request.body);
    const text = stripLoneSurrogates(body.body).trim();
    // Files ride on a message by reference: they stay in the sender's Files (src/files).
    const files = await messageFiles(prisma, accountId, body.files ?? []);
    if (!text && !files.length) throw fail(400, "That message is empty.");
    if (room.kind === "task") throw fail(403, "This is a helper's room: you read along, and talk to the node that made it in your chat with it.");
    // Nodes spend model credits on the account's behalf: same rule as the assistant.
    await requireVerifiedUser(accountId);
    const members = await prisma.nodeRoomMember.findMany({ where: { roomId: room.id } });
    const visibleTo = body.private ? [accountId] : [];
    let replyTo: Record<string, unknown> | undefined;
    if (body.replyToId) {
      const target = await prisma.nodeMessage.findFirst({ where: { id: body.replyToId, roomId: room.id, ...visibleWhere(accountId), ...(await sinceJoined(room, accountId)) } });
      if (!target) throw fail(404, "That message is not available.");
      // A reply quotes its message to everyone who reads the reply: it may not widen a private one.
      if (visibleTo.length === 0 && target.visibleTo.length > 0) throw fail(400, "Reply to a private message privately (Only me).");
      const author = target.authorNodeId ? members.find((row) => row.nodeId === target.authorNodeId) : members.find((row) => !row.nodeId && row.userId === target.userId);
      replyTo = { id: target.id, seq: target.seq, authorKind: target.authorKind, handle: author?.handle ?? null, excerpt: truncateText(messageDeleted(target) ? "Deleted message" : target.body, 160) };
    }
    const { message, duplicate } = await postMessage(prisma, {
      roomId: room.id,
      userId: accountId,
      authorKind: "human",
      body: text,
      ...(replyTo || files.length ? { data: { ...(replyTo ? { replyTo } : {}), ...(files.length ? { files } : {}) } } : {}),
      visibleTo,
      mentions: mentionsFor(text, members, visibleTo),
      clientId: body.clientId ?? null,
    });
    // "stop" / "stop all" from a person with nodes here stops their work at once, without a model (node/stop.ts).
    const command = !duplicate && !files.length ? stopCommand(text) : null;
    if (command && members.some((row) => row.nodeId && row.userId === accountId)) {
      const stopped = await stopWork(app, room, accountId, command);
      await postMessage(prisma, { roomId: room.id, userId: accountId, authorKind: "system", kind: "status", body: stoppedLine(stopped), data: { stopped } as Prisma.InputJsonObject, visibleTo: [accountId] });
    } else if (!duplicate) inBackground(app, () => dispatchMessage(app, message));
    return reply.code(duplicate ? 200 : 201).send({ message: wireMessage(message), duplicate });
  });

  app.post("/api/node/rooms/:id/read", async (request, reply) => {
    const accountId = nodeAccount(request);
    const room = await roomFor(prisma, accountId, (request.params as { id: string }).id);
    const body = z.object({ seq: z.number().int().min(0) }).strict().parse(request.body);
    await prisma.nodeRoomMember.updateMany({ where: { roomId: room.id, userId: accountId, nodeId: null, readSeq: { lt: body.seq } }, data: { readSeq: Math.min(body.seq, room.lastSeq) } });
    return reply.code(204).send();
  });

  /** Stops one of my plans: its steps that have not ended and the agent runs they started (node/plans.ts). */
  app.post("/api/node/plans/:id/stop", async (request) => {
    const accountId = nodeAccount(request);
    const plan = await prisma.nodeMessage.findUnique({ where: { id: (request.params as { id: string }).id } });
    if (!plan || plan.kind !== "plan" || plan.userId !== accountId || !(await personIn(prisma, plan.roomId, accountId))) throw fail(404, "That plan is not available.");
    // Its turns (steps and the lead's report) stop with it; the nodes' other conversations go on.
    return { stopped: await stopPlans(app, { planId: plan.id, userId: accountId }) };
  });

  /** Stops what my nodes do in this conversation: replies, plans and the agent runs started here (all: everywhere). */
  app.post("/api/node/rooms/:id/stop", async (request) => {
    const accountId = nodeAccount(request);
    const room = await roomFor(prisma, accountId, (request.params as { id: string }).id);
    const scope = z.object({ scope: z.enum(["room", "all"]).default("room") }).strict().parse(request.body ?? {}).scope;
    const stopped = await stopWork(app, room, accountId, scope);
    return { stopped: stopped.turns + stopped.plans + stopped.runs, detail: stopped, line: stoppedLine(stopped) };
  });

  /** Deletes one of my own messages: its text goes, a "deleted" line stays so replies still make sense. */
  app.delete("/api/node/messages/:id", async (request, reply) => {
    const accountId = nodeAccount(request);
    const message = await prisma.nodeMessage.findUnique({ where: { id: (request.params as { id: string }).id } });
    if (!message || !canSee(message, accountId) || !(await personIn(prisma, message.roomId, accountId))) throw fail(404, "That message is not available.");
    if (message.authorKind !== "human" || message.userId !== accountId || message.kind !== "text") throw fail(403, "You can delete only your own messages.");
    if (messageDeleted(message)) return reply.code(204).send();
    const data: Record<string, unknown> = { ...((message.data ?? {}) as Record<string, unknown>), deleted: true, deletedAt: new Date().toISOString() };
    delete data.reactions;
    delete data.files;
    const updated = await prisma.nodeMessage.update({ where: { id: message.id }, data: { body: "", mentions: [], data: data as Prisma.InputJsonValue } });
    const room = await prisma.nodeRoom.findUnique({ where: { id: message.roomId } });
    if (room && roomSettings(room).pinned.includes(message.id)) {
      const settings = roomSettings(room);
      settings.pinned = settings.pinned.filter((id) => id !== message.id);
      await prisma.nodeRoom.update({ where: { id: room.id }, data: { settings: settings as Prisma.InputJsonValue } });
      publishTo(await roomPeople(prisma, room.id), "node.room", { roomId: room.id });
    }
    await announce(prisma, updated, "node.message.updated");
    return reply.code(204).send();
  });

  /** Adds my reaction, or takes it back when it is already there. */
  app.post("/api/node/messages/:id/reactions", async (request) => {
    const accountId = nodeAccount(request);
    const body = z.object({ emoji: z.enum(REACTIONS) }).strict().parse(request.body);
    const id = (request.params as { id: string }).id;
    const found = await prisma.nodeMessage.findUnique({ where: { id } });
    if (!found || !canSee(found, accountId) || !(await personIn(prisma, found.roomId, accountId)) || messageDeleted(found)) throw fail(404, "That message is not available.");
    const updated = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM node_messages WHERE id = ${id} FOR UPDATE`;
      const row = (await tx.nodeMessage.findUnique({ where: { id } }))!;
      const data = { ...((row.data ?? {}) as Record<string, unknown>) };
      const reactions = { ...((data.reactions ?? {}) as Record<string, string[]>) };
      const who = new Set(reactions[body.emoji] ?? []);
      if (who.has(accountId)) who.delete(accountId);
      else who.add(accountId);
      if (who.size) reactions[body.emoji] = [...who];
      else delete reactions[body.emoji];
      data.reactions = reactions;
      return tx.nodeMessage.update({ where: { id }, data: { data: data as Prisma.InputJsonValue } });
    });
    await announce(prisma, updated, "node.message.updated");
    return { message: wireMessage(updated) };
  });

  app.get("/api/node/rooms/:id/pins", async (request) => {
    const accountId = nodeAccount(request);
    const room = await roomFor(prisma, accountId, (request.params as { id: string }).id);
    const pinned = roomSettings(room).pinned;
    const rows = await prisma.nodeMessage.findMany({ where: { id: { in: pinned }, roomId: room.id, ...visibleWhere(accountId), ...(await sinceJoined(room, accountId)) } });
    return { messages: pinned.map((id) => rows.find((row) => row.id === id)).filter((row): row is NonNullable<typeof row> => Boolean(row)).map(wireMessage) };
  });

  /** Pins or unpins a message everyone in the room can read. Anyone in the room may. */
  app.post("/api/node/rooms/:id/pins", async (request) => {
    const accountId = nodeAccount(request);
    const room = await roomFor(prisma, accountId, (request.params as { id: string }).id);
    const body = z.object({ messageId: z.string().uuid(), pinned: z.boolean() }).strict().parse(request.body);
    const settings = roomSettings(room);
    if (body.pinned) {
      const message = await prisma.nodeMessage.findFirst({ where: { id: body.messageId, roomId: room.id } });
      if (!message || message.visibleTo.length > 0 || messageDeleted(message) || (message.kind !== "text" && message.kind !== "run")) throw fail(400, "Only messages everyone here can read can be pinned.");
      if (!settings.pinned.includes(message.id)) {
        if (settings.pinned.length >= MAX_PINS) throw fail(409, `A room keeps at most ${MAX_PINS} pins. Unpin one first.`);
        settings.pinned = [message.id, ...settings.pinned];
      }
    } else {
      settings.pinned = settings.pinned.filter((id) => id !== body.messageId);
    }
    const updated = await prisma.nodeRoom.update({ where: { id: room.id }, data: { settings: settings as Prisma.InputJsonValue } });
    publishTo(await roomPeople(prisma, room.id), "node.room", { roomId: room.id });
    return { room: await roomView(prisma, accountId, updated) };
  });

  /** Messages I can read, across my rooms or in one: text that contains every word of `q`. */
  app.get("/api/node/search", async (request) => {
    const accountId = nodeAccount(request);
    const query = z.object({
      q: z.string().trim().min(2, "Type at least two characters.").max(200),
      roomId: z.string().uuid().optional(),
      author: z.enum(["all", "people", "nodes"]).default("all"),
      limit: z.coerce.number().int().min(1).max(100).default(40),
    }).parse(request.query ?? {});
    const memberships = await prisma.nodeRoomMember.findMany({
      where: { userId: accountId, nodeId: null, ...(query.roomId ? { roomId: query.roomId } : {}), room: { archivedAt: null } },
      include: { room: { select: { id: true, title: true, kind: true } } },
    });
    if (!memberships.length) return { results: [] };
    const words = query.q.split(/\s+/).filter(Boolean).slice(0, 6);
    const rows = await prisma.nodeMessage.findMany({
      where: {
        OR: memberships.map((row) => ({ roomId: row.roomId, ...(row.room.kind === "room" ? { createdAt: { gte: row.joinedAt } } : {}) })),
        kind: { in: ["text", "run"] },
        ...visibleWhere(accountId),
        ...(query.author === "people" ? { authorKind: "human" } : query.author === "nodes" ? { authorKind: "node" } : {}),
        AND: words.map((word) => ({ body: { contains: word, mode: "insensitive" as const } })),
      },
      orderBy: { createdAt: "desc" },
      take: query.limit,
    });
    const rooms = new Map(memberships.map((row) => [row.roomId, row.room]));
    return { results: rows.map((row) => ({ message: wireMessage(row), room: rooms.get(row.roomId)! })) };
  });

  /** The room as Markdown: what I can read, oldest first. */
  app.get("/api/node/rooms/:id/export", async (request, reply) => {
    const accountId = nodeAccount(request);
    const room = await roomFor(prisma, accountId, (request.params as { id: string }).id);
    const [rows, members] = await Promise.all([
      prisma.nodeMessage.findMany({ where: { roomId: room.id, kind: { in: ["text", "status", "run"] }, ...visibleWhere(accountId), ...(await sinceJoined(room, accountId)) }, orderBy: { seq: "asc" }, take: 5000 }),
      prisma.nodeRoomMember.findMany({ where: { roomId: room.id } }),
    ]);
    const who = await names(prisma, members.filter((row) => !row.nodeId).map((row) => row.userId));
    const label = (row: (typeof rows)[number]) => {
      if (row.authorKind === "system") return "·";
      if (row.authorNodeId) return `@${members.find((member) => member.nodeId === row.authorNodeId)?.handle ?? "node"}`;
      return who.get(row.userId)?.name ?? "Someone";
    };
    const lines = [`# ${room.title}`, "", `Exported from Ensemble Node on ${new Date().toISOString()}.`, ""];
    for (const row of rows) {
      const text = messageDeleted(row) ? "_Deleted message_" : row.body;
      lines.push(`**${label(row)}** · ${row.createdAt.toISOString()}${row.visibleTo.length ? " · private" : ""}`, "", text, "");
    }
    const file = `${room.title.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "room"}.md`;
    return reply.header("content-type", "text/markdown; charset=utf-8").header("content-disposition", `attachment; filename="${file}"`).send(lines.join("\n"));
  });

  /** Every model a node can use: included (credits), the account's own keys, AI plans on its computers. */
  app.get("/api/node/models", async (request) => {
    const accountId = nodeAccount(request);
    const { options, problems } = await nodeModelOptions(prisma, accountId);
    return { default: options.find((row) => row.default)?.model ?? NODE_DEFAULT_MODEL, options, problems };
  });

  // ── approvals, runs, activity ────────────────────────────────────────────────────────────
  app.post("/api/node/approvals/:messageId", async (request, reply) => {
    const accountId = nodeAccount(request);
    const body = z.object({
      decision: z.enum(["approve", "discard"]),
      callIds: z.array(z.string().max(120)).max(32).optional(),
      body: z.string().min(1).max(6000).optional(),
    }).strict().parse(request.body);
    try {
      const message = await settleApproval(app, accountId, (request.params as { messageId: string }).messageId, body);
      return { message: wireMessage(message) };
    } catch (error) {
      if (error instanceof ApprovalError || error instanceof SecretError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.get("/api/node/runs", async (request) => ({ runs: await runList(prisma, nodeAccount(request)) }));

  /** The value for a node's secret request: relayed to the card's computer, never stored or logged here (node/node-secrets.ts). */
  app.post("/api/node/secrets/:messageId", async (request, reply) => {
    const accountId = nodeAccount(request);
    const { value } = z.object({ value: z.string().min(1).max(16 * 1024) }).strict().parse(request.body);
    try {
      return { message: wireMessage(await saveSecret(app, accountId, (request.params as { messageId: string }).messageId, value)) };
    } catch (error) {
      if (error instanceof SecretError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  /** My nodes' pending approval cards, with the node and conversation: Needs me on Node and in the Hub. */
  app.get("/api/node/approvals", async (request) => ({ approvals: await approvalCards(prisma, nodeAccount(request)), nodeUrl: nodeWebOrigin() }));

  app.get("/api/node/activity", async (request) => {
    const accountId = nodeAccount(request);
    const [approvals, runs, turns, devices, usage, waiting] = await Promise.all([
      pendingApprovals(prisma, accountId),
      runList(prisma, accountId, 20),
      prisma.nodeTurn.findMany({ where: { userId: accountId }, orderBy: { createdAt: "desc" }, take: 30 }),
      computers(prisma, accountId),
      credits(accountId),
      waitingTasks(prisma, accountId),
    ]);
    return {
      approvals,
      waitingTasks: waiting,
      runs,
      turns: turns.map((turn) => ({ id: turn.id, nodeId: turn.nodeId, roomId: turn.roomId, reason: turn.reason, status: turn.status, model: turn.model, credits: turn.credits, error: turn.error, private: turn.private, createdAt: turn.createdAt.toISOString(), finishedAt: turn.finishedAt?.toISOString() ?? null })),
      computers: devices,
      credits: usage,
    };
  });

  /** Messages a person may see, by id: deep links from notifications and the CLI. */
  app.get("/api/node/messages/:id", async (request) => {
    const accountId = nodeAccount(request);
    const message = await prisma.nodeMessage.findUnique({ where: { id: (request.params as { id: string }).id } });
    const me = message ? await personIn(prisma, message.roomId, accountId) : null;
    const room = me ? await prisma.nodeRoom.findUnique({ where: { id: message!.roomId }, select: { kind: true } }) : null;
    const seen = room && message && Object.keys(joinedFilter(room.kind, me!.joinedAt)).length ? message.createdAt >= me!.joinedAt : true;
    if (!message || !canSee(message, accountId) || !me || !seen) throw fail(404, "That message is not available.");
    return { message: wireMessage(message) };
  });
}
