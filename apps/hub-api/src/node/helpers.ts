/**
 * Nodes that make nodes (docs/35 §6.1). A node is the one its owner talks to; it can bring in:
 *
 *  - a temporary **helper** (`node_helper`): a node made for one side task (an independent audit, a
 *    second opinion, a parallel investigation). Its task is a step of its parent's plan for that turn,
 *    so helpers brought in together report once, through their parent. Its **task room** is the thread
 *    the owner reads (the brief and what it reported); nobody writes there. Helpers read by default; a
 *    parent can grant one sessions or computer tools. A task room and its helper go once the room has
 *    been quiet for `HELPER_IDLE_MS`.
 *  - a lasting node (`node_create`) or a crew of the owner's nodes (`node_create_group`), as the owner
 *    asks: proposed on a card unless the owner lets the node make them without asking.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { NodeAgent, NodeRoom, Prisma, PrismaClient } from "@prisma/client";
import { defineTool, toolOk, ToolBlockedError, type AnyHubTool } from "../assistant/types.js";
import { publishTo } from "./events.js";
import { handleFrom, uniqueHandle } from "./mentions.js";
import { stopTurns } from "./queue.js";
import { addStep, planVisibility, stopPlans } from "./plans.js";
import { addNode, addPerson, createNode, freeRoomTitle, nodeNameTaken, numbered, postMessage, roomTitleTaken } from "./store.js";
import { NODE_TEMPLATES } from "./templates.js";
import type { SessionToolScope } from "./sessions.js";

export const HELPER_IDLE_MS = 3 * 86_400_000;
/** Helpers working at once by default (a turn going on, or their room active in the last `WORKING_MS`): the owner's `autonomy.helpers`. */
export const MAX_HELPERS_PER_NODE = 4;
export const MAX_HELPERS = 8;
const WORKING_MS = 10 * 60_000;
/** Finished helpers kept per node for their owner to read; past this the quietest go first. */
const KEEP_HELPERS = 12;
/** Lasting nodes per account; helpers do not count. */
export const MAX_NODES = 24;

export type HelperScope = SessionToolScope & { dispatch: (message: import("@prisma/client").NodeMessage) => Promise<void>; turnId: string };

/**
 * Helpers a node may have working at once, as its owner set (`autonomy.helpers`, 0 for no limit), and
 * for the whole account twice that (the defaults: 4 and 8).
 */
export function helperLimits(node: Pick<NodeAgent, "autonomy">): { perNode: number; perAccount: number } {
  const raw = (node.autonomy as { helpers?: unknown } | null)?.helpers;
  const perNode = typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : MAX_HELPERS_PER_NODE;
  return perNode === 0 ? { perNode: Infinity, perAccount: Infinity } : { perNode, perAccount: Math.max(MAX_HELPERS, perNode * 2) };
}

/** Whether the owner lets this node make nodes and crews without asking (`autonomy.createNodes: "auto"`). */
export function createsWithoutAsking(node: Pick<NodeAgent, "autonomy">): boolean {
  return (node.autonomy as { createNodes?: unknown } | null)?.createNodes === "auto";
}

/** A helper's task room: its thread. */
export async function helperRoomOf(prisma: PrismaClient, helperId: string): Promise<NodeRoom | null> {
  return prisma.nodeRoom.findFirst({ where: { kind: "task", archivedAt: null, members: { some: { nodeId: helperId } } } });
}

/** The folders a helper with a computer grant may use; empty: the same as its parent. */
export function helperFolders(node: Pick<NodeAgent, "autonomy">): string[] {
  const folders = (node.autonomy as { folders?: unknown } | null)?.folders;
  return Array.isArray(folders) ? folders.filter((value): value is string => typeof value === "string" && value.trim().length > 0) : [];
}

const Handle = z.string().min(1).max(60).transform((value) => value.trim().replace(/^@/, "").toLowerCase());

