/**
 * A node's instructions for one turn (docs/35 §5.5), assembled from the section files in
 * packages/prompts: the stable tier (the constitution, the node's role and what it can do, the same
 * byte for byte while its setup is the same), the context tier (its room, crew, rooms, the skills for
 * this request and its memories: information, not instructions) and the turn packet. Which sections a
 * turn gets is decided here, from its facts (`nodeSections`); the words are in the files.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { NodeAgent, NodeRoom, NodeRoomMember, PrismaClient } from "@prisma/client";
import { assemble, estimateTokens, SECTIONS, type Assembled, type SectionName, type SectionRequest, type Value } from "@ensemble/prompts";
import { isSubscriptionProvider, pickRunProfile, type AssistantRef, type SubscriptionProvider } from "@ensemble/shared-types";
import { loadSettings } from "../lib/settings.js";
import { OWN_WEB_AGENTS } from "../subscriptions/agents.js";
import { findCrew } from "./crew.js";
import { helperGrant, type HelperGrant } from "./helpers.js";
import { NO_REPLY } from "./reply.js";
import { agentDefaults, computerWorkAsks } from "./sessions.js";
import { roomSettings } from "./store.js";
import { charterOf } from "./templates.js";
import { computerFilesOn } from "./tools.js";

/** Tokens per tier. The stable tier's is above any real node's (an 8,000-character charter included), so a rule is never left out. */
export const NODE_BUDGETS = { stable: 6_000, context: 3_000 } as const;

/** Every constitution section, in file order: a node gets all of them (the Hub assistant shares some, assistant/state.ts). */
export const CONSTITUTION = (Object.keys(SECTIONS) as SectionName[]).filter((name) => name.startsWith("constitution/")).sort();

/** What a turn's sections depend on. Everything here is decided before the model is called. */
export type NodeFacts = {
  owner: string;
  name: string;
  slug: string;
  role: string;
  /** The node's charter; a helper's is its parent's brief. */
  charter: string;
  room: { title: string; kind: string };
  roster: string[];
  /** A plan step's turn: its words are a report, never posted. */
  step: boolean;
  /** Someone other than the owner started the turn. */
  fromNonOwner: boolean;
  /** Only the owner reads the thread the turn answers in. */
  ownerOnly: boolean;
  /** The owner's own AI plan runs the turn: its agent is the loop (no web_task). */
  ownLoop: boolean;
  /** ...and that agent searches the web itself (subscriptions/agents.ts `OWN_WEB_AGENTS`). */
  ownWeb: boolean;
  /** The run profile its agent sessions use (node/sessions.ts `agentDefaults`). */
  runProfile: string;
  computerFiles: boolean;
  computerWorkAsks: boolean;
  /** It leads the crew this room is. */
  leadsHere: boolean;
  /** The crew's lead, as it is mentioned. */
  lead: string;
  /** The lead of this crew room: the owner's nodes outside it. */
  crewOutside: string[];
  /** Outside a crew room: its crew's title and members, and the owner's other nodes not in a crew with it. */
  crewTitle: string | null;
  crewMates: string[];
  crewOthers: string[];
  helpers: string[];
  rooms: string[];
  /** A helper's room: where the node's reply goes. */
  origin: string | null;
  skills: string;
  memories: string[];
  helper: { parent: string; parentName: string; grant: HelperGrant } | null;
};

