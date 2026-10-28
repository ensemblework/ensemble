/**
 * Nodes that make nodes (docs/35 §6.1). A node is the one its owner talks to; it can bring in:
 *
 *  - a temporary **helper** (`node_helper`): a node made for one side task (an independent audit, a
 *    second opinion, a parallel investigation). It works in its own **task room** with the node that
 *    made it; the owner reads along but does not write there, and the helper never talks to the owner:
 *    it reports to its parent, which tells the owner. Helpers only read (no writes, no computer work).
 *    A task room and its helper go once the room has been quiet for `HELPER_IDLE_MS`.
 *  - a lasting node (`node_create`) or a crew of the owner's nodes (`node_create_group`), as the owner
 *    asks: the same as making them on the website.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { NodeAgent, NodeRoom, Prisma, PrismaClient } from "@prisma/client";
import { defineTool, toolOk, ToolBlockedError, type AnyHubTool } from "../assistant/types.js";
import { publishTo } from "./events.js";
import { handleFrom, uniqueHandle } from "./mentions.js";
import { stopTurns } from "./queue.js";
import { addNode, addPerson, createNode, freeRoomTitle, nodeNameTaken, numbered, roomTitleTaken } from "./store.js";
import { NODE_TEMPLATES } from "./templates.js";
import type { SessionToolScope } from "./sessions.js";

export const HELPER_IDLE_MS = 3 * 86_400_000;
/** Helpers working at once (a turn going on, or their room active in the last `WORKING_MS`). */
export const MAX_HELPERS_PER_NODE = 4;
export const MAX_HELPERS = 8;
const WORKING_MS = 10 * 60_000;
/** Finished helpers kept per node for their owner to read; past this the quietest go first. */
const KEEP_HELPERS = 12;
/** Lasting nodes per account; helpers do not count. */
export const MAX_NODES = 24;

export type HelperScope = SessionToolScope & { dispatch: (message: import("@prisma/client").NodeMessage) => Promise<void>; postBrief: (room: NodeRoom, body: string) => Promise<unknown> };

const Handle = z.string().min(1).max(60).transform((value) => value.trim().replace(/^@/, "").toLowerCase());

/** Removes a node with its direct chat or task room, its runs and its conversations. */
export async function deleteNode(app: FastifyInstance, node: Pick<NodeAgent, "id" | "userId">): Promise<string[]> {
  await stopTurns(app, [node.id], null);
  return removeNodeRows(app.prisma, node);
}

/** The rows of a node with nothing going on (`deleteNode` stops its turns first). */
async function removeNodeRows(prisma: PrismaClient, node: Pick<NodeAgent, "id" | "userId">): Promise<string[]> {
  const memberships = await prisma.nodeRoomMember.findMany({ where: { nodeId: node.id }, include: { room: true } });
  const conversations = memberships.flatMap((row) => [row.conversationId, row.privateConversationId]).filter((id): id is string => Boolean(id));
  const own = memberships.filter((row) => (row.room.kind === "dm" || row.room.kind === "task") && row.room.userId === node.userId).map((row) => row.roomId);
  await prisma.$transaction([
    prisma.nodeRoom.deleteMany({ where: { id: { in: own } } }),
    prisma.nodeAgent.delete({ where: { id: node.id } }),
    prisma.nodeRun.deleteMany({ where: { nodeId: node.id } }),
    prisma.assistantConversation.deleteMany({ where: { id: { in: conversations }, userId: node.userId, startedOn: "node" } }),
  ]);
  publishTo([node.userId], "node.room", { deleted: own });
  return own;
}

/** Task rooms quiet for `HELPER_IDLE_MS` go, with their helpers. */
export async function sweepHelpers(app: FastifyInstance, now = Date.now()): Promise<number> {
  const prisma = app.prisma;
  const helpers = await prisma.nodeAgent.findMany({ where: { parentNodeId: { not: null } }, take: 200 });
  let removed = 0;
  for (const helper of helpers) {
    const rooms = await prisma.nodeRoom.findMany({ where: { kind: "task", archivedAt: null, members: { some: { nodeId: helper.id } } }, select: { lastMessageAt: true, createdAt: true } });
    const last = Math.max(0, ...rooms.map((room) => (room.lastMessageAt ?? room.createdAt).getTime()));
    const busy = await prisma.nodeTurn.count({ where: { nodeId: helper.id, status: { in: ["queued", "running"] } } });
    const parentGone = helper.parentNodeId ? !(await prisma.nodeAgent.findUnique({ where: { id: helper.parentNodeId }, select: { id: true } })) : false;
    if ((parentGone || now - last > HELPER_IDLE_MS) && !busy) {
      await deleteNode(app, helper);
      removed += 1;
    }
  }
  return removed;
}

type HelperState = { helper: NodeAgent; lastActive: number; busy: boolean };