/** Removes a node with its direct chat or task room, its runs and its conversations. */
export async function deleteNode(app: FastifyInstance, node: Pick<NodeAgent, "id" | "userId">): Promise<string[]> {
  await stopTurns(app, [node.id], null);
  await stopPlans(app, { nodeId: node.id, userId: node.userId });
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

/** What a helper may do, as its parent granted (never more than the parent itself may do). */
export type HelperGrant = "read" | "sessions" | "computer";

export function helperGrant(node: Pick<NodeAgent, "autonomy" | "parentNodeId">): HelperGrant | null {
  if (!node.parentNodeId) return null;
  const grant = (node.autonomy as { grant?: unknown } | null)?.grant;
  return grant === "sessions" || grant === "computer" ? grant : "read";
}

/** The helper's charter: the one task, and the rules a helper keeps. */
function helperCharter(parent: NodeAgent, task: string, grant: HelperGrant = "read"): string {
  return [
    `You are a temporary helper of @${parent.slug} (${parent.name}), made for one task:`,
    task,
    "",
    `- Only @${parent.slug} instructs you. Your owner reads this room but does not write here; you never address them.`,
    grant === "sessions"
      ? "- Do the task with the Ensemble tools you have, and run the work on your owner's computer in one agent session of your own (node_session_start, then node_session_send for the same line of work). You do not change the Ensemble workspace."
      : grant === "computer"
        ? "- Do the task with the Ensemble tools you have, and check things on your owner's computer with your computer tools, in the folders you were given. You do not change the Ensemble workspace."
        : "- Do the task with the Ensemble tools you have: search the workspace and the web, read pages, tasks, files and connected apps. You do not change anything and do not run work on a computer.",
    `- Be independent: check claims yourself rather than trusting what you were told. Report what you found with node_step_report (a summary with sources, and what you could not check); @${parent.slug} hears it with its plan.`,
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
        "Its task is a step of your plan for this turn: bring in several at once for parallel work, and you hear once, with every result, when they have all reported; then tell your owner. " +
        "Your owner reads its thread (the brief and its report). By default it only reads (workspace, web, connected apps); can gives it more. The thread and helper go after 3 quiet days. Do quick work yourself instead; coding goes to an agent session.",
      input: z
        .object({
          task: z.string().min(1).max(4000).describe("The self-contained task: what to look at, what to check, what to report back."),
          name: z.string().min(1).max(40).optional().describe("A short name for the helper, for example Auditor or Fact-checker."),
          role: z.string().min(1).max(40).optional().describe("Its role in a word or two, for example auditor."),
          can: z
            .enum(["read", "sessions", "computer"])
            .default("read")
            .describe("What it may do: read (default: workspace, web, connected apps), sessions (also run its own coding-agent session on your owner's computer), computer (also check things on the computer with computer tools)."),
          folders: z.array(z.string().min(1).max(300)).max(5).optional().describe("For computer: the folders it may use."),
        })
        .strict(),
      isWrite: false,
      risk: "low",
      async run(_ctx, input) {
        const now = Date.now();
        const limits = helperLimits(node);
        const all = await helperStates(prisma, { userId: owner });
        const mine = all.filter((row) => row.helper.parentNodeId === node.id);
        if (mine.filter((row) => working(row, now)).length >= limits.perNode) {
          throw new ToolBlockedError(`You already have ${limits.perNode} helpers working, as many as your owner set.`, "Wait until one has reported, give one of them this task with node_delegate, or do it yourself.");
        }
        if (all.filter((row) => working(row, now)).length >= limits.perAccount) throw new ToolBlockedError(`Your owner has ${limits.perAccount} helpers working, as many as they set.`, "Wait until one has reported, or do this yourself.");
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
              charter: helperCharter(node, input.task, input.can),
              avatar: { shape: avatar.shape ?? "orb", color: "#9AA5B1", eyes: avatar.eyes === "wide" ? "dot" : "wide" } as Prisma.InputJsonValue,
              provider: node.provider,
              model: node.model,
              effort: "low",
              parentNodeId: node.id,
              autonomy: { sharedRooms: "ask", grant: input.can, ...(input.folders?.length ? { folders: input.folders } : {}) },
            },
          });
          const title = await freeRoomTitle(tx, owner, `${node.name} · ${name}`);
          // Where the node reports what its helper found: the thread it was asked in, private if that was.
          const settings = { leadNodeIds: [node.id], parentNodeId: node.id, helperNodeId: helper.id, originRoomId: scope.room.id, originPrivateTo: scope.privateTo, originMessageId: scope.lineage.rootMessageId };
          const room = await tx.nodeRoom.create({ data: { userId: owner, kind: "task", title, settings: settings as Prisma.InputJsonValue } });
          await addPerson(tx, room.id, owner, "member");
          await addNode(tx, room.id, node);
          await addNode(tx, room.id, helper);
          return { helper, room };
        });
        publishTo([owner], "node.room", { roomId: room.id });
        // The brief opens its thread without waking anyone: the task runs as a step of this turn's plan.
        await postMessage(prisma, { roomId: room.id, userId: owner, authorKind: "node", authorNodeId: node.id, body: input.task, data: { brief: { helperNodeId: helper.id } } });
        const continuing = scope.plan && !scope.plan.planStep ? scope.plan.planId : null;
        const visibleTo = await planVisibility(prisma, owner, scope.room, scope.privateTo);
        const added = await addStep(prisma, {
          lead: node,
          turnId: scope.turnId,
          continuing,
          room: scope.room,
          originRoomId: scope.room.id,
          originPrivate: Boolean(scope.privateTo),
          visibleTo,
          step: { node: helper, handle: helper.slug, brief: input.task, after: [], kind: "research", executor: "helper" },
        });
        await prisma.nodeRoom.update({ where: { id: room.id }, data: { settings: { ...(room.settings as Prisma.JsonObject), planId: added.planId } } });
        publishTo([owner], "node.room", { roomId: room.id });
        return toolOk(
          `@${helper.slug} is on it${input.can === "read" ? "" : ` (it may ${input.can === "sessions" ? "run its own agent session" : "use computer tools"})`}. It starts when your turn ends; you hear once, with every helper's result, when they have all reported. Tell your owner in a line, then wait.`,
          { helper: helper.slug, room: room.title },
        );
      },
    }),
    defineTool({
      name: "node_create",
      area: "tasks",
      description:
        "Make a lasting node for your owner, when they ask for one (“make a node that tracks our releases”): it gets its own chat in their sidebar and works like any of their nodes. Give it a clear charter. " +
        "Unless your owner lets you make nodes without asking, they get a card to approve first. Then hand it work with node_delegate.",
      input: NewNode,
      isWrite: false,
      risk: "low",
      async run(_ctx, input) {
        if (!scope.ownerOnly) throw new ToolBlockedError("Only in a chat with just your owner can you make them a node.");
        await checkNewNode(prisma, owner, input);
        if (!createsWithoutAsking(node)) return propose(scope, { action: "node", input }, `Make a node: ${input.name.trim()} (${input.role.trim()})\n\n${input.charter.trim()}`);
        const made = await makeNode(prisma, node, input);
        return toolOk(`Made @${made.slug} (${made.name}); its chat is in your owner's sidebar. Hand it work with node_delegate.`, { handle: made.slug, name: made.name });
      },
    }),
    defineTool({
      name: "node_create_group",
      area: "tasks",
      description: "Make a crew (a group chat of your owner and some of their nodes, one of them its lead), when your owner asks for one. Include yourself if you should be in it.",
      input: NewCrew,
      isWrite: false,
      risk: "low",
      async run(_ctx, input) {
        if (!scope.ownerOnly) throw new ToolBlockedError("Only in a chat with just your owner can you make them a group.");
        const { nodes, lead } = await crewMembers(prisma, owner, input);
        if (!createsWithoutAsking(node)) {
          return propose(scope, { action: "crew", input }, `Make a crew: ${input.title.trim()}, with ${nodes.map((row) => `@${row.slug}`).join(", ")}; @${lead.slug} leads.`);
        }
        const room = await makeCrew(prisma, owner, input);
        return toolOk(`Made the crew “${room.title}” with ${nodes.map((row) => `@${row.slug}`).join(", ")}; @${lead.slug} leads.`, { room: room.id });
      },
    }),
  ];
}