/** The section files for a turn, by its facts: each row of the routing table is a section with its condition. */
export function nodeSections(facts: NodeFacts): SectionRequest[] {
  const sections: SectionRequest[] = [];
  const stable = (name: SectionName, vars?: Record<string, Value>) => sections.push({ name, tier: "stable", ...(vars ? { vars } : {}) });
  const context = (name: SectionName, priority: number, vars?: Record<string, Value>, trim?: string) =>
    sections.push({ name, tier: "context", priority, ...(vars ? { vars } : {}), ...(trim ? { trim } : {}) });
  for (const name of CONSTITUTION) stable(name);
  const { step, fromNonOwner, ownerOnly } = facts;

  if (facts.helper) {
    const { parent, parentName, grant } = facts.helper;
    stable("node/60-helper-role", { parent, parent_name: parentName });
    if (facts.charter) stable("node/61-helper-brief", { brief: facts.charter });
    stable(step ? "node/62-helper-step" : "node/62-helper-messages", { parent });
    stable(facts.ownWeb ? "node/63-helper-facts-own-web" : "node/63-helper-facts");
    stable(grant === "sessions" ? "node/64-helper-sessions" : grant === "computer" ? (facts.ownLoop ? "node/64-helper-computer-own-loop" : "node/64-helper-computer") : "node/64-helper-read");
    stable("node/65-helper-cards");
    stable(step ? "node/66-helper-report" : "node/66-helper-reply", { parent });
    if (!step) stable("node/45-no-reply");
    context("node/50-context", 0);
    context("node/67-helper-room", 0, { room: facts.room.title, parent });
    return sections;
  }

  // Its own hands on the computer only where its owner started the turn and reads alone (node/device-tools.ts).
  const hands = ownerOnly && !fromNonOwner;
  const kind = facts.room.kind;
  const dm = kind === "dm";
  const room = kind === "room";
  stable("node/00-role");
  if (facts.charter) stable("node/01-charter", { charter: facts.charter });
  if (hands) stable("node/03-hands");
  stable(hands ? (facts.ownWeb ? "node/10-facts-hands-own-web" : "node/10-facts-hands") : facts.ownWeb ? "node/10-facts-own-web" : "node/10-facts");
  stable("node/11-owner-work");
  if (hands) {
    stable("node/12-hands-work");
    stable(facts.ownLoop ? "node/13-web-task-own-loop" : "node/13-web-task");
  }
  if (hands && dm) {
    stable("node/14-live");
    stable("node/15-cli-sign-in");
  }
  if (!fromNonOwner) stable("node/16-papers");
  stable("node/17-coding", { run_profile: facts.runProfile });
  if (!step && !fromNonOwner) {
    stable("node/18-own-work");
    if (ownerOnly) stable("node/19-create");
  }
  if (step) {
    stable("node/20-step");
    stable("node/21-step-rules");
  }
  if (!step && facts.leadsHere) stable("node/22-lead");
  if (!step && !fromNonOwner && (dm || room)) stable("node/23-delegate");
  if (!step && !fromNonOwner && (facts.leadsHere || dm || room)) stable("node/24-crew-add");
  if (!step && kind === "crew" && !facts.leadsHere) stable("node/25-crew-member", { lead: facts.lead });
  if (!step && room) stable("node/26-answer-nodes");
  if (kind === "task") stable("node/27-task-room");
  stable("node/30-messages");
  if (fromNonOwner) stable("node/31-not-owner");
  if (!step) stable("node/32-reply");
  stable("node/33-speak");
  if (hands && !step) stable("node/34-captures");
  if (!step) stable("node/35-cards");
  stable("node/36-privacy");
  if (!step) stable("node/37-board");
  stable("node/38-remember");
  if (facts.computerFiles) stable("node/39-computer-files");
  if (fromNonOwner) stable("node/44-sessions-not-owner");
  else {
    stable("node/40-sessions");
    if (!step) stable("node/41-sessions-said");
    if (!ownerOnly) stable("node/42-sessions-others-read");
    else if (facts.computerWorkAsks) stable("node/43-sessions-ask");
  }
  stable("node/45-no-reply");

  context("node/50-context", 0);
  context(ROOM_SECTION[kind] ?? "node/51-room-people", 0, { room: facts.room.title, roster: facts.roster });
  if (kind === "task" && facts.origin) context("node/52-origin", 0, { origin: facts.origin });
  if (!step && !fromNonOwner) {
    if (kind === "crew") {
      if (facts.leadsHere && facts.crewOutside.length) context("node/53-crew-outside", 2, { nodes: facts.crewOutside.join(", ") });
    } else if (kind !== "task") {
      if (facts.crewTitle && facts.crewMates.length) context("node/53-crew-mates", 2, { crew: facts.crewTitle, members: facts.crewMates.join(", ") });
      if (facts.crewOthers.length) context(facts.crewTitle ? "node/53-crew-others" : "node/53-crew-others-no-crew", 2, { nodes: facts.crewOthers.join(", ") });
    }
  }
  if (facts.helpers.length) context("node/54-helpers", 2, { helpers: facts.helpers.join(", ") });
  if (facts.rooms.length > 1) context("node/55-rooms", 3, { rooms: facts.rooms.join("; ") });
  if (facts.skills) context("node/56-skills", 1, { skills: facts.skills });
  context("node/57-memories", 4, { memories: facts.memories.map((memory) => `- ${memory}`) }, "memories");
  return sections;
}

const ROOM_SECTION: Record<string, SectionName> = { dm: "node/51-room-dm", crew: "node/51-room-crew", task: "node/51-room-task", room: "node/51-room-people" };

/** What the turn was told and how big each part was: for the turn's `model.call` metric (agent.ts). */
export type InstructionsLog = Pick<Assembled, "version" | "hash" | "hashes" | "sections" | "dropped">;

export type NodeInstructions = {
  stable: string;
  context: string;
  /** The rooms named by id, so a reply that prints one shows its title. */
  rooms: AssistantRef[];
  log: InstructionsLog;
};