/** Helpers with when their room last moved and whether a turn of theirs is going on. */
async function helperStates(prisma: PrismaClient, where: Prisma.NodeAgentWhereInput): Promise<HelperState[]> {
  const helpers = await prisma.nodeAgent.findMany({ where: { ...where, parentNodeId: { not: null } } });
  if (!helpers.length) return [];
  const ids = helpers.map((row) => row.id);
  const [rooms, turns] = await Promise.all([
    prisma.nodeRoomMember.findMany({ where: { nodeId: { in: ids }, room: { kind: "task" } }, select: { nodeId: true, room: { select: { lastMessageAt: true, createdAt: true } } } }),
    prisma.nodeTurn.findMany({ where: { nodeId: { in: ids }, status: { in: ["queued", "running"] } }, select: { nodeId: true } }),
  ]);
  return helpers.map((helper) => {
    const room = rooms.find((row) => row.nodeId === helper.id)?.room;
    return { helper, lastActive: (room?.lastMessageAt ?? room?.createdAt ?? helper.createdAt).getTime(), busy: turns.some((row) => row.nodeId === helper.id) };
  });
}

const working = (state: HelperState, now: number) => state.busy || now - state.lastActive < WORKING_MS;

/** A crew of the owner's nodes with one lead; the same as making it on the website. */
export async function createCrew(prisma: PrismaClient, accountId: string, title: string, nodes: NodeAgent[], lead: NodeAgent): Promise<NodeRoom> {
  return prisma.$transaction(async (tx) => {
    const created = await tx.nodeRoom.create({ data: { userId: accountId, kind: "crew", title, settings: { leadNodeIds: [lead.id] } } });
    await addPerson(tx, created.id, accountId, "owner");
    for (const node of nodes) await addNode(tx, created.id, node);
    return created;
  });
}

/** The helper's charter: the one task, and the rules a helper keeps. */
function helperCharter(parent: NodeAgent, task: string): string {
  return [
    `You are a temporary helper of @${parent.slug} (${parent.name}), made for one task:`,
    task,
    "",
    `- Only @${parent.slug} instructs you. Your owner reads this room but does not write here; you never address them.`,
    "- Do the task with the Ensemble tools you have: search the workspace and the web, read pages, tasks, files and connected apps. You do not change anything and do not run work on a computer.",
    `- Be independent: check claims yourself rather than trusting what you were told. Reply with what you found, with sources, and mention @${parent.slug} so it hears you.`,
  ].join("\n");
}

