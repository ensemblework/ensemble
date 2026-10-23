/**
 * Tools only Ensemble Node turns get (docs/35 §7), on top of every Ensemble assistant tool.
 * Talking in rooms is what a node is for, so these never wait for Apply; what they post still
 * follows the room's rules (private threads stay private, shared rooms ask the owner first).
 */
import { z } from "zod";
import type { NodeAgent, NodeMessage, NodeRoom, PrismaClient } from "@prisma/client";
import { defineTool, toolOk, ToolBlockedError, type AnyHubTool } from "../assistant/types.js";
import { addNode, addPerson, mentionsFor, postMessage, roomPeople } from "./store.js";

export const MAX_MEMORIES = 200;

export type Lineage = { rootMessageId: string | null; botDepth: number; fromNonOwner: boolean };

export type NodeScope = {
  prisma: PrismaClient;
  node: NodeAgent;
  room: NodeRoom;
  lineage: Lineage;
  /** Set when the turn read only a private thread: what it posts stays in that thread. */
  privateTo: string[] | null;
  dispatch: (message: NodeMessage) => Promise<void>;
};

export function sharedRoomsAuto(node: Pick<NodeAgent, "autonomy">): boolean {
  const autonomy = (node.autonomy && typeof node.autonomy === "object" ? node.autonomy : {}) as Record<string, unknown>;
  return autonomy.sharedRooms === "auto";
}

/**
 * Posts as the node: privately when the turn was private, as a draft for the owner in a room
 * with other people (unless the owner lets this node post there on its own), otherwise to all.
 */
export async function postAsNode(
  scope: Pick<NodeScope, "prisma" | "node" | "lineage" | "dispatch">,
  room: NodeRoom,
  body: string,
  privateTo: string[] | null,
  extra: { data?: Record<string, unknown> } = {},
): Promise<{ message: NodeMessage; drafted: boolean }> {
  const { prisma, node, lineage } = scope;
  const owner = node.userId;
  const members = await prisma.nodeRoomMember.findMany({ where: { roomId: room.id } });
  const people = await roomPeople(prisma, room.id);
  const shared = people.some((accountId) => accountId !== owner);
  const visibleTo = privateTo ?? [];
  const lineageData = { fromNonOwner: lineage.fromNonOwner };
  if (visibleTo.length === 0 && shared && !sharedRoomsAuto(node)) {
    const { message } = await postMessage(prisma, {
      roomId: room.id,
      userId: owner,
      authorKind: "node",
      authorNodeId: node.id,
      kind: "approval",
      body,
      data: { type: "post", status: "pending", ...lineageData, ...(extra.data ?? {}) },
      visibleTo: [owner],
      rootMessageId: lineage.rootMessageId,
      botDepth: lineage.botDepth,
    });
    return { message, drafted: true };
  }
  const { message } = await postMessage(prisma, {
    roomId: room.id,
    userId: owner,
    authorKind: "node",
    authorNodeId: node.id,
    body,
    data: { ...lineageData, ...(extra.data ?? {}) },
    visibleTo,
    mentions: mentionsFor(body, members, visibleTo),
    rootMessageId: lineage.rootMessageId,
    botDepth: lineage.botDepth,
  });
  await scope.dispatch(message);
  return { message, drafted: false };
}

/** The crew room this node leads for its owner, made on first use. */
async function crewRoomFor(prisma: PrismaClient, node: NodeAgent): Promise<NodeRoom> {
  const rooms = await prisma.nodeRoom.findMany({
    where: { userId: node.userId, kind: "crew", archivedAt: null, members: { some: { nodeId: node.id } } },
    orderBy: { createdAt: "asc" },
  });
  const led = rooms.find((room) => {
    const leads = (room.settings as { leadNodeIds?: unknown } | null)?.leadNodeIds;
    return Array.isArray(leads) && leads.includes(node.id);
  });
  const found = led ?? rooms[0];
  if (found) return found;
  return prisma.$transaction(async (tx) => {
    const room = await tx.nodeRoom.create({ data: { userId: node.userId, kind: "crew", title: `${node.name}'s crew`, settings: { leadNodeIds: [node.id] } } });
    await addPerson(tx, room.id, node.userId, "owner");
    await addNode(tx, room.id, node);
    return room;
  });
}

const Handle = z.string().min(1).max(60).transform((value) => value.trim().replace(/^@/, "").toLowerCase());