/** The node's tiers plus the turn packet, assembled once, so the log covers everything the model got. */
export function assembleNode(facts: NodeFacts, packet: readonly SectionRequest[] = []): Assembled {
  return assemble({ surface: "node", sections: [...nodeSections(facts), ...packet], vars: { owner: facts.owner, name: facts.name, slug: facts.slug, role: facts.role, no_reply: NO_REPLY }, budgets: NODE_BUDGETS });
}

/** The turn packet (the user message): the room's new messages, a note for this turn and the work board; a step's update. */
export function packetSections(input: { work: boolean; note: string | null; room: string; lines: string[]; calledAt: number; board: string }): SectionRequest[] {
  if (input.work) return [input.note === null ? { name: "node/83-packet-continue", tier: "volatile" } : { name: "node/83-packet-step", tier: "volatile", vars: { note: input.note } }];
  return [
    input.calledAt > 0
      ? { name: "node/80-packet-backlog", tier: "volatile", vars: { room: input.room, earlier: input.lines.slice(0, input.calledAt), called: input.lines.slice(input.calledAt) } }
      : { name: "node/80-packet-new", tier: "volatile", vars: { room: input.room, messages: input.lines } },
    ...(input.note ? [{ name: "node/81-packet-update", tier: "volatile", vars: { note: input.note } } satisfies SectionRequest] : []),
    ...(input.board ? [{ name: "node/82-packet-board", tier: "volatile", vars: { board: input.board } } satisfies SectionRequest] : []),
  ];
}

/**
 * The log of a turn whose instructions are written in code (a room-bound turn, node/audience.ts): that
 * block's size and hash, with the packet's sections.
 */
export function codeBuiltLog(persona: string, packet: readonly SectionRequest[]): InstructionsLog {
  const assembled = assemble({ surface: "node", sections: packet });
  const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
  return {
    version: assembled.version,
    hash: hash(`${persona}\n\n${assembled.text}`),
    hashes: { stable: hash(persona), context: hash(""), volatile: assembled.hashes.volatile },
    sections: [{ name: "node/audience.ts roomPersona", tier: "stable", chars: persona.length, tokens: estimateTokens(persona) }, ...assembled.sections],
    dropped: [],
  };
}

/** The packet's text, the user message the turn saves and sends. */
export function packetText(packet: readonly SectionRequest[]): string {
  return assemble({ surface: "node", sections: packet }).text;
}

/** What a node turn's instructions depend on, beyond what is loaded here. */
export type NodeTurnInput = {
  node: NodeAgent;
  room: NodeRoom;
  members: NodeRoomMember[];
  ownerName: string;
  fromNonOwner: boolean;
  ownerOnly: boolean;
  step: boolean;
  /** Skills for this turn's request (node/skills.ts), as a block. */
  skills: string;
  /** The provider of the model the turn runs on. */
  provider: string;
  /** A helper's room: where the node's reply goes (node/brain.ts `originLine`). */
  origin: string | null;
};

/**
 * Loads what a node turn's instructions say (its room, roster, crew, rooms, settings and memories) and
 * assembles them with the turn's packet.
 */
export async function nodeInstructions(app: FastifyInstance, input: NodeTurnInput & { packet: readonly SectionRequest[] }): Promise<NodeInstructions> {
  const { facts, rooms } = await nodeFacts(app.prisma, input);
  const assembled = assembleNode(facts, input.packet);
  const { version, hash, hashes, sections, dropped } = assembled;
  return { stable: assembled.tiers.stable, context: assembled.tiers.context, rooms, log: { version, hash, hashes, sections, dropped } };
}

