/**
 * Ensemble Node's HTTP surface (docs/35 §10, docs/02). Every route acts for the signed-in
 * account (sharing class `personal`), whichever space is open; messages are read through
 * visibility, and only a room's people reach it.
 */
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { NodeAgent, NodeRoom, Prisma, PrismaClient } from "@prisma/client";
import { accountIdOf } from "../lib/auth.js";
import { isHosted, requireVerifiedUser } from "../lib/hosted-access.js";
import { stripLoneSurrogates, truncateText } from "../lib/text.js";
import { isVisitor } from "../sharing/context.js";
import { includedUsage } from "../included/budget.js";
import { deviceOnline } from "../devices/constants.js";
import { abortAssistantTurn } from "../assistant/agent.js";
import { ApprovalError, settleApproval } from "./approvals.js";
import { nodeEventStream, publishTo } from "./events.js";
import { NODE_DEFAULT_MODEL, nodeModelOptions } from "./model.js";
import { dispatchMessage, inBackground, stopTurns } from "./queue.js";
import {
  addNode,
  addPerson,
  canSee,
  createNode,
  mentionsFor,
  personIn,
  postMessage,
  publicNode,
  roomPeople,
  roomSettings,
  visibleWhere,
  wireMessage,
  wireNode,
} from "./store.js";
import { CREW_TEMPLATES, NODE_TEMPLATES, crewTemplate, nodeTemplate } from "./templates.js";

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
const ModelPick = z.string().max(80).nullable();

function checkModel(model: string | null | undefined): void {
  if (!model) return;
  if (!nodeModelOptions().some((row) => row.model === model)) throw fail(400, `“${model}” is not available for nodes on this server.`);
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
  const who = await names(prisma, members.map((row) => row.userId));
  const settings = roomSettings(room);
  return {
    id: room.id,
    kind: room.kind,
    title: room.title,
    createdBy: room.userId,
    lastSeq: room.lastSeq,
    lastMessageAt: room.lastMessageAt?.toISOString() ?? null,
    leadNodeIds: settings.leadNodeIds,
    members: members.map((row) =>
      row.nodeId && row.node
        ? { id: row.id, kind: "node" as const, handle: row.handle, accountId: row.userId, representative: row.representative, node: row.userId === accountId ? wireNode(row.node) : publicNode(row.node) }
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
        prisma.nodeMessage.findFirst({ where: { roomId: row.roomId, ...visibleWhere(accountId) }, orderBy: { seq: "desc" } }),
        prisma.nodeMessage.count({ where: { roomId: row.roomId, seq: { gt: row.readSeq }, ...visibleWhere(accountId), NOT: { authorKind: "human", userId: accountId } } }),
        roomView(prisma, accountId, row.room),
      ]);
      return { ...view, unread, readSeq: row.readSeq, last: last ? { ...wireMessage(last), body: truncateText(last.body, 200) } : null };
    }),
  );
  return list.sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
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
    where: { kind: "approval", userId: accountId, visibleTo: { equals: [accountId] }, data: { path: ["status"], equals: "pending" } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return rows.map(wireMessage);
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
  const [nodes, rooms, approvals, runs, turns] = await Promise.all([
    prisma.nodeAgent.findMany({ where: { userId: accountId }, orderBy: { createdAt: "asc" } }),
    roomList(prisma, accountId),
    pendingApprovals(prisma, accountId),
    runList(prisma, accountId, 10),
    prisma.nodeTurn.findMany({ where: { userId: accountId }, orderBy: { createdAt: "desc" }, take: 10 }),
  ]);
  return {
    nodes: nodes.map((node) => ({ id: node.id, slug: node.slug, name: node.name, role: node.role, status: node.status, busy: turns.some((turn) => turn.nodeId === node.id && (turn.status === "running" || turn.status === "queued")) })),
    rooms: rooms.map((room) => ({ id: room.id, kind: room.kind, title: room.title, unread: room.unread, lastMessageAt: room.lastMessageAt, last: room.last ? { author: room.last.authorKind, body: room.last.body } : null })),
    approvals: approvals.map((row) => ({ id: row.id, roomId: row.roomId, body: truncateText(row.body, 200) })),
    runs,
    credits: await credits(accountId),
  };
}

const RoomKind = z.enum(["crew", "group"]);