export function nodeTools(scope: NodeScope): AnyHubTool[] {
  const { prisma, node } = scope;
  return [
    defineTool({
      name: "node_delegate",
      area: "tasks",
      description:
        "Hand a piece of work to one of your owner's other nodes (for example @tester or @builder): posts a self-contained brief that mentions it, which wakes it. " +
        "If it is not in this room, the brief goes to the crew room you lead. Include the Ensemble task, what done looks like, and ask it to mention you when finished.",
      input: z.object({
        to: Handle.describe("The node's handle, for example tester."),
        brief: z.string().min(1).max(4000).describe("What to do, with links to the task or page, and what done looks like."),
      }).strict(),
      isWrite: false,
      risk: "low",
      async run(_ctx, input) {
        const here = await prisma.nodeRoomMember.findFirst({ where: { roomId: scope.room.id, handle: input.to, nodeId: { not: null } } });
        const target = here?.nodeId
          ? await prisma.nodeAgent.findUnique({ where: { id: here.nodeId } })
          : await prisma.nodeAgent.findFirst({ where: { userId: node.userId, slug: input.to } });
        if (!target || target.id === node.id) {
          const mine = await prisma.nodeAgent.findMany({ where: { userId: node.userId, status: "active", id: { not: node.id } }, select: { slug: true } });
          throw new ToolBlockedError(`There is no node called @${input.to} you can delegate to.`, mine.length ? `Your owner's nodes: ${mine.map((row) => `@${row.slug}`).join(", ")}.` : "Your owner has no other nodes yet.");
        }
        if (target.userId !== node.userId) {
          throw new ToolBlockedError(`@${input.to} belongs to someone else. Mention it in your reply instead; your owner sees that first.`);
        }
        if (target.status !== "active") throw new ToolBlockedError(`@${target.slug} is paused.`);
        const room = here ? scope.room : await crewRoomFor(prisma, node);
        const member = here ?? (await addNode(prisma, room.id, target));
        const people = await roomPeople(prisma, room.id);
        // Crew chatter stays between the owner and their nodes when other people are in the room.
        const privateTo = room.id === scope.room.id && scope.privateTo ? scope.privateTo : people.some((id) => id !== node.userId) ? [node.userId] : null;
        const { message } = await postAsNode(scope, room, `@${member.handle} ${input.brief}`, privateTo, {
          data: { delegation: { fromRoomId: scope.room.id, fromNodeId: node.id } },
        });
        return toolOk(`Asked @${member.handle} in “${room.title}”.`, { roomId: room.id, messageId: message.id });
      },
    }),
    defineTool({
      name: "node_post",
      area: "tasks",
      description:
        "Post a message in another room you are in (see Your rooms), for example to report back in the group once your crew finished. " +
        "In a room with other people your owner approves the post first unless they let you post there yourself.",
      input: z.object({
        room: z.string().min(1).max(200).describe("The room's id, or its exact title."),
        body: z.string().min(1).max(6000),
      }).strict(),
      isWrite: false,
      risk: "low",
      async run(_ctx, input) {
        const memberships = await prisma.nodeRoomMember.findMany({ where: { nodeId: node.id }, include: { room: true } });
        const wanted = input.room.trim().toLowerCase();
        const hit = memberships.find((row) => row.roomId === input.room.trim()) ?? memberships.find((row) => row.room.title.trim().toLowerCase() === wanted);
        if (!hit || hit.room.archivedAt) {
          throw new ToolBlockedError(`You are not in a room called “${input.room}”.`, `Your rooms: ${memberships.map((row) => `“${row.room.title}”`).join(", ")}.`);
        }
        const privateTo = hit.roomId === scope.room.id ? scope.privateTo : null;
        const { drafted } = await postAsNode(scope, hit.room, input.body, privateTo);
        return toolOk(drafted ? `Drafted for your owner to approve in “${hit.room.title}”.` : `Posted in “${hit.room.title}”.`);
      },
    }),
    defineTool({
      name: "node_remember",
      area: "tasks",
      description: "Keep a short fact for later conversations: a preference, a convention, a decision your owner told you. Your owner can see and delete every memory.",
      input: z.object({ content: z.string().min(1).max(500) }).strict(),
      isWrite: false,
      risk: "low",
      async run(_ctx, input) {
        if (scope.lineage.fromNonOwner) throw new ToolBlockedError("Only your owner can ask you to remember something.");
        await prisma.nodeMemory.create({ data: { userId: node.userId, nodeId: node.id, content: input.content.trim() } });
        const extra = await prisma.nodeMemory.findMany({ where: { nodeId: node.id }, orderBy: { createdAt: "desc" }, skip: MAX_MEMORIES, select: { id: true } });
        if (extra.length) await prisma.nodeMemory.deleteMany({ where: { id: { in: extra.map((row) => row.id) } } });
        return toolOk("Remembered.");
      },
    }),
  ];
}
