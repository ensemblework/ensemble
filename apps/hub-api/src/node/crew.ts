/**
 * Crews stay crews (docs/35 §6): a plan or a delegation in a crew reaches only that crew's members (and
 * the lead's own temporary helpers, in their rooms). Another of the owner's nodes joins a crew only when
 * the owner agrees, on a card the crew's lead asks for with `node_crew_add`; approving it adds the node
 * (node/approvals.ts) and wakes the lead to go on.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { NodeAgent, NodeRoom, NodeRoomMember, PrismaClient } from "@prisma/client";
import { defineTool, toolOk, ToolBlockedError, type AnyHubTool } from "../assistant/types.js";
import { publishTo } from "./events.js";
import { addNode, postMessage, roomPeople, roomSettings } from "./store.js";
import type { NodeScope } from "./tools.js";

export const CREW_ADD_CARD = "crew_add";

type Db = Pick<PrismaClient, "nodeRoom" | "nodeRoomMember">;

/** The crew a node's plans run in, when it has one: the one it leads, else the first it is in. Never makes one. */
export async function findCrew(prisma: Db, node: Pick<NodeAgent, "id" | "userId">): Promise<NodeRoom | null> {
  const rooms = await prisma.nodeRoom.findMany({
    where: { userId: node.userId, kind: "crew", archivedAt: null, members: { some: { nodeId: node.id } } },
    orderBy: { createdAt: "asc" },
  });
  return rooms.find((room) => roomSettings(room).leadNodeIds.includes(node.id)) ?? rooms[0] ?? null;
}

/** The other nodes in a room, by handle (the lead itself left out). */
export async function memberHandles(prisma: Db, roomId: string, leadId: string): Promise<string[]> {
  const rows = await prisma.nodeRoomMember.findMany({ where: { roomId, nodeId: { not: null } }, orderBy: { joinedAt: "asc" }, select: { nodeId: true, handle: true } });
  return rows.filter((row) => row.nodeId !== leadId).map((row) => row.handle);
}

/** What a lead is told when it gives work to a node outside its crew. */
export function notInCrew(handle: string, room: Pick<NodeRoom, "kind"> | null, members: readonly string[]): string {
  const where = !room ? "a crew with you" : room.kind === "crew" ? "this crew" : "this conversation";
  const give = members.length ? `Give it to a member (${members.map((row) => `@${row}`).join(", ")}), make` : "Make";
  return `@${handle} is not in ${where}. ${give} a temporary helper (node_helper), or ask your owner to add @${handle} (node_crew_add).`;
}

/** The member a step for `target` goes to in the plan's room: it must already be there, since nobody joins a crew without its owner. */
export async function crewMember(prisma: Db, room: NodeRoom, lead: Pick<NodeAgent, "id">, target: Pick<NodeAgent, "id" | "slug">): Promise<NodeRoomMember> {
  const member = await prisma.nodeRoomMember.findFirst({ where: { roomId: room.id, nodeId: target.id } });
  if (member) return member;
  throw new ToolBlockedError(notInCrew(target.slug, room, await memberHandles(prisma, room.id, lead.id)));
}

/** Adds an owner's node to their crew, as the owner agreed on a crew-add card. */
export async function joinCrew(app: FastifyInstance, input: { ownerId: string; crewId: string; nodeId: string }): Promise<{ handle: string; title: string; joined: boolean }> {
  const prisma = app.prisma;
  const crew = await prisma.nodeRoom.findFirst({ where: { id: input.crewId, userId: input.ownerId, kind: "crew", archivedAt: null } });
  if (!crew) throw new ToolBlockedError("That crew is gone.");
  const node = await prisma.nodeAgent.findFirst({ where: { id: input.nodeId, userId: input.ownerId, parentNodeId: null } });
  if (!node) throw new ToolBlockedError("That node is gone.");
  const existing = await prisma.nodeRoomMember.findFirst({ where: { roomId: crew.id, nodeId: node.id } });
  if (existing) return { handle: existing.handle, title: crew.title, joined: false };
  // routes.ts loads this module (through approvals.ts), so its limit is read when a card is answered.
  const { MAX_CREW_NODES } = await import("./routes.js");
  if ((await prisma.nodeRoomMember.count({ where: { roomId: crew.id, nodeId: { not: null } } })) >= MAX_CREW_NODES) {
    throw new ToolBlockedError(`A crew holds at most ${MAX_CREW_NODES} nodes.`, "Remove a node from the crew first.");
  }
  const member = await addNode(prisma, crew.id, node);
  await postMessage(prisma, { roomId: crew.id, userId: input.ownerId, authorKind: "system", kind: "status", body: `@${member.handle} joined.` });
  publishTo(await roomPeople(prisma, crew.id), "node.room", { roomId: crew.id });
  return { handle: member.handle, title: crew.title, joined: true };
}