export const NewNode = z
  .object({
    name: z.string().min(1).max(60),
    role: z.string().min(1).max(40).describe("A word or two, for example researcher."),
    charter: z.string().min(1).max(8000).describe("Its standing instructions: what it is for, how it works, what it reports."),
    templateId: z.enum(NODE_TEMPLATES.map((row) => row.id) as [string, ...string[]]).optional().describe("A template to start from: its look and handle."),
  })
  .strict();
export const NewCrew = z
  .object({
    title: z.string().min(1).max(80),
    members: z.array(Handle).min(1).max(24).describe("The nodes' handles, for example [\"manager\", \"tester\"]."),
    lead: Handle.optional().describe("The handle of the node that answers when nobody is mentioned."),
  })
  .strict();
export type Proposal = { action: "node"; input: z.infer<typeof NewNode> } | { action: "crew"; input: z.infer<typeof NewCrew> };

async function checkNewNode(prisma: PrismaClient, owner: string, input: z.infer<typeof NewNode>): Promise<void> {
  if (await nodeNameTaken(prisma, owner, input.name)) throw new ToolBlockedError(`Your owner already has a node called “${input.name.trim()}”.`, "Pick another name.");
  if ((await prisma.nodeAgent.count({ where: { userId: owner, parentNodeId: null } })) >= MAX_NODES) throw new ToolBlockedError(`Your owner has ${MAX_NODES} nodes, the most one account can have.`);
}

