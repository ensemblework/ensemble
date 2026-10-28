/**
 * Tools only Ensemble Node turns get (docs/35 §7), on top of every Ensemble assistant tool.
 * Talking in rooms is what a node is for, so these never wait for Apply; what they post still
 * follows the room's rules (private threads stay private, shared rooms ask the owner first).
 */
import { z } from "zod";
import type { NodeAgent, NodeMessage, NodeRoom, PrismaClient } from "@prisma/client";
import { defineTool, toolOk, ToolBlockedError, type AnyHubTool } from "../assistant/types.js";
import type { Device } from "@prisma/client";
import { appendLedger } from "../lib/ledger.js";
import { deviceOnline } from "../devices/constants.js";
import { askDeviceFor } from "../devices/file-relay.js";
import { CodeAnswer } from "../remote/contract.js";
import { refusedPath } from "../workspace/folder-read.js";
import { sessionTools } from "./sessions.js";
import { addNode, addPerson, freeRoomTitle, mentionsFor, postMessage, roomPeople } from "./store.js";

export const MAX_MEMORIES = 200;

export type Lineage = { rootMessageId: string | null; botDepth: number; fromNonOwner: boolean };

export type NodeScope = {
  prisma: PrismaClient;
  node: NodeAgent;
  room: NodeRoom;
  lineage: Lineage;
  /** Set when the turn read only a private thread: what it posts stays in that thread. */
  privateTo: string[] | null;
  /** Only the owner reads this turn's thread (a DM, a crew, or a private thread) and only the owner started it. */
  ownerOnly: boolean;
  /** For questions to the owner's paired computer (devices/file-relay.ts). */
  redis: Parameters<typeof askDeviceFor>[0];
  dispatch: (message: NodeMessage) => Promise<void>;
};

/** Whether the owner let this node read files on their paired computers (off unless they turned it on). */
export function computerFilesOn(node: Pick<NodeAgent, "autonomy">): boolean {
  const autonomy = (node.autonomy && typeof node.autonomy === "object" ? node.autonomy : {}) as Record<string, unknown>;
  return autonomy.computerFiles === true;
}

const FILE_ASK_MS = 20_000;
const SEARCH_ASK_MS = 55_000;
const FILE_TEXT_CHARS = 60_000;

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
  const title = await freeRoomTitle(prisma, node.userId, `${node.name}'s crew`);
  return prisma.$transaction(async (tx) => {
    const room = await tx.nodeRoom.create({ data: { userId: node.userId, kind: "crew", title, settings: { leadNodeIds: [node.id] } } });
    await addPerson(tx, room.id, node.userId, "owner");
    await addNode(tx, room.id, node);
    return room;
  });
}

const Handle = z.string().min(1).max(60).transform((value) => value.trim().replace(/^@/, "").toLowerCase());


/**
 * Read-only looks at the owner's paired computer, inside the folders that computer shares with
 * Ensemble, through the same relay and the same switches as the Code tab (`ensemble browse on`; the
 * computer checks every call again). Offered only when the owner turned it on for this node and only
 * the owner reads the turn: what a file says never reaches a room with other people.
 */