async function nodeFacts(prisma: PrismaClient, input: NodeTurnInput): Promise<{ facts: NodeFacts; rooms: AssistantRef[] }> {
  const { node, room, members } = input;
  const ownLoop = isSubscriptionProvider(input.provider);
  const base = {
    owner: input.ownerName,
    name: node.name,
    slug: node.slug,
    role: node.role,
    step: input.step,
    fromNonOwner: input.fromNonOwner,
    ownerOnly: input.ownerOnly,
    ownLoop,
    ownWeb: ownLoop && OWN_WEB_AGENTS.has(input.provider as SubscriptionProvider),
    origin: input.origin,
    skills: input.skills,
  };
  if (node.parentNodeId) {
    const parent = await prisma.nodeAgent.findUnique({ where: { id: node.parentNodeId }, select: { slug: true, name: true } });
    return {
      facts: {
        ...base,
        charter: node.charter ?? "",
        room: { title: room.title, kind: room.kind },
        roster: [],
        runProfile: "",
        computerFiles: false,
        computerWorkAsks: false,
        leadsHere: false,
        lead: "",
        crewOutside: [],
        crewTitle: null,
        crewMates: [],
        crewOthers: [],
        helpers: [],
        rooms: [],
        memories: [],
        helper: { parent: parent?.slug ?? "your node", parentName: parent?.name ?? "a node", grant: helperGrant(node) ?? "read" },
      },
      rooms: [],
    };
  }
  const [nodes, memberships, memories, people, teammates, helpers, settings] = await Promise.all([
    prisma.nodeAgent.findMany({ where: { id: { in: members.filter((row) => row.nodeId).map((row) => row.nodeId!) } } }),
    prisma.nodeRoomMember.findMany({ where: { nodeId: node.id }, include: { room: { select: { id: true, title: true, kind: true, archivedAt: true } } } }),
    prisma.nodeMemory.findMany({ where: { nodeId: node.id }, orderBy: { createdAt: "desc" }, take: 40 }),
    prisma.user.findMany({ where: { id: { in: members.filter((row) => !row.nodeId).map((row) => row.userId) } }, select: { id: true, name: true, email: true } }),
    prisma.nodeAgent.findMany({ where: { userId: node.userId, status: "active", parentNodeId: null, id: { not: node.id } }, select: { id: true, slug: true, role: true } }),
    prisma.nodeAgent.findMany({ where: { parentNodeId: node.id }, select: { slug: true } }),
    loadSettings(prisma, node.userId),
  ]);
  const nodeById = new Map(nodes.map((row) => [row.id, row]));
  const personName = new Map(people.map((row) => [row.id, row.name?.trim() || row.email.split("@")[0]!]));
  const { responsibilities: duties, leadNodeIds } = roomSettings(room);
  const leadsHere = room.kind === "crew" && leadNodeIds.includes(node.id);
  const leadHandle = members.find((row) => row.nodeId && leadNodeIds.includes(row.nodeId))?.handle;
  const roster = members.map((member) => {
    if (member.nodeId) {
      const other = nodeById.get(member.nodeId);
      const whose = member.userId === node.userId ? "your owner's" : `${personName.get(member.userId) ?? "someone"}'s`;
      return `- @${member.handle}: ${member.nodeId === node.id ? "you" : `${whose} node “${other?.name ?? member.handle}” (${other?.role ?? "node"})`}`;
    }
    const focus = duties[member.userId];
    return `- @${member.handle}: ${personName.get(member.userId) ?? "a person"}${member.userId === node.userId ? " (your owner)" : ""}${focus ? `, handles ${focus}` : ""}`;
  });
  const open = memberships.filter((row) => !row.room.archivedAt);
  return {
    facts: {
      ...base,
      charter: charterOf(node),
      room: { title: room.title, kind: room.kind },
      roster,
      runProfile: agentDefaults(pickRunProfile(settings, node.runProfileId)),
      computerFiles: computerFilesOn(node),
      computerWorkAsks: computerWorkAsks(node),
      leadsHere,
      lead: leadHandle ? `@${leadHandle}` : "the lead",
      ...(await crewOf(prisma, node, room, members, teammates)),
      helpers: helpers.map((row) => `@${row.slug}`),
      rooms: open.map((row) => `“${row.room.title}” [${row.room.id}] (${row.room.kind})`),
      memories: memories.map((row) => row.content),
      helper: null,
    },
    // Room ids are for node_post; a reply that prints one shows the room's title instead.
    rooms: open.map((row) => ({ kind: "room", id: row.room.id, label: row.room.title })),
  };
}

/**
 * Who the node can give work to: in a crew room, the owner's nodes outside it (only the owner adds one);
 * elsewhere, the members of its crew and the owner's other nodes (node/crew.ts).
 */
async function crewOf(
  prisma: PrismaClient,
  node: NodeAgent,
  room: NodeRoom,
  members: NodeRoomMember[],
  teammates: Array<{ id: string; slug: string; role: string }>,
): Promise<Pick<NodeFacts, "crewOutside" | "crewTitle" | "crewMates" | "crewOthers">> {
  const label = (row: { slug: string; role: string }) => `@${row.slug} (${row.role})`;
  if (room.kind === "crew") return { crewOutside: teammates.filter((row) => !members.some((member) => member.nodeId === row.id)).map(label), crewTitle: null, crewMates: [], crewOthers: [] };
  if (room.kind === "task") return { crewOutside: [], crewTitle: null, crewMates: [], crewOthers: [] };
  const crew = await findCrew(prisma, node);
  const inCrew = crew ? await prisma.nodeRoomMember.findMany({ where: { roomId: crew.id, nodeId: { not: null } }, select: { nodeId: true, handle: true } }) : [];
  const handle = (id: string) => inCrew.find((member) => member.nodeId === id)?.handle;
  return {
    crewOutside: [],
    crewTitle: crew?.title ?? null,
    crewMates: teammates.filter((row) => handle(row.id)).map((row) => `@${handle(row.id)} (${row.role})`),
    crewOthers: teammates.filter((row) => !handle(row.id)).map(label),
  };
}