async function crewMembers(prisma: PrismaClient, owner: string, input: z.infer<typeof NewCrew>): Promise<{ nodes: NodeAgent[]; lead: NodeAgent }> {
  const title = input.title.trim();
  if (await roomTitleTaken(prisma, owner, title)) throw new ToolBlockedError(`Your owner already has a crew or room called “${title}”.`, "Pick another name.");
  const nodes = await prisma.nodeAgent.findMany({ where: { userId: owner, parentNodeId: null, slug: { in: [...new Set(input.members)] } } });
  const missing = [...new Set(input.members)].filter((slug) => !nodes.some((row) => row.slug === slug));
  if (missing.length) throw new ToolBlockedError(`Your owner has no node ${missing.map((slug) => `@${slug}`).join(", ")}.`, "Use their nodes' handles, or make the node first (node_create).");
  const lead = nodes.find((row) => row.slug === input.lead) ?? nodes.find((row) => row.role === "manager") ?? nodes[0]!;
  return { nodes, lead };
}

/** A lasting node, as the website makes it, on the proposing node's model. */
export async function makeNode(prisma: PrismaClient, by: Pick<NodeAgent, "userId" | "provider" | "model">, input: z.infer<typeof NewNode>): Promise<NodeAgent> {
  await checkNewNode(prisma, by.userId, input);
  const { node: made, room } = await createNode(prisma, by.userId, { templateId: input.templateId, name: input.name.trim(), slug: handleFrom(input.name.trim()), role: input.role.trim(), charter: input.charter, provider: by.provider, model: by.model });
  publishTo([by.userId], "node.room", { roomId: room.id });
  return made;
}

export async function makeCrew(prisma: PrismaClient, owner: string, input: z.infer<typeof NewCrew>): Promise<NodeRoom> {
  const { nodes, lead } = await crewMembers(prisma, owner, input);
  const room = await createCrew(prisma, owner, input.title.trim(), nodes, lead);
  publishTo([owner], "node.room", { roomId: room.id });
  return room;
}

/** A proposal card for the owner (approvals.ts makes it when they approve). */
async function propose(scope: HelperScope, proposal: Proposal, body: string) {
  const { message } = await postMessage(scope.prisma, {
    roomId: scope.room.id,
    userId: scope.node.userId,
    authorKind: "node",
    authorNodeId: scope.node.id,
    kind: "approval",
    body,
    data: { type: "node_proposal", status: "pending", ...proposal, private: Boolean(scope.privateTo) },
    visibleTo: [scope.node.userId],
    rootMessageId: scope.lineage.rootMessageId,
    botDepth: scope.lineage.botDepth,
  });
  return toolOk("Proposed: your owner sees a card with exactly this and makes it or discards it. Say so in one short line; you hear when they decide.", { approvalId: message.id });
}

/**
 * Keeps a helper as a lasting node (the owner's choice): it leaves its parent, keeps its charter and
 * memories, gets its own chat in the sidebar, and its task room stays as history.
 */
export async function promoteHelper(prisma: PrismaClient, accountId: string, helperId: string): Promise<{ node: NodeAgent; room: NodeRoom }> {
  const helper = await prisma.nodeAgent.findFirst({ where: { id: helperId, userId: accountId, parentNodeId: { not: null } } });
  if (!helper) throw new ToolBlockedError("That is not one of your helpers.");
  if ((await prisma.nodeAgent.count({ where: { userId: accountId, parentNodeId: null } })) >= MAX_NODES) throw new ToolBlockedError(`You have ${MAX_NODES} nodes, the most one account can have.`);
  return prisma.$transaction(async (tx) => {
    const autonomy = { ...((helper.autonomy ?? {}) as Record<string, unknown>) };
    delete autonomy.grant;
    delete autonomy.folders;
    const node = await tx.nodeAgent.update({
      where: { id: helper.id },
      data: { parentNodeId: null, autonomy: autonomy as Prisma.InputJsonValue, charter: helper.charter.replace(/^You are a temporary helper of [^\n]*\n/, "") },
    });
    const room = await tx.nodeRoom.create({ data: { userId: accountId, kind: "dm", title: node.name } });
    await addPerson(tx, room.id, accountId, "owner");
    await addNode(tx, room.id, node, true);
    return { node, room };
  });
}