const Handle = z.string().min(1).max(60).transform((value) => value.trim().replace(/^@/, "").toLowerCase());

/**
 * `node_crew_add`: the crew's lead asks its owner, on a card in this conversation, to add another of
 * their nodes to the crew. Nothing changes until the owner agrees (node/approvals.ts settles the card).
 * `crewRoom` is where the lead's plans run outside a crew (`crewRoomFor` in node/tools.ts, made on first use).
 */
export function crewAddTool(scope: NodeScope, crewRoom: () => Promise<NodeRoom>): AnyHubTool {
  const { prisma, node } = scope;
  return defineTool({
    name: "node_crew_add",
    area: "tasks",
    description:
      "Ask your owner to add another of their nodes to the crew you lead, when a piece of work needs that node and no member fits. " +
      "They answer on a card in this chat; nothing changes until they agree, and then you are woken to go on. " +
      "Otherwise give the work to a member, make a temporary helper (node_helper), or do it yourself.",
    input: z
      .object({
        node: Handle.describe("The node's handle, for example assistant."),
        reason: z.string().trim().min(1).max(300).describe("Why the crew needs it, in one line for your owner."),
      })
      .strict(),
    isWrite: false,
    risk: "low",
    async run(_ctx, input) {
      if (scope.lineage.fromNonOwner) throw new ToolBlockedError("Only your owner can add nodes to their crews.");
      const crew = scope.room.kind === "crew" ? scope.room : await crewRoom();
      if (!roomSettings(crew).leadNodeIds.includes(node.id)) throw new ToolBlockedError(`Only the lead of “${crew.title}” asks to add nodes to it.`, "Tell your owner what you need.");
      const target = await prisma.nodeAgent.findFirst({ where: { userId: node.userId, slug: input.node, parentNodeId: null } });
      if (!target || target.id === node.id) {
        const mine = await prisma.nodeAgent.findMany({ where: { userId: node.userId, status: "active", parentNodeId: null, id: { not: node.id } }, select: { slug: true } });
        throw new ToolBlockedError(`Your owner has no other node called @${input.node}.`, mine.length ? `Their nodes: ${mine.map((row) => `@${row.slug}`).join(", ")}.` : "They have no other nodes.");
      }
      if (target.status !== "active") throw new ToolBlockedError(`@${target.slug} is paused.`, "Tell your owner; they resume it in its settings.");
      const member = await prisma.nodeRoomMember.findFirst({ where: { roomId: crew.id, nodeId: target.id } });
      if (member) return toolOk(`@${member.handle} is already in “${crew.title}”: give it its step (node_delegate or node_plan).`);
      const asked = await prisma.nodeMessage.findFirst({
        where: {
          roomId: scope.room.id,
          kind: "approval",
          authorNodeId: node.id,
          AND: [{ data: { path: ["type"], equals: CREW_ADD_CARD } }, { data: { path: ["status"], equals: "pending" } }, { data: { path: ["nodeId"], equals: target.id } }, { data: { path: ["roomId"], equals: crew.id } }],
        },
        select: { id: true },
      });
      if (asked) return toolOk("Your owner already has this card. Reply exactly (no reply): you are woken when they answer.", { waitingForOwner: true, approvalId: asked.id });
      const { message } = await postMessage(prisma, {
        roomId: scope.room.id,
        userId: node.userId,
        authorKind: "node",
        authorNodeId: node.id,
        kind: "approval",
        body: `@${node.slug} wants to add @${target.slug} (${target.name}) to “${crew.title}”: ${input.reason}`,
        data: { type: CREW_ADD_CARD, status: "pending", nodeId: target.id, nodeSlug: target.slug, nodeName: target.name, roomId: crew.id, crewTitle: crew.title, reason: input.reason, private: Boolean(scope.privateTo) },
        visibleTo: [node.userId],
        rootMessageId: scope.lineage.rootMessageId,
        botDepth: scope.lineage.botDepth,
      });
      return toolOk(
        `Your owner is asked on a card in this chat to add @${target.slug} to “${crew.title}”. Stop here and say nothing about it: you are woken to go on when they answer.`,
        { waitingForOwner: true, approvalId: message.id },
      );
    },
  });
}