export function helperTools(scope: HelperScope): AnyHubTool[] {
  const { prisma, node } = scope;
  if (scope.lineage.fromNonOwner || node.parentNodeId) return [];
  const owner = node.userId;
  return [
    defineTool({
      name: "node_helper",
      area: "tasks",
      description:
        "Bring in a temporary helper node for one side task that should not be you: an independent audit or second opinion, a parallel investigation, a check of your own work. " +
        "It works in its own room with you, which your owner can read but not write in; it only reads (workspace, web, connected apps), never changes anything or runs work on the computer, and reports back to you by mention. " +
        "You then tell your owner what it found. The room and helper go after 3 quiet days. Do quick work yourself instead; coding goes to an agent session.",
      input: z
        .object({
          task: z.string().min(1).max(4000).describe("The self-contained task: what to look at, what to check, what to report back."),
          name: z.string().min(1).max(40).optional().describe("A short name for the helper, for example Auditor or Fact-checker."),
          role: z.string().min(1).max(40).optional().describe("Its role in a word or two, for example auditor."),
        })
        .strict(),
      isWrite: false,
      risk: "low",
      async run(_ctx, input) {
        const now = Date.now();
        const all = await helperStates(prisma, { userId: owner });
        const mine = all.filter((row) => row.helper.parentNodeId === node.id);
        if (mine.filter((row) => working(row, now)).length >= MAX_HELPERS_PER_NODE) {
          throw new ToolBlockedError(`You already have ${MAX_HELPERS_PER_NODE} helpers working.`, "Wait until one has reported, give one of them this task with node_delegate, or do it yourself.");
        }
        if (all.filter((row) => working(row, now)).length >= MAX_HELPERS) throw new ToolBlockedError(`Your owner has ${MAX_HELPERS} helpers working, the most at once.`, "Wait until one has reported, or do this yourself.");
        // Finished helpers stay for their owner to read; the quietest go once there are too many.
        const idle = mine.filter((row) => !row.busy).sort((a, b) => a.lastActive - b.lastActive);
        for (const old of idle.slice(0, Math.max(0, mine.length - KEEP_HELPERS + 1))) {
          await removeNodeRows(prisma, old.helper);
        }
        const existing = await prisma.nodeAgent.findMany({ where: { userId: owner }, select: { slug: true, name: true } });
        const name = numbered(input.name?.trim() || "Helper", new Set(existing.map((row) => row.name.trim().toLowerCase())), 60);
        const slug = uniqueHandle(handleFrom(`${node.slug}-${input.name?.trim() || "helper"}`), new Set(existing.map((row) => row.slug)));
        const avatar = (node.avatar && typeof node.avatar === "object" ? node.avatar : {}) as Record<string, unknown>;
        const { helper, room } = await prisma.$transaction(async (tx) => {
          const helper = await tx.nodeAgent.create({
            data: {
              userId: owner,
              slug,
              name,
              role: (input.role?.trim() || "helper").slice(0, 40),
              charter: helperCharter(node, input.task),
              avatar: { shape: avatar.shape ?? "orb", color: "#9AA5B1", eyes: avatar.eyes === "wide" ? "dot" : "wide" } as Prisma.InputJsonValue,
              provider: node.provider,
              model: node.model,
              effort: "low",
              parentNodeId: node.id,
              autonomy: { sharedRooms: "ask" },
            },
          });
          const title = await freeRoomTitle(tx, owner, `${node.name} · ${name}`);
          // Where the node reports what its helper found: the thread it was asked in, private if that was.
          const settings = { leadNodeIds: [node.id], parentNodeId: node.id, helperNodeId: helper.id, originRoomId: scope.room.id, originPrivateTo: scope.privateTo };
          const room = await tx.nodeRoom.create({ data: { userId: owner, kind: "task", title, settings: settings as Prisma.InputJsonValue } });
          await addPerson(tx, room.id, owner, "member");
          await addNode(tx, room.id, node);
          await addNode(tx, room.id, helper);
          return { helper, room };
        });
        publishTo([owner], "node.room", { roomId: room.id });
        await scope.postBrief(room, `@${helper.slug} ${input.task}`);
        return toolOk(`@${helper.slug} is on it in “${room.title}”; it reports back to you there. Tell your owner in a line, then wait.`, { helper: helper.slug, room: room.title });
      },
    }),
    defineTool({
      name: "node_create",
      area: "tasks",
      description:
        "Make a lasting node for your owner, when they ask for one (“make a node that tracks our releases”): it gets its own chat in their sidebar and works like any of their nodes. Give it a clear charter. Then hand it work with node_delegate.",
      input: z
        .object({
          name: z.string().min(1).max(60),
          role: z.string().min(1).max(40).describe("A word or two, for example researcher."),
          charter: z.string().min(1).max(8000).describe("Its standing instructions: what it is for, how it works, what it reports."),
          templateId: z.enum(NODE_TEMPLATES.map((row) => row.id) as [string, ...string[]]).optional().describe("A template to start from: its look and handle."),
        })
        .strict(),
      isWrite: false,
      risk: "low",
      async run(_ctx, input) {
        if (!scope.ownerOnly) throw new ToolBlockedError("Only in a chat with just your owner can you make them a node.");
        if (await nodeNameTaken(prisma, owner, input.name)) throw new ToolBlockedError(`Your owner already has a node called “${input.name.trim()}”.`, "Pick another name.");
        if ((await prisma.nodeAgent.count({ where: { userId: owner, parentNodeId: null } })) >= MAX_NODES) throw new ToolBlockedError(`Your owner has ${MAX_NODES} nodes, the most one account can have.`);
        const { node: made, room } = await createNode(prisma, owner, { templateId: input.templateId, name: input.name.trim(), role: input.role.trim(), charter: input.charter, provider: node.provider, model: node.model });
        publishTo([owner], "node.room", { roomId: room.id });
        return toolOk(`Made @${made.slug} (${made.name}); its chat is in your owner's sidebar. Hand it work with node_delegate.`, { handle: made.slug, name: made.name });
      },
    }),
    defineTool({
      name: "node_create_group",
      area: "tasks",
      description: "Make a crew (a group chat of your owner and some of their nodes, one of them its lead), when your owner asks for one. Include yourself if you should be in it.",
      input: z
        .object({
          title: z.string().min(1).max(80),
          members: z.array(Handle).min(1).max(24).describe("The nodes' handles, for example [\"manager\", \"tester\"]."),
          lead: Handle.optional().describe("The handle of the node that answers when nobody is mentioned."),
        })
        .strict(),
      isWrite: false,
      risk: "low",
      async run(_ctx, input) {
        if (!scope.ownerOnly) throw new ToolBlockedError("Only in a chat with just your owner can you make them a group.");
        const title = input.title.trim();
        if (await roomTitleTaken(prisma, owner, title)) throw new ToolBlockedError(`Your owner already has a crew or room called “${title}”.`, "Pick another name.");
        const nodes = await prisma.nodeAgent.findMany({ where: { userId: owner, parentNodeId: null, slug: { in: [...new Set(input.members)] } } });
        const missing = [...new Set(input.members)].filter((slug) => !nodes.some((row) => row.slug === slug));
        if (missing.length) throw new ToolBlockedError(`Your owner has no node ${missing.map((slug) => `@${slug}`).join(", ")}.`, "Use their nodes' handles, or make the node first (node_create).");
        const lead = nodes.find((row) => row.slug === input.lead) ?? nodes.find((row) => row.role === "manager") ?? nodes[0]!;
        const room = await createCrew(prisma, owner, title, nodes, lead);
        publishTo([owner], "node.room", { roomId: room.id });
        return toolOk(`Made the crew “${room.title}” with ${nodes.map((row) => `@${row.slug}`).join(", ")}; @${lead.slug} leads.`, { room: room.id });
      },
    }),
  ];
}