function computerFilesTool(scope: NodeScope): AnyHubTool {
  const { prisma, node } = scope;
  return defineTool({
    name: "node_computer_files",
    area: "tasks",
    description:
      "Look at files on your owner's paired computer, inside the folders it shares with Ensemble. action folders: the folders you may use. " +
      "list: a folder's contents (path: a subfolder). read: a text file (path). search: lines containing `query` in a git folder. " +
      "Read-only; files of keys and secrets are never shown. For anything outside these folders, or to change files, have a coding agent do it (node_session_start or node_session_send).",
    input: z.object({
      action: z.enum(["folders", "list", "read", "search"]),
      computer: z.string().max(120).optional().describe("The computer's name, when your owner has more than one."),
      folder: z.string().max(4096).optional().describe("One of the folders action folders listed (required for list, read and search)."),
      path: z.string().max(1000).optional().describe("Inside the folder: a subfolder for list, a file for read."),
      query: z.string().min(1).max(200).optional().describe("Text to find, for search."),
    }).strict(),
    isWrite: false,
    risk: "low",
    async run(_ctx, input) {
      if (!scope.ownerOnly || scope.lineage.fromNonOwner) throw new ToolBlockedError("Files on your owner's computer are read only in a chat with just your owner.");
      const device = await pickComputer(prisma, node.userId, input.computer);
      if (input.action !== "folders" && !input.folder) throw new ToolBlockedError("Name the folder (from action folders).");
      if ((input.action === "read" || input.action === "list") && input.path && refusedPath(input.path)) throw new ToolBlockedError(refusedPath(input.path)!);
      if (input.action === "read" && !input.path) throw new ToolBlockedError("Name the file to read (path).");
      if (input.action === "search" && !input.query) throw new ToolBlockedError("Say what to search for (query).");
      const call =
        input.action === "folders" ? { path: "/api/code/repos", query: {} }
        : input.action === "list" ? { path: "/api/code/tree", query: { repo: input.folder!, path: input.path ?? "" } }
        : input.action === "read" ? { path: "/api/code/file", query: { repo: input.folder!, path: input.path! } }
        : { path: "/api/code/search", query: { repo: input.folder!, q: input.query! } };
      const raw = await askDeviceFor(scope.redis, { deviceId: device.id, event: "code.request", data: { method: "GET", ...call } }, input.action === "search" ? SEARCH_ASK_MS : FILE_ASK_MS);
      if (!raw) throw new ToolBlockedError(`${device.name} did not answer. It may be asleep or busy; try again.`);
      const answer = CodeAnswer.safeParse(raw);
      if (!answer.success) throw new ToolBlockedError(`${device.name} sent an answer that could not be read.`);
      const body = (answer.data.body ?? {}) as Record<string, unknown>;
      if (answer.data.status >= 400) {
        throw new ToolBlockedError(
          `${device.name} refused: ${typeof body.error === "string" ? body.error : `status ${answer.data.status}`}`,
          "Only the folders that computer shares can be read. Your owner can add one there (`ensemble folders add <path>`), or a coding agent can do the work (node_session_start).",
        );
      }
      await appendLedger({ userId: node.userId, actor: "agent", action: "node.computer_files", payload: { nodeId: node.id, deviceId: device.id, action: input.action, folder: input.folder ?? null, path: input.path ?? null } });
      if (input.action === "folders") {
        const roots = Array.isArray(body.roots) ? body.roots.map(String) : [];
        const repos = Array.isArray(body.repos) ? body.repos.map(String) : [];
        return toolOk(`${device.name} shares ${roots.length} folder${roots.length === 1 ? "" : "s"}.`, { computer: device.name, folders: roots, gitFolders: repos });
      }
      if (input.action === "list") {
        const entries = (Array.isArray(body.entries) ? body.entries : []) as Array<Record<string, unknown>>;
        const shown = entries.filter((row) => row.secret !== true).slice(0, 300).map((row) => ({ name: row.name, type: row.type ?? row.kind, size: row.size }));
        return toolOk(`${shown.length} entries in ${input.path || "the folder"}.`, { computer: device.name, folder: input.folder, path: body.path ?? input.path ?? "", entries: shown, truncated: Boolean(body.truncated) || entries.length > shown.length });
      }
      if (input.action === "read") {
        const content = typeof body.content === "string" ? body.content : "";
        return toolOk(`Read ${input.path}.`, { computer: device.name, path: input.path, content: content.slice(0, FILE_TEXT_CHARS), truncated: content.length > FILE_TEXT_CHARS });
      }
      const results = (Array.isArray(body.results) ? body.results : []) as Array<Record<string, unknown>>;
      const visible = results.filter((row) => typeof row.path === "string" && !refusedPath(row.path)).slice(0, 100);
      return toolOk(`${visible.length} matching lines.`, { computer: device.name, folder: input.folder, results: visible, truncated: Boolean(body.truncated) || results.length > visible.length });
    },
  });
}

/** The owner's computer: by name, else the one online (the most recently seen when several are). */
async function pickComputer(prisma: PrismaClient, ownerId: string, name: string | undefined): Promise<Device> {
  const devices = await prisma.device.findMany({ where: { userId: ownerId, revokedAt: null }, orderBy: { lastSeenAt: "desc" } });
  if (!devices.length) throw new ToolBlockedError("Your owner has no paired computer.", "They can pair one with `ensemble login` (the Ensemble CLI) or the Ensemble desktop app.");
  const wanted = name?.trim().toLowerCase();
  const device = wanted ? devices.find((row) => row.name.toLowerCase() === wanted) : devices.find((row) => deviceOnline(row.lastSeenAt));
  if (!device) throw new ToolBlockedError(wanted ? `There is no computer called “${name}”.` : "None of your owner's computers is online.", `Their computers: ${devices.map((row) => row.name).join(", ")}.`);
  if (!deviceOnline(device.lastSeenAt)) throw new ToolBlockedError(`${device.name} is offline.`, "Ensemble must be running there (`ensemble runner start`).");
  const caps = (device.capabilities ?? {}) as { code?: unknown; codeApi?: unknown; browseFiles?: unknown };
  if (caps.code !== true || (typeof caps.codeApi === "number" ? caps.codeApi : 1) < 2) throw new ToolBlockedError(`Ensemble on ${device.name} is too old to share files. Update it there (\`ensemble update\`).`);
  if (caps.browseFiles === false) throw new ToolBlockedError(`Showing files from ${device.name} is turned off there.`, "Your owner can turn it on with `ensemble browse on`.");
  return device;
}

export function nodeTools(scope: NodeScope): AnyHubTool[] {
  const { prisma, node } = scope;
  return [
    ...(computerFilesOn(node) && scope.ownerOnly && !scope.lineage.fromNonOwner ? [computerFilesTool(scope)] : []),
    ...sessionTools(scope),
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