export async function nodeRoutes(app: FastifyInstance): Promise<void> {
  const prisma = app.prisma;

  app.get("/api/node/bootstrap", async (request) => {
    const accountId = nodeAccount(request);
    const [user, nodes, rooms, devices, usage] = await Promise.all([
      prisma.user.findUnique({ where: { id: accountId }, select: { id: true, name: true, email: true, emailVerifiedAt: true } }),
      prisma.nodeAgent.findMany({ where: { userId: accountId }, orderBy: { createdAt: "asc" } }),
      roomList(prisma, accountId),
      computers(prisma, accountId),
      credits(accountId),
    ]);
    if (!user) throw fail(404, "Account not found.");
    return {
      // `verified`: may talk to nodes. Only the hosted server asks for a verified email.
      me: { id: user.id, name: user.name, email: user.email, verified: Boolean(user.emailVerifiedAt) || !isHosted() },
      nodes: nodes.map(wireNode),
      rooms,
      computers: devices,
      credits: usage,
      models: { default: NODE_DEFAULT_MODEL, options: nodeModelOptions() },
      templates: { nodes: NODE_TEMPLATES, crews: CREW_TEMPLATES },
    };
  });

  app.get("/api/node/events", async (request, reply) => nodeEventStream(request, reply, nodeAccount(request)));

  // ── nodes ────────────────────────────────────────────────────────────────────────────────
  app.get("/api/node/nodes", async (request) => {
    const accountId = nodeAccount(request);
    const nodes = await prisma.nodeAgent.findMany({ where: { userId: accountId }, orderBy: { createdAt: "asc" } });
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
      model: ModelPick.optional(),
    }).strict().parse(request.body ?? {});
    if (body.templateId && !nodeTemplate(body.templateId)) throw fail(400, "Unknown node template.");
    checkModel(body.model);
    if ((await prisma.nodeAgent.count({ where: { userId: accountId } })) >= 24) throw fail(409, "You have 24 nodes, the most one account can have.");
    const { node, room } = await createNode(prisma, accountId, { ...body, provider: body.model ? "ensemble" : null });
    publishTo([accountId], "node.room", { roomId: room.id });
    return reply.code(201).send({ node: wireNode(node), room: await roomView(prisma, accountId, room) });
  });

  app.patch("/api/node/nodes/:id", async (request) => {
    const accountId = nodeAccount(request);
    const node = await ownNode(prisma, accountId, (request.params as { id: string }).id);
    const body = z.object({
      name: z.string().min(1).max(60).optional(),
      role: z.string().min(1).max(40).optional(),
      charter: z.string().max(8000).optional(),
      avatar: Avatar.optional(),
      model: ModelPick.optional(),
      runProfileId: z.string().max(60).nullable().optional(),
      autonomy: z.object({ sharedRooms: z.enum(["ask", "auto"]) }).optional(),
      status: z.enum(["active", "paused"]).optional(),
    }).strict().parse(request.body ?? {});
    checkModel(body.model);
    const updated = await prisma.nodeAgent.update({
      where: { id: node.id },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.charter !== undefined ? { charter: body.charter } : {}),
        ...(body.avatar ? { avatar: body.avatar } : {}),
        ...(body.model !== undefined ? { model: body.model, provider: body.model ? "ensemble" : null } : {}),
        ...(body.runProfileId !== undefined ? { runProfileId: body.runProfileId } : {}),
        ...(body.autonomy ? { autonomy: body.autonomy } : {}),
        ...(body.status ? { status: body.status } : {}),
      },
    });
    return { node: wireNode(updated) };
  });

  app.delete("/api/node/nodes/:id", async (request, reply) => {
    const accountId = nodeAccount(request);
    const node = await ownNode(prisma, accountId, (request.params as { id: string }).id);
    const memberships = await prisma.nodeRoomMember.findMany({ where: { nodeId: node.id }, include: { room: true } });
    const conversations = memberships.flatMap((row) => [row.conversationId, row.privateConversationId]).filter((id): id is string => Boolean(id));
    const dms = memberships.filter((row) => row.room.kind === "dm" && row.room.userId === accountId).map((row) => row.roomId);
    await stopTurns(app, [node.id], null);
    await prisma.$transaction([
      prisma.nodeRoom.deleteMany({ where: { id: { in: dms } } }),
      prisma.nodeAgent.delete({ where: { id: node.id } }),
      prisma.nodeRun.deleteMany({ where: { nodeId: node.id } }),
      prisma.assistantConversation.deleteMany({ where: { id: { in: conversations }, userId: accountId, startedOn: "node" } }),
    ]);
    publishTo([accountId], "node.room", { deleted: dms });
    return reply.code(204).send();
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
  app.post("/api/node/crews", async (request, reply) => {
    const accountId = nodeAccount(request);
    const body = z.object({ templateId: z.string().max(40), title: z.string().min(1).max(80).optional() }).strict().parse(request.body);
    const template = crewTemplate(body.templateId);
    if (!template) throw fail(400, "Unknown crew template.");
    const nodes: NodeAgent[] = [];
    for (const id of template.nodes) {
      const existing = await prisma.nodeAgent.findFirst({ where: { userId: accountId, templateId: id }, orderBy: { createdAt: "asc" } });
      nodes.push(existing ?? (await createNode(prisma, accountId, { templateId: id })).node);
    }
    const lead = nodes[template.nodes.indexOf(template.lead)]!;
    const room = await prisma.$transaction(async (tx) => {
      const created = await tx.nodeRoom.create({ data: { userId: accountId, kind: "crew", title: body.title ?? template.title, settings: { leadNodeIds: [lead.id] } } });
      await addPerson(tx, created.id, accountId, "owner");
      for (const node of nodes) await addNode(tx, created.id, node);
      return created;
    });
    publishTo([accountId], "node.room", { roomId: room.id });
    return reply.code(201).send({ room: await roomView(prisma, accountId, room), nodes: nodes.map(wireNode) });
  });

  app.get("/api/node/rooms", async (request) => ({ rooms: await roomList(prisma, nodeAccount(request)) }));

  app.post("/api/node/rooms", async (request, reply) => {
    const accountId = nodeAccount(request);
    const body = z.object({
      kind: RoomKind,
      title: z.string().min(1).max(80),
      nodeIds: z.array(z.string().uuid()).max(12).default([]),
      representativeId: z.string().uuid().optional(),
    }).strict().parse(request.body);
    const nodes = await prisma.nodeAgent.findMany({ where: { id: { in: body.nodeIds }, userId: accountId } });
    if (nodes.length !== new Set(body.nodeIds).size) throw fail(404, "That node is not available.");
    const lead = body.representativeId ?? nodes.find((node) => node.role === "manager")?.id ?? nodes[0]?.id;
    const room = await prisma.$transaction(async (tx) => {
      const created = await tx.nodeRoom.create({ data: { userId: accountId, kind: body.kind, title: body.title.trim(), settings: body.kind === "crew" && lead ? { leadNodeIds: [lead] } : {} } });
      await addPerson(tx, created.id, accountId, "owner");
      for (const node of nodes) await addNode(tx, created.id, node, body.kind === "group" && node.id === lead);
      return created;
    });
    publishTo([accountId], "node.room", { roomId: room.id });
    return reply.code(201).send({ room: await roomView(prisma, accountId, room) });
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
      data: { ...(body.title ? { title: body.title.trim() } : {}), settings: settings as Prisma.InputJsonValue },
    });
    publishTo(await roomPeople(prisma, room.id), "node.room", { roomId: room.id });
    return { room: await roomView(prisma, accountId, updated) };
  });

  app.delete("/api/node/rooms/:id", async (request, reply) => {
    const accountId = nodeAccount(request);
    const room = await roomFor(prisma, accountId, (request.params as { id: string }).id);
    if (room.userId !== accountId) throw fail(403, "Only the person who made this room can delete it. You can leave it.");
    const people = await roomPeople(prisma, room.id);
    await prisma.nodeRoom.update({ where: { id: room.id }, data: { archivedAt: new Date() } });
    publishTo(people, "node.room", { deleted: [room.id] });
    return reply.code(204).send();
  });

  app.post("/api/node/rooms/:id/people", async (request, reply) => {
    const accountId = nodeAccount(request);
    const room = await roomFor(prisma, accountId, (request.params as { id: string }).id);
    if (room.kind !== "group") throw fail(400, "Only group rooms have other people. Make a group room to invite someone.");
    const body = z.object({ email: z.string().email().max(320) }).strict().parse(request.body);
    const person = await prisma.user.findFirst({ where: { email: { equals: body.email.trim(), mode: "insensitive" } }, select: { id: true } });
    if (!person) throw fail(404, "No Ensemble account uses that email yet. Ask them to sign in to Ensemble Node first.");
    if ((await prisma.nodeRoomMember.count({ where: { roomId: room.id, nodeId: null } })) >= 20) throw fail(409, "A room holds at most 20 people.");
    const member = await addPerson(prisma, room.id, person.id);
    const who = await names(prisma, [accountId, person.id]);
    await postMessage(prisma, { roomId: room.id, userId: accountId, authorKind: "system", kind: "status", body: `${who.get(accountId)?.name ?? "Someone"} added ${who.get(person.id)?.name ?? "someone"}.` });
    publishTo(await roomPeople(prisma, room.id), "node.room", { roomId: room.id });
    return reply.code(201).send({ member: { id: member.id, handle: member.handle } });
  });

  app.post("/api/node/rooms/:id/nodes", async (request, reply) => {
    const accountId = nodeAccount(request);
    const room = await roomFor(prisma, accountId, (request.params as { id: string }).id);
    if (room.kind === "dm") throw fail(400, "A direct chat has one node. Make a crew or group room for more.");
    const body = z.object({ nodeId: z.string().uuid(), representative: z.boolean().optional() }).strict().parse(request.body);
    const node = await ownNode(prisma, accountId, body.nodeId);
    if ((await prisma.nodeRoomMember.count({ where: { roomId: room.id, nodeId: { not: null } } })) >= 24) throw fail(409, "A room holds at most 24 nodes.");
    const member = await addNode(prisma, room.id, node, body.representative ?? room.kind === "group");
    await postMessage(prisma, { roomId: room.id, userId: accountId, authorKind: "system", kind: "status", body: `@${member.handle} joined.` });
    publishTo(await roomPeople(prisma, room.id), "node.room", { roomId: room.id });
    return reply.code(201).send({ member: { id: member.id, handle: member.handle } });
  });

  app.delete("/api/node/rooms/:id/members/:memberId", async (request, reply) => {
    const accountId = nodeAccount(request);
    const { id, memberId } = request.params as { id: string; memberId: string };
    const room = await roomFor(prisma, accountId, id);
    const member = await prisma.nodeRoomMember.findFirst({ where: { id: memberId, roomId: room.id } });
    if (!member) throw fail(404, "That member is not in this room.");
    if (member.userId !== accountId && room.userId !== accountId) throw fail(403, "You can remove yourself and your own nodes.");
    if (!member.nodeId && member.userId === room.userId) throw fail(400, "The person who made a room cannot leave it. Delete the room instead.");
    const people = await roomPeople(prisma, room.id);
    // A person who leaves takes their nodes along.
    await prisma.nodeRoomMember.deleteMany({ where: member.nodeId ? { id: member.id } : { roomId: room.id, userId: member.userId } });
    if (member.nodeId) await stopTurns(app, [member.nodeId], room.id);
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
    }).parse(request.query ?? {});
    const rows = await prisma.nodeMessage.findMany({
      where: {
        roomId: room.id,
        ...visibleWhere(accountId),
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
      body: z.string().min(1).max(8000),
      clientId: z.string().min(1).max(80).optional(),
      private: z.boolean().optional(),
    }).strict().parse(request.body);
    const text = stripLoneSurrogates(body.body).trim();
    if (!text) throw fail(400, "That message is empty.");
    // Nodes spend model credits on the account's behalf: same rule as the assistant.
    await requireVerifiedUser(accountId);
    const members = await prisma.nodeRoomMember.findMany({ where: { roomId: room.id } });
    const visibleTo = body.private ? [accountId] : [];
    const { message, duplicate } = await postMessage(prisma, {
      roomId: room.id,
      userId: accountId,
      authorKind: "human",
      body: text,
      visibleTo,
      mentions: mentionsFor(text, members, visibleTo),
      clientId: body.clientId ?? null,
    });
    if (!duplicate) inBackground(app, () => dispatchMessage(app, message));
    return reply.code(duplicate ? 200 : 201).send({ message: wireMessage(message), duplicate });
  });

  app.post("/api/node/rooms/:id/read", async (request, reply) => {
    const accountId = nodeAccount(request);
    const room = await roomFor(prisma, accountId, (request.params as { id: string }).id);
    const body = z.object({ seq: z.number().int().min(0) }).strict().parse(request.body);
    await prisma.nodeRoomMember.updateMany({ where: { roomId: room.id, userId: accountId, nodeId: null, readSeq: { lt: body.seq } }, data: { readSeq: Math.min(body.seq, room.lastSeq) } });
    return reply.code(204).send();
  });

  app.post("/api/node/rooms/:id/stop", async (request) => {
    const accountId = nodeAccount(request);
    const room = await roomFor(prisma, accountId, (request.params as { id: string }).id);
    const mine = await prisma.nodeRoomMember.findMany({ where: { roomId: room.id, userId: accountId, nodeId: { not: null } } });
    for (const member of mine) {
      for (const conversationId of [member.conversationId, member.privateConversationId]) if (conversationId) abortAssistantTurn(conversationId);
    }
    return { stopped: await stopTurns(app, mine.map((row) => row.nodeId!), room.id) };
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
      if (error instanceof ApprovalError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.get("/api/node/runs", async (request) => ({ runs: await runList(prisma, nodeAccount(request)) }));

  app.get("/api/node/activity", async (request) => {
    const accountId = nodeAccount(request);
    const [approvals, runs, turns, devices, usage] = await Promise.all([
      pendingApprovals(prisma, accountId),
      runList(prisma, accountId, 20),
      prisma.nodeTurn.findMany({ where: { userId: accountId }, orderBy: { createdAt: "desc" }, take: 30 }),
      computers(prisma, accountId),
      credits(accountId),
    ]);
    return {
      approvals,
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
    if (!message || !canSee(message, accountId) || !(await personIn(prisma, message.roomId, accountId))) throw fail(404, "That message is not available.");
    return { message: wireMessage(message) };
  });
}
