/**
 * One node turn (docs/35 §5): the room's new messages become one user message in the node's own
 * assistant conversation, and Ensemble's assistant loop (assistant/agent.ts) answers with every
 * Hub tool plus the node tools. Writes follow the owner's Ensemble write policy; a turn started by
 * anyone but the owner holds every write for the owner's approval. Nothing runs on this server: work
 * on a computer is done there, by the node's own tools (node/device-tools.ts) or by the owner's own
 * coding agents, in sessions the node controls (node/sessions.ts).
 */
import { MESSAGE_FILES_MAX } from "../assistant/attachments.js";
import { fileQuoteContext } from "./file-workspace.js";
import type { FastifyInstance } from "fastify";
import type { NodeAgent, NodeMessage, NodeRoom, NodeRoomMember, NodeTurn, PrismaClient } from "@prisma/client";
import { asksForIds, INCLUDED_PROVIDER, isSubscriptionProvider, type AssistantToolCall } from "@ensemble/shared-types";
import { ownCallTrace, runAssistantTurn, type AssistantTurnResult, type ClaimState, type VerifyState } from "../assistant/agent.js";
import { getTool } from "../assistant/registry.js";
import { pauseQuestion } from "../assistant/runaway.js";
import { env } from "../config.js";
import { assertIncludedOpen } from "../included/budget.js";
import { IncludedLimitError } from "../included/errors.js";
import { loadSettings } from "../lib/settings.js";
import { effortToSend } from "../lib/model-meta.js";
import { persistAssistantText, safePublicError, truncateText } from "../lib/text.js";
import { publishTo } from "./events.js";
import { chatModelFor, fastChatModel, leadChatModel, type ChatModel } from "./model.js";
import { canSee, postMessage, roomPeople, visibleWhere } from "./store.js";
import { cleanReply, NO_REPLY } from "./reply.js";
import { nodeTools, postAsNode, type Lineage } from "./tools.js";
import { codeBuiltLog, nodeInstructions, packetSections, packetText, type NodeInstructions } from "./instructions.js";
import { recordMetric } from "../lib/metrics.js";
import { helperFolders, helperGrant } from "./helpers.js";
import { RuntimeError } from "../lib/runtime-error.js";
import { addReceipt, markActed, mayRetry, parkedFor, parkIfAsked } from "./queue.js";
import { missionOf, modeFor } from "./device-tools.js";
import { ownToolAsker } from "./own-tool-asks.js";
import { afterReport, currentPlan, finishStep, nudgeStep, startPlan, stepCardsWaiting, stepLive, stepPending, stepProgress, stepRow, stepRuns, stopPlans } from "./plans.js";
import { actsOnTheWorld, workBoard } from "./work-board.js";
import { nodeSpaceGateway } from "./spaces.js";
import { missionMedia, peekTurnMedia, takeTurnMedia, type Media } from "./media.js";
import { draftDisclosure, draftingTools, roomBoundTurn } from "./audience.js";
import { checkLoginOnDone } from "./login-check.js";
import { tieredTools } from "./skills.js";
import { checklistModelOn, startDeliverables } from "./deliverables.js";
import { checkDelivery, deliveredWith, heldCaptures } from "./delivery-claims.js";
import { taskReplyData } from "./task-assignment.js";
import type { OwnToolEvent } from "../subscriptions/bridge.js";
import type { NodeTurnPolicy } from "../subscriptions/node-own-tools.js";
import { saveTrace, setPlacement, TurnTrace } from "./trace.js";
import { inTurn } from "./turn-context.js";

/** Turns that carry on work already under way: they keep every tool (node/skills.ts tiers apply to the others). */
const CARRIES_ON = new Set(["approval", "run", "attention", "plan", "tool", "work"]);

/** The owner's last words in this thread, for a turn that carries on without new ones. */
async function ownerLastWords(prisma: PrismaClient, roomId: string, owner: string, where: Record<string, unknown>): Promise<string> {
  const rows = await prisma.nodeMessage.findMany({ where: { roomId, authorKind: "human", userId: owner, kind: "text", ...where }, orderBy: { seq: "desc" }, take: 3, select: { body: true } });
  return rows.map((row) => row.body).reverse().join("\n");
}

/** The tools this conversation's last replies used: a turn that goes on with app testing keeps those tools. */
async function recentTools(prisma: PrismaClient, conversationId: string): Promise<string[]> {
  const rows = await prisma.assistantMessage.findMany({ where: { conversationId, role: "assistant" }, orderBy: { createdAt: "desc" }, take: 3, select: { toolCalls: true } });
  return rows.flatMap((row) => (Array.isArray(row.toolCalls) ? row.toolCalls : []).map((call) => String((call as { name?: unknown } | null)?.name ?? "")));
}

/** The model for a turn's checklist call: the fast one, else the node's own (never an AI plan on a computer). */
function checklistModel(node: NodeAgent, settings: Parameters<typeof fastChatModel>[0]): ChatModel | null {
  const fast = fastChatModel(settings);
  if (fast && !isSubscriptionProvider(fast.provider)) return fast;
  const own = chatModelFor(node, settings);
  return "error" in own || isSubscriptionProvider(own.provider) ? null : own;
}

/** Whether this turn already made a plan (then it is not run again from the start). */
async function madePlan(prisma: FastifyInstance["prisma"], nodeId: string, turnId: string): Promise<boolean> {
  return Boolean(await currentPlan(prisma, nodeId, turnId, null));
}

/** The assistant tools a node turn does without: its session tools replace them, scoped to the node's own sessions. */
export const NODE_REPLACED_TOOLS = ["hub_assign_to_agent", "hub_list_agent_sessions"] as const;

/** Pages are a node's everyday records, like tasks: their tools are shown whatever the guides, so a page needs no hub_how_to first. */
export const NODE_CORE_TOOLS = ["hub_list_pages", "hub_read_page", "hub_create_page", "hub_update_page"] as const;


/** retry: the model's rate limit cut the turn off before anything was posted; queue.ts runs it again later. */
/** coalesced: a newer message from the owner came before this turn acted; the next turn answers both. */
/** parked: the turn waits for its owner's answer on a card; it ended without a reply, and the answer wakes the node. */
/** cancelled: its owner stopped it (Stop, a pause, a plan's Stop) while it ran. */
export type TurnOutcome = { status: "done" | "failed" | "skipped" | "retry" | "coalesced" | "parked" | "cancelled"; model?: string; credits?: number | null; error?: string };
export type TurnDeps = { dispatch: (message: NodeMessage) => Promise<void>; signal?: AbortSignal };

/** Background turns call Ensemble's own routes as the owner, like a signed-in request would. */
export function internalHeaders(spaceId: string): Record<string, string> {
  return { "x-ensemble-internal": env.ENSEMBLE_INTERNAL_TOKEN, "x-ensemble-user": spaceId };
}

type Who = { label: (row: { userId: string; authorKind: string; authorNodeId: string | null }) => string };

async function namesFor(app: FastifyInstance, room: NodeRoom, members: NodeRoomMember[], ownerId: string): Promise<Who> {
  const people = await app.prisma.user.findMany({ where: { id: { in: [...new Set(members.map((row) => row.userId))] } }, select: { id: true, name: true, email: true } });
  const name = new Map(people.map((row) => [row.id, row.name?.trim() || row.email.split("@")[0]!]));
  const handleOfNode = new Map(members.filter((row) => row.nodeId).map((row) => [row.nodeId!, row.handle]));
  return {
    label(row) {
      if (row.authorKind === "system") return "Ensemble";
      const owner = name.get(row.userId) ?? "someone";
      if (row.authorKind === "node") return `@${handleOfNode.get(row.authorNodeId ?? "") ?? "node"} (node of ${row.userId === ownerId ? "your owner" : owner})`;
      return row.userId === ownerId ? `${owner} (your owner)` : `${owner} (person)`;
    },
  };
}

/** Days a node's conversation on its owner's AI plan is kept unused before it is dropped from the agent (subscriptions/turn-sessions.ts). */
export const NODE_SESSION_KEEP_DAYS = 7;

type Origin = { room: NodeRoom; privateTo: string[] | null };

/**
 * Where a node reports what its helper found: the thread it made the helper in (private when that
 * was), while it and its owner are still there; else its DM, privately.
 */
async function originOf(app: FastifyInstance, node: NodeAgent, room: NodeRoom): Promise<Origin | null> {
  if (room.kind !== "task" || node.parentNodeId) return null;
  const settings = (room.settings ?? {}) as { originRoomId?: unknown; originPrivateTo?: unknown };
  const prisma = app.prisma;
  const there = (id: string) =>
    prisma.nodeRoom.findFirst({
      where: { id, archivedAt: null, AND: [{ members: { some: { nodeId: node.id } } }, { members: { some: { nodeId: null, userId: node.userId } } }] },
    });
  const origin = typeof settings.originRoomId === "string" ? await there(settings.originRoomId) : null;
  if (origin) {
    const privateTo = Array.isArray(settings.originPrivateTo) && settings.originPrivateTo.length ? [node.userId] : null;
    return { room: origin, privateTo };
  }
  const dm = await prisma.nodeRoom.findFirst({ where: { kind: "dm", userId: node.userId, archivedAt: null, members: { some: { nodeId: node.id } } } });
  return dm ? { room: dm, privateTo: null } : null;
}

async function originLine(app: FastifyInstance, node: NodeAgent, room: NodeRoom): Promise<string> {
  const origin = await originOf(app, node, room);
  if (!origin) return "your owner";
  const shared = !origin.privateTo && (await roomPeople(app.prisma, origin.room.id)).some((id) => id !== node.userId);
  return `your owner in “${origin.room.title}”${origin.privateTo ? ", privately" : shared ? ", where other people read it too" : ""}`;
}

/** The node's thinking level, when its chat model takes one (none for AI plans on a computer). */
/**
 * A node thinks at medium unless its owner set its level (`ENSEMBLE_NODE_EFFORT` changes the default):
 * at low, gpt-5-mini announced work instead of doing it far more often (node-agent playground, 6 Nov 2026).
 */
async function turnEffort(owner: string, node: NodeAgent, provider: string, model: string, wanted?: string): Promise<string | undefined> {
  // On the owner's own AI plan: the level they chose for the node (checked against the plan's model on
  // the computer), else the agent's own default. No level of Ensemble's is imposed on their plan.
  if (isSubscriptionProvider(provider)) return wanted ?? node.effort ?? undefined;
  return effortToSend(owner, provider, model, wanted ?? node.effort ?? (process.env.ENSEMBLE_NODE_EFFORT?.trim() || "medium")).catch(() => undefined);
}

/** Whether the node leads one of its owner's crews (it plans their work). */
async function leadsACrew(prisma: PrismaClient, node: Pick<NodeAgent, "id" | "userId">): Promise<boolean> {
  const crews = await prisma.nodeRoom.findMany({ where: { userId: node.userId, kind: "crew", archivedAt: null, members: { some: { nodeId: node.id } } }, select: { settings: true } });
  return crews.some((room) => {
    const leads = (room.settings as { leadNodeIds?: unknown } | null)?.leadNodeIds;
    return Array.isArray(leads) && leads.includes(node.id);
  });
}


function chips(calls: AssistantToolCall[]): Array<Record<string, unknown>> {
  return calls.map((call) => ({ id: call.id, name: call.name, state: call.state, summary: call.summary ?? null, href: call.href ?? null, ...(call.refs?.length ? { refs: call.refs } : {}) }));
}

async function ownerNotice(app: FastifyInstance, node: NodeAgent, roomId: string, text: string, data: Record<string, unknown> = {}): Promise<void> {
  await postMessage(app.prisma, { roomId, userId: node.userId, authorKind: "node", authorNodeId: node.id, kind: "error", body: text, data, visibleTo: [node.userId] });
}

/** " ↪ #12 “its words”" when the message replies to another (Ask my nodes quotes a Room message this way). */
function replyMark(row: NodeMessage): string {
  const replyTo = (row.data as { replyTo?: { seq?: unknown; excerpt?: unknown } } | null)?.replyTo;
  if (typeof replyTo?.seq !== "number") return "";
  return ` ↪ #${replyTo.seq}${typeof replyTo.excerpt === "string" && replyTo.excerpt ? ` “${replyTo.excerpt}”` : ""}`;
}

/** Files a message carries (routes.ts stores them as data.files). */
function filesOf(row: NodeMessage): Array<{ id: string; name: string }> {
  const files = (row.data as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return [];
  return files.flatMap((file) => (file && typeof file === "object" && typeof (file as { id?: unknown }).id === "string" ? [{ id: String((file as { id: string }).id), name: String((file as { name?: unknown }).name ?? "file") }] : []));
}

/**
 * Runs one turn with its trace (node/trace.ts): every message it posts names it (node/turn-context.ts),
 * and once it chose a model its trace is saved when it ends, whatever the outcome.
 */
export async function runNodeTurn(app: FastifyInstance, turn: NodeTurn, deps: TurnDeps): Promise<TurnOutcome> {
  const trace = new TurnTrace(turn);
  return inTurn(turn, async (posted) => {
    let outcome: TurnOutcome | null = null;
    try {
      outcome = await takeTurn(app, turn, deps, trace);
      return outcome;
    } catch (error) {
      trace.failed(error);
      throw error;
    } finally {
      await saveTrace(app, trace, posted, outcome).catch((error: unknown) => app.log.error({ err: error, turnId: turn.id }, "Could not save the node turn's trace"));
    }
  });
}

async function takeTurn(app: FastifyInstance, turn: NodeTurn, deps: TurnDeps, trace: TurnTrace): Promise<TurnOutcome> {
  // The owner said they finished a sign-in this node waits for: its computer checks it first (node/login-check.ts).
  turn = await checkLoginOnDone(app, turn);
  const prisma = app.prisma;
  const node = await prisma.nodeAgent.findUnique({ where: { id: turn.nodeId } });
  if (!node || node.status !== "active" || !turn.roomId) return { status: "skipped" };
  const room = await prisma.nodeRoom.findUnique({ where: { id: turn.roomId } });
  if (!room || room.archivedAt) return { status: "skipped" };
  const members = await prisma.nodeRoomMember.findMany({ where: { roomId: room.id }, orderBy: { joinedAt: "asc" } });
  const self = members.find((row) => row.nodeId === node.id);
  const owner = node.userId;
  if (!self || !members.some((row) => !row.nodeId && row.userId === owner)) return { status: "skipped" };
  const user = await prisma.user.findUnique({ where: { id: owner }, select: { name: true, email: true, moduleSet: true } });
  if (!user) return { status: "skipped" };
  const ownerName = user.name?.trim() || user.email.split("@")[0]!;
  // v0: a node works in its owner's own space.
  const spaceId = owner;

  // Two threads per node and room: the shared one reads and answers only what everyone sees;
  // the owner's private thread reads everything the owner sees and answers only the owner.
  const thread = turn.private
    ? { privateTo: [owner] as string[] | null, cursor: self.privateSeenSeq, conversationId: self.privateConversationId, where: visibleWhere(owner) }
    : { privateTo: null as string[] | null, cursor: self.seenSeq, conversationId: self.conversationId, where: { visibleTo: { isEmpty: true } } };
  // A work turn (a plan step, or the node's own work) runs in its own lane: it never reads the room or
  // moves the room's cursor, so the conversation lane keeps answering the owner meanwhile.
  const work = Boolean(turn.planId && turn.planStep);
  const saveCursor = async (seq: number) => {
    if (!work) await prisma.nodeRoomMember.update({ where: { id: self.id }, data: turn.private ? { privateSeenSeq: seq } : { seenSeq: seq } });
  };
  const trigger = turn.triggerMessageId ? await prisma.nodeMessage.findUnique({ where: { id: turn.triggerMessageId } }) : null;
  if (trigger && (!canSee(trigger, owner) || (!turn.private && trigger.visibleTo.length > 0))) return { status: "skipped" };
  const fresh: NodeMessage[] = work
    ? []
    : await prisma.nodeMessage.findMany({
        where: { roomId: room.id, seq: { gt: thread.cursor }, ...thread.where },
        orderBy: { seq: "desc" },
        take: thread.cursor ? 40 : 20,
      });
  fresh.reverse();
  const readUpTo = fresh.reduce((max, row) => Math.max(max, row.seq), thread.cursor);
  const transcriptRows = fresh.filter((row) => row.authorNodeId !== node.id && (row.kind === "text" || row.kind === "status") && !(row.data as { deleted?: unknown } | null)?.deleted);
  if (!transcriptRows.length && !turn.note) {
    await saveCursor(readUpTo);
    return { status: "skipped" };
  }

  const tainted = (row: NodeMessage | null) => Boolean(row && (row.userId !== owner || (row.data as { fromNonOwner?: unknown } | null)?.fromNonOwner === true));
  // An approved disclosure drafts an answer to someone else's words: it reads with its owner's access and does nothing else (node/audience.ts).
  const drafting = turn.reason === "disclose";
  const fromNonOwner = drafting || (["run", "approval", "plan", "tool", "attention", "work"].includes(turn.reason) ? false : tainted(trigger));
  const step = turn.planId && turn.planStep ? { planId: turn.planId, stepId: turn.planStep } : null;
  // A step whose plan was stopped, or that already ended, does nothing more.
  if (step && !(await stepLive(prisma, step.planId, step.stepId))) {
    await saveCursor(readUpTo);
    return { status: "skipped" };
  }
  const privateTo = thread.privateTo;
  const lineage: Lineage = {
    rootMessageId: trigger ? (trigger.rootMessageId ?? (trigger.authorKind === "human" ? trigger.id : null)) : null,
    botDepth: (trigger?.botDepth ?? 0) + 1,
    fromNonOwner,
  };
  // A turn whose answer the room reads gets only room-safe context and tools (node/audience.ts).
  const bound = work ? null : await roomBoundTurn(app, { turn, node, room, members, trigger, rows: transcriptRows, ownerName, lineage });
  if (bound?.held) {
    await saveCursor(readUpTo);
    return { status: "skipped" };
  }

  const who = await namesFor(app, room, members, owner);
  // Files on the owner's messages are read with this turn (assistant/attachments.ts); a node works in its
  // owner's space, so another person's files are named but not opened.
  const attachedFiles = transcriptRows.flatMap((row) => (row.userId === owner && row.authorKind === "human" ? filesOf(row) : [])).slice(-MESSAGE_FILES_MAX);
  const fileNote = (row: NodeMessage) => {
    const files = filesOf(row);
    if (!files.length) return "";
    const names = files.map((file) => `“${file.name}”`).join(", ");
    // Where only the owner reads, their files can go onto their computer: said where they are, not in the instructions.
    if (row.userId === owner && row.authorKind === "human") return ` [attached ${names}${bound || fromNonOwner || work ? "" : "; onto the computer: node_save_attachment"}]`;
    return ` [attached ${names}, which you cannot open: they are in that person's Files]`;
  };
  const board = work || fromNonOwner || bound ? "" : await workBoard(prisma, node, room.id);
  const shown = bound?.rows ?? transcriptRows;
  const line = (row: NodeMessage) => `[#${row.seq} ${who.label(row)}${row.visibleTo.length ? " · private" : ""}${replyMark(row)}] ${truncateText(row.body, 4000)}${fileNote(row)}${fileQuoteContext(row.data)}`;
  // A node that was not called for a while gets a backlog: it is marked as context, apart from the message
  // it was called for, so it answers that one (a node once answered an old message instead of the new ask).
  const calledAt = trigger ? shown.findIndex((row) => row.id === trigger.id) : -1;
  const packet = packetSections({ work, note: turn.note, room: room.title, lines: shown.map(line), calledAt, board });
  const transcript = packetText(packet);

  const settings = await loadSettings(prisma, spaceId);
  const turnSettings = node.parentNodeId
    ? { ...settings, assistant: { ...settings.assistant, allowedWriteAreas: [], connectedAppWrites: false } }
    : fromNonOwner && settings.assistant.writePolicy === "immediate"
      ? { ...settings, assistant: { ...settings.assistant, writePolicy: "preview" as const } }
      : settings;
  // A crew's lead planning or reporting thinks with the lead model, unless its owner chose one (model.ts).
  const lead = !step && !node.parentNodeId && (Boolean(turn.planId && !turn.planStep) || (await leadsACrew(prisma, node))) ? leadChatModel(node) : null;
  const choice = lead?.pick ?? chatModelFor(node, settings);
  trace.begin("error" in choice ? null : choice);
  trace.step = Boolean(step);
  if ("error" in choice) {
    trace.error = choice.error;
    await ownerNotice(app, node, room.id, choice.error);
    await saveCursor(readUpTo);
    return { status: "failed", error: choice.error };
  }
  await setPlacement(app, turn.id, trace.placement);
  if (choice.provider === INCLUDED_PROVIDER) {
    try {
      await assertIncludedOpen(owner, choice.model);
    } catch (error) {
      if (!(error instanceof IncludedLimitError)) throw error;
      trace.error = error.message;
      await ownerNotice(app, node, room.id, error.message, { code: error.code });
      await saveCursor(readUpTo);
      return { status: "failed", error: error.message };
    }
  }

  // A work turn keeps its own conversation per step (across its attempts), apart from the room's.
  const stepRecord = step ? await stepRow(prisma, step.planId, step.stepId) : null;
  let conversationId = step ? (stepRecord?.conversationId ?? null) : thread.conversationId;
  if (!conversationId || !(await prisma.assistantConversation.findFirst({ where: { id: conversationId, userId: spaceId }, select: { id: true } }))) {
    const conversation = await prisma.assistantConversation.create({
      data: { userId: spaceId, accountId: null, startedOn: "node", title: truncateText(step ? `Node · ${node.name} · work` : `Node · ${node.name} · ${room.title}${turn.private ? " · private" : ""}`, 80) },
    });
    conversationId = conversation.id;
    if (step) await prisma.nodeStep.update({ where: { missionId_id: { missionId: step.planId, id: step.stepId } }, data: { conversationId } });
    else await prisma.nodeRoomMember.update({ where: { id: self.id }, data: turn.private ? { privateConversationId: conversationId } : { conversationId } });
  }
  const userRow = await prisma.assistantMessage.create({ data: { conversationId, userId: spaceId, role: "user", content: transcript } });

  const people = await roomPeople(prisma, room.id);
  const audience = privateTo ?? people;
  // Someone in the room asked for ids: the reply shows them as written.
  const showIds = transcriptRows.some((row) => row.authorKind === "human" && asksForIds(row.body));
  // Which thread the live reply belongs to: My crew (only its owner reads it) or the shared one, and its root message.
  const where = { private: Boolean(privateTo), threadRootId: lineage.rootMessageId };
  publishTo(audience, "node.status", { roomId: room.id, nodeId: node.id, state: "thinking", ...where });
  let result: AssistantTurnResult;
  /** Tools this turn ran: a turn that did something is never run again from the start. */
  let toolsRan = 0;
  const ownerOnly = (drafting || !fromNonOwner) && (Boolean(privateTo) || people.every((id) => id === owner));
  // The owner's own words in this turn: what its skills, tool tiers and answer check go by. A turn that
  // carries on work (an answered card, a run that ended) has none: web_task goes by their last words here.
  // The owner's words this turn answers: from the message it was called for on (the backlog is context).
  const calledFrom = trigger ? Math.max(0, transcriptRows.findIndex((row) => row.id === trigger.id)) : 0;
  const ownerWords = transcriptRows.slice(calledFrom).filter((row) => row.authorKind === "human" && row.userId === owner).map((row) => row.body).join("\n");
  const carriesOn = CARRIES_ON.has(turn.reason);
  const offered = draftingTools(
    turn,
    nodeTools({
      prisma,
      node,
      room,
      lineage,
      privateTo,
      ownerOnly,
      redis: app.redis as never,
      dispatch: deps.dispatch,
      turnId: turn.id,
      plan: turn.planId ? { planId: turn.planId, planStep: turn.planStep } : null,
      signal: deps.signal,
      ownerWords: ownerWords || step || fromNonOwner ? ownerWords : await ownerLastWords(prisma, room.id, owner, thread.where),
    }),
  );
  // A conversation turn offers the advanced browser and capture tools only for that work (node/skills.ts).
  // On the owner's own AI plan the agent is the loop: web_task's sub-agent would spend Ensemble's model, so it drives the browser itself.
  const ownLoop = isSubscriptionProvider(choice.provider);
  // What the owner asked this turn: it chooses the advanced tools, and the guides and their tools, not the packet around it.
  const intent = step || carriesOn ? "" : `${ownerWords}\n${turn.note ?? ""}`.trim();
  // A crew's lead, a node with helpers or other nodes beside it, a crew or task room or a plan's turn plans and delegates whatever the words.
  const crewWork = () =>
    Boolean(lead) ||
    room.kind === "crew" ||
    room.kind === "task" ||
    Boolean(turn.planId) ||
    prisma.nodeAgent.count({ where: { OR: [{ parentNodeId: node.id }, { userId: node.userId, status: "active", parentNodeId: null, id: { not: node.id } }] } }).then((count) => count > 0, () => true);
  const tiered = step || carriesOn ? offered : tieredTools(offered, intent, await recentTools(prisma, conversationId), { crew: await crewWork() });
  const extraTools = ownLoop ? tiered.filter((tool) => tool.name !== "web_task") : tiered;
  // The rest stay within reach on the owner's plan: hub_use_tool names them.
  const hiddenTools = offered.filter((tool) => tool.name !== "web_task" && !tiered.includes(tool));
  const gateway = nodeSpaceGateway(app, node, { homeSpaceId: turn.spaceId, reach: ownerOnly ? "all" : "home" });
  const offeredNames = new Set(extraTools.map((tool) => tool.name));
  const has = (name: string) => offeredNames.has(name) || Boolean(getTool(name));
  // On the owner's AI plan the agent keeps its own tools (a helper only with a computer grant) in a turn its owner started
  // and only they read: the computer judges each call by the node's folder policy, and what that asks goes to the owner
  // on a card here (node/own-tool-asks.ts). Any other turn (room-bound, another person's, a disclosure draft) can carry
  // another person's instructions, which no check of a command's text can contain: it has Ensemble's tools only.
  const ownTools = ownLoop && ownerOnly && !fromNonOwner && !bound && (!node.parentNodeId || helperGrant(node) === "computer");
  const plan = turn.planId ? { planId: turn.planId, planStep: turn.planStep } : null;
  const ownPolicy: NodeTurnPolicy | null = ownTools
    ? {
        id: node.id,
        slug: node.slug,
        mission: missionOf({ plan, room, privateTo }),
        // A routine's work, or a run profile that runs unattended: nobody watches, so everything above the floor runs.
        attended: !(turn.planId && (await prisma.nodeMission.findUnique({ where: { id: turn.planId }, select: { routine: true } }))?.routine) && (await modeFor(prisma, node)).attended,
        sudo: extraTools.some((tool) => tool.name === "computer_sudo"),
        // A helper given folders works only in them; one given none works as its parent does (node/helpers.ts).
        ...(node.parentNodeId && helperFolders(node).length ? { folders: helperFolders(node) } : {}),
      }
    : null;
  // A turn the room reads keeps its room-bound persona (node/audience.ts); any other is assembled from packages/prompts.
  const roomBound = bound ? await bound.persona() : null;
  const instructionsInput = {
    node,
    room,
    members,
    ownerName,
    fromNonOwner,
    ownerOnly,
    step: Boolean(step),
    // The skills, memories and workspace items for this turn are chosen from these (node/instructions.ts).
    turn,
    words: ownerWords,
    has,
    conversationId,
    modules: user.moduleSet,
    origin: room.kind === "task" && !node.parentNodeId ? await originLine(app, node, room) : null,
    packet,
  };
  // With its own tools, also the stable tier for a computer that runs the turn with Ensemble's tools only (`stableWithoutOwnTools`).
  const instructions = roomBound ? null : await nodeInstructions(app, { ...instructionsInput, provider: choice.provider, ownTools });
  const assembled = instructions?.log ?? codeBuiltLog(roomBound!.text, packet);
  trace.instructions = assembled;
  // Every section the turn was given, once per turn; each of its model calls names only their version and hashes.
  await recordMetric(prisma, { userId: owner, kind: "node.instructions", meta: { turnId: turn.id, nodeId: node.id, ...assembled } }).catch((error: unknown) =>
    app.log.error({ err: error }, "Could not record the node's instructions"),
  );
  // A fallback model on another loop (Ensemble's, after the owner's plan) gets its own instructions: never the agent's own shell.
  const instructionsFor = async (pick: ChatModel): Promise<NodeInstructions | null> =>
    !instructions || isSubscriptionProvider(pick.provider) === ownLoop ? instructions : nodeInstructions(app, { ...instructionsInput, provider: pick.provider, ownTools: false });
  // What the owner asked for is checked against the reply before it is posted (node/deliverables.ts). On the owner's own AI
  // plan, only with a checklist model to check with (the fast one; none, or ENSEMBLE_NODE_CHECKLIST_MODEL=off: not checked).
  const checklistBy = checklistModel(node, settings);
  const deliverables =
    !step && !bound && !drafting && !fromNonOwner && ownerOnly && !node.parentNodeId && room.kind !== "task" && ownerWords.trim() && (!ownLoop || (checklistBy && checklistModelOn()))
      ? startDeliverables(app, { ownerId: owner, turnId: turn.id, text: ownerWords, model: checklistBy, activityId: `assistant:${conversationId}`, signal: deps.signal })
      : null;
  const verifyFor = (pick: ChatModel) =>
    deliverables
      ? async (state: VerifyState) => {
          const feedback = await deliverables.verify(state);
          // On the owner's plan each round is another run of their agent: only a request that asks for something on the checklist is checked.
          if (isSubscriptionProvider(pick.provider) && !deliverables.checks.length) return null;
          trace.checked(state.round, feedback, deliverables.checks, state.final);
          return feedback;
        }
      : undefined;
  /** Where the reply goes (in a helper's room: to its owner where it made the helper) and whether only the owner reads it there. */
  let target: Promise<{ room: NodeRoom; privateTo: string[] | null; ownerReads: boolean }> | null = null;
  const replyTarget = () =>
    (target ??= (async () => {
      const origin = await originOf(app, node, room);
      const replyRoom = origin?.room ?? room;
      const replyPrivateTo = origin ? origin.privateTo : privateTo;
      const single = !(await roomPeople(prisma, replyRoom.id)).some((id) => id !== owner);
      return { room: replyRoom, privateTo: replyPrivateTo, ownerReads: single || Boolean(replyPrivateTo) };
    })());
  // What the reply says it sent into the chat, against what reaches it with this turn: files show with a reply only where only the
  // owner reads it, and a lead's report brings its plan's checked media (node/delivery-claims.ts).
  const claims =
    !step && !drafting
      ? async (state: ClaimState) => {
          const shown = (await replyTarget()).ownerReads ? [...peekTurnMedia(turn.id), ...(turn.planId ? await missionMedia(prisma, turn.planId, owner) : [])] : [];
          return checkDelivery(state.text, deliveredWith([...shown, ...heldCaptures(state.calls.map((row) => row.result))], state.text));
        }
      : undefined;
  const ask = async (pick: ChatModel): Promise<AssistantTurnResult> => {
    const effort = await turnEffort(owner, node, pick.provider, pick.model, lead && pick === lead.pick ? lead.effort : undefined);
    trace.sending(pick, effort);
    const given = await instructionsFor(pick);
    return (bound ? bound.run : runAssistantTurn)({
      app,
      userId: spaceId,
      conversationId: conversationId!,
      message: transcript,
      // Only where the owner's own words started it: a draft for someone else or a room-bound turn keeps the packet's routing.
      ...(intent && !drafting && !bound && !fromNonOwner ? { routeBy: intent } : {}),
      coreTools: NODE_CORE_TOOLS,
      messageId: userRow.id,
      ...(attachedFiles.length ? { mentions: attachedFiles.map((file) => ({ kind: "file" as const, id: file.id, label: file.name })) } : {}),
      settings: turnSettings,
      model: pick.model,
      provider: pick.provider,
      reasoningEffort: effort,
      requestHeaders: internalHeaders(spaceId),
      modules: user.moduleSet,
      ...(given ? { nodeInstructions: given } : { agentPersona: roomBound!.text }),
      instructionsRef: given?.log ?? assembled,
      extraRefs: given?.refs ?? roomBound!.rooms,
      withoutTools: NODE_REPLACED_TOOLS,
      spaces: gateway,
      // The node's own versions of Hub tools (hub_save_file with a path) take a space like the rest.
      extraTools: (isSubscriptionProvider(pick.provider) ? extraTools : tiered).map((tool) => (tool.name.startsWith("hub_") ? gateway.wrap([tool])[0]! : tool)),
      ...(isSubscriptionProvider(pick.provider) && hiddenTools.length ? { hiddenTools: hiddenTools.map((tool) => (tool.name.startsWith("hub_") ? gateway.wrap([tool])[0]! : tool)) } : {}),
      ...(deliverables ? { verify: verifyFor(pick) } : {}),
      ...(claims ? { claims } : {}),
      onRewrite() {
        // The reply goes back for more work (a check sent it back, or the owner's agent is asked again): it starts again on the website.
        publishTo(audience, "node.status", { roomId: room.id, nodeId: node.id, state: "idle", ...where });
        publishTo(audience, "node.status", { roomId: room.id, nodeId: node.id, state: "thinking", ...where });
      },
      purpose: "Ensemble Node",
      // The owner's own AI plan: the node's project folder groups its conversations (and folder-less coding sessions) in the agent's app.
      ...(isSubscriptionProvider(pick.provider)
        ? {
            subscription: {
              node: true,
              group: { id: node.id, name: `${node.name} (Ensemble Node)` },
              keepDays: NODE_SESSION_KEEP_DAYS,
              ...(ownPolicy && given?.withoutOwnTools
                ? {
                    ownTools: true,
                    stableWithoutOwnTools: given.withoutOwnTools.stable,
                    nodeTools: {
                      policy: ownPolicy,
                      ask: ownToolAsker(app, { node, room, privateTo, lineage, turnId: turn.id, plan }),
                      onOwnTool(event: OwnToolEvent) {
                        // From the first own call that can change something, the turn is not run again from the start.
                        if (event.phase === "start") {
                          if (event.acts) void markActed(app, turn.id).catch(() => undefined);
                          return;
                        }
                        toolsRan += 1;
                        trace.loop.calls.push(ownCallTrace(event));
                        const state = event.ok === false ? "failed" : "ok";
                        void addReceipt(app, turn.id, { name: event.name, state, summary: event.summary || null }).catch(() => undefined);
                        // The agent's own calls show to its owner only, like Ensemble's tool chips.
                        publishTo([owner], "node.frame", { roomId: room.id, nodeId: node.id, turnId: turn.id, ...where, frame: { type: "tool", call: { id: event.id, name: event.name, state, ...(event.summary ? { summary: event.summary } : {}) } } });
                      },
                      parking: () => parkedFor(turn.id)[0] ?? null,
                      park: () => parkIfAsked(turn.id),
                    },
                  }
                : {}),
            },
          }
        : {}),
      trace: trace.loop,
      signal: deps.signal,
      async onToolStart(call) {
        // From the first tool that changes something, the turn is not aborted to merge a newer message.
        if (actsOnTheWorld(call)) await markActed(app, turn.id);
      },
      emit(frame) {
        if (frame.type === "tool" || frame.type === "pending") {
          toolsRan += 1;
          void addReceipt(app, turn.id, { name: frame.call.name, state: String(frame.call.state ?? "ok"), summary: frame.call.summary ?? null }).catch(() => undefined);
          // A tool asked to park the turn (its owner has a card to answer): it stops once this step's calls have run.
          parkIfAsked(turn.id);
        }
        // A step's words are its report, not a message: nothing is written out live.
        if (step && frame.type === "delta") return;
        if (frame.type === "delta" || frame.type === "tool" || frame.type === "pending" || frame.type === "refs") {
          publishTo([owner], "node.frame", { roomId: room.id, nodeId: node.id, turnId: turn.id, ...where, frame, ...(showIds ? { showIds } : {}) });
        }
      },
    });
  };
  // A conversation turn the model's rate limit cuts off before it ran a tool tries the fast model once,
  // so the owner still gets an answer; work turns wait and try again later.
  const fallback = work ? null : fastChatModel(settings);
  const picks: ChatModel[] = [choice, ...(fallback && (fallback.model !== choice.model || fallback.provider !== choice.provider) ? [fallback] : [])];
  let failure: unknown = null;
  for (const [index, pick] of picks.entries()) {
    try {
      result = await ask(pick);
      failure = null;
      break;
    } catch (error) {
      failure = error;
      const limited = error instanceof RuntimeError && error.kind === "rate_limit";
      if (!(limited && !toolsRan && !deps.signal?.aborted && index < picks.length - 1)) break;
      app.log.warn({ nodeId: node.id, model: pick.model }, "Node turn rate-limited; answering with the fallback model");
    }
  }
  publishTo(audience, "node.status", { roomId: room.id, nodeId: node.id, state: "idle", ...where });
  if (!failure) trace.answered(result!);
  if (deps.signal?.aborted && deps.signal.reason === "coalesce") {
    // A newer message from the owner came before this turn acted: the next turn answers both, so this one leaves no trace.
    await prisma.assistantMessage.delete({ where: { id: userRow.id } }).catch(() => undefined);
    return { status: "coalesced" };
  }
  if (deps.signal?.aborted && deps.signal.reason === "withdrawn") {
    // What it was told about was taken away before it did anything (node/task-assignment.ts): it leaves no trace.
    await prisma.assistantMessage.delete({ where: { id: userRow.id } }).catch(() => undefined);
    return { status: "skipped", error: "Taken away before it did anything." };
  }
  if ((deps.signal?.aborted && deps.signal.reason === "park") || parkedFor(turn.id).length) {
    // Waiting for its owner's answer on a card in the chat: the turn ends here and posts nothing (an agent on the
    // owner's plan told to stop ends its turn by itself). What it did and what it waits for stay in its
    // conversation; the answer wakes it.
    const done = failure ? null : result!;
    const calls = done?.toolCalls ?? [];
    const waits = parkedFor(turn.id).join("\n") || `Waiting for ${ownerName} to answer a card in this chat.`;
    await prisma.assistantMessage.create({
      data: { conversationId: conversationId!, userId: spaceId, role: "assistant", content: waits, toolCalls: calls as never, model: done?.model ?? null, credentialSource: done?.credentialSource, credits: done?.credits ?? undefined },
    });
    await prisma.assistantConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
    await saveCursor(readUpTo);
    const parkedHeld = calls.filter((call) => call.state === "awaiting_approval");
    if (parkedHeld.length) await holdCalls(app, node, room, conversationId, fromNonOwner, turn.private, lineage, parkedHeld, turn.planId ? { plan: { id: turn.planId, step: turn.planStep } } : {});
    if (step) {
      if (await stepLive(prisma, step.planId, step.stepId)) await stepProgress(prisma, step.planId, step.stepId, `Waiting for ${ownerName}'s answer on a card in the chat.`);
    } else if (!turn.planId) {
      // A plan this turn made starts; its card opens without a reply.
      const made = await currentPlan(prisma, node.id, turn.id, null);
      if (made?.data.status === "draft") await startPlan(app, made.message.id, null);
    }
    return { status: "parked", model: done?.model, credits: done?.credits ?? null };
  }
  if (failure) {
    const error = failure;
    const aborted = deps.signal?.aborted || (error instanceof Error && error.name === "AbortError");
    if (!aborted && !toolsRan && error instanceof RuntimeError && error.kind === "rate_limit" && mayRetry(turn) && !(await madePlan(prisma, node.id, turn.id))) {
      // Tried again later in full: this try leaves no trace in the room or the conversation.
      await prisma.assistantMessage.delete({ where: { id: userRow.id } }).catch(() => undefined);
      return { status: "retry", error: error.message };
    }
    const shown = aborted ? "Stopped." : error instanceof IncludedLimitError ? error.message : safePublicError(error, "The model could not answer. Nothing was changed.");
    trace.error = shown;
    result = { failed: true, content: shown, toolCalls: [], model: choice.model, credits: null, mutated: false, interrupted: aborted };
  }
  result = result!;

  await persistAssistantText(
    async (content) => {
      await prisma.assistantMessage.create({
        data: {
          conversationId: conversationId!,
          userId: spaceId,
          role: result.failed ? "error" : "assistant",
          content,
          toolCalls: result.toolCalls as never,
          ...(result.refs?.length && !result.failed ? { mentions: result.refs as never } : {}),
          model: result.failed ? null : result.model,
          credentialSource: result.credentialSource,
          credits: result.credits ?? undefined,
        },
      });
    },
    result.content || "The node did not produce a reply.",
    (error) => app.log.error({ err: error }, "Could not save a node reply"),
  );
  await prisma.assistantConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
  await saveCursor(readUpTo);

  if (result.interrupted && !result.failed) {
    // Stopped by the owner (Stop, pause, a plan's Stop): a step ends stopped, a plan this turn was making stops,
    // and only a DM says what was done before the stop.
    if (step) await finishStep(app, step.planId, step.stepId, { status: "stopped", result: "Stopped." });
    const made = turn.planId ? null : await currentPlan(prisma, node.id, turn.id, null);
    if (made?.data.status === "draft") await stopPlans(app, { planId: made.message.id, userId: owner });
    if (turn.planId && !turn.planStep) await afterReport(app, turn.planId);
    // The stop already said so in a status line: a DM hears more only when the turn had done something.
    if (!step && room.kind === "dm" && result.toolCalls.length) {
      const said = cleanReply(result.content.replace(/\n*Stopped before finishing\.\s*$/i, ""), true);
      if (said && said !== NO_REPLY) await postAsNode({ prisma, node, lineage, dispatch: deps.dispatch }, room, said, privateTo);
    }
    return { status: "cancelled", model: result.model, credits: result.credits };
  }
  if (result.failed) {
    // A step that failed ends as blocked (or stopped) on its plan, which its lead reports; no notice in the room.
    // A failed turn after it started a run leaves the step to that run.
    if (step && result.interrupted) await finishStep(app, step.planId, step.stepId, { status: "stopped", result: "Stopped." });
    else if (step && (await stepPending(prisma, step.planId, step.stepId))) await stepProgress(prisma, step.planId, step.stepId, "Waiting for its agent run.");
    else if (step) await finishStep(app, step.planId, step.stepId, { status: "blocked", result: `@${node.slug} could not do its step: ${result.content}` });
    else {
      // What the turn captured before it failed still reaches its owner (where only they read).
      const captured = !result.interrupted && room.kind !== "task" ? takeTurnMedia(turn.id) : [];
      const ownerReads = Boolean(privateTo) || !(await roomPeople(prisma, room.id)).some((id) => id !== owner);
      if (captured.length && ownerReads) {
        await postAsNode({ prisma, node, lineage, dispatch: deps.dispatch }, room, "", privateTo, { data: { media: captured.slice(0, 8) } });
        trace.delivered(captured.slice(0, 8));
      }
      // A stop or a pause already said so; only a real failure needs a notice.
      if (!result.interrupted) await ownerNotice(app, node, room.id, result.content);
      // Steps the lead added before its turn failed still run; a stopped turn's plan stops with it.
      const made = turn.planId ? null : await currentPlan(prisma, node.id, turn.id, null);
      if (made?.data.status === "draft") {
        if (result.interrupted) await stopPlans(app, { planId: made.message.id, userId: owner });
        else await startPlan(app, made.message.id, null);
      }
      if (turn.planId && !turn.planStep) await afterReport(app, turn.planId);
    }
    return { status: "failed", model: result.model, credits: result.credits, error: result.content };
  }
  const held = result.toolCalls.filter((call) => call.state === "awaiting_approval");
  const planTag = turn.planId ? { plan: { id: turn.planId, step: turn.planStep } } : {};

  if (step) {
    // A step reports with node_step_report. A reply in prose is not a result: the worker is asked once
    // to report, then the attempt ends unverified. Runs or cards still to come back wake it again.
    const report = cleanReply(result.content, true);
    const said = report && report !== NO_REPLY ? report : "";
    if (await stepLive(prisma, step.planId, step.stepId)) {
      const runs = await stepRuns(prisma, step.planId, step.stepId);
      const cards = await stepCardsWaiting(prisma, step.planId, step.stepId);
      const mission = await prisma.nodeMission.findUnique({ where: { id: step.planId }, select: { contract: true } });
      if (result.paused) {
        // Paused at the loop's checkpoint (docs/11, Turn limits): the step is not done and stays working. The pause
        // leads its progress, so the plan card and the lead's work board show it however long the reply is.
        const pause = pauseQuestion(result.paused.steps);
        const rest = said.replace(pause, "").trim();
        await stepProgress(prisma, step.planId, step.stepId, rest && rest !== NO_REPLY ? `${pause} ${rest}` : pause);
      } else if (runs.pending || held.length || cards) {
        if (said) await stepProgress(prisma, step.planId, step.stepId, said);
      } else if ((mission?.contract ?? 3) < 3) {
        await finishStep(app, step.planId, step.stepId, said ? { status: "done", result: said } : { status: "blocked", result: `@${node.slug} ended its step without a report.` });
      } else if (!stepRecord?.nudged && (await nudgeStep(app, step.planId, step.stepId))) {
        if (said) await stepProgress(prisma, step.planId, step.stepId, said);
      } else {
        await finishStep(app, step.planId, step.stepId, { status: "blocked", outcome: "unverified", result: said ? `Not reported (prose only): ${said}` : `@${node.slug} ended its step without a report.` });
      }
    }
    if (held.length) await holdCalls(app, node, room, conversationId, fromNonOwner, turn.private, lineage, held, planTag);
    return { status: "done", model: result.model, credits: result.credits };
  }

  // In its helper's room a node's reply goes to its owner, where it made the helper.
  const { room: replyRoom, privateTo: replyPrivateTo, ownerReads } = await replyTarget();
  const text = cleanReply(result.content, ownerReads);
  const scope = { prisma, node, lineage, dispatch: deps.dispatch };
  // A plan this turn made opens with this reply, as one card, when it is in the same conversation.
  const made = turn.planId ? null : await currentPlan(prisma, node.id, turn.id, null);
  const opensPlan = Boolean(made && made.data.status === "draft" && made.message.roomId === replyRoom.id && made.message.visibleTo.join() === (replyPrivateTo ?? []).join());
  if (made && made.data.status === "draft") await startPlan(app, made.message.id, opensPlan && text !== NO_REPLY ? text : null);
  // Files shown with the reply: what the node chose (node_show), and a plan's checked media in its report.
  // Only where only the owner reads, like tool chips: sharing them with others is the owner's own act.
  const media: Media[] = takeTurnMedia(turn.id);
  if (ownerReads && turn.planId && !turn.planStep && text && text !== NO_REPLY) {
    for (const item of await missionMedia(prisma, turn.planId, owner)) if (!media.some((row) => row.evidenceId === item.evidenceId)) media.push(item);
  }
  const mediaData = media.length && ownerReads ? { media: media.slice(0, 8) } : {};
  // An answer the owner agreed to share reaches the room only as their draft (node/audience.ts).
  const drafted = text && text !== NO_REPLY && !opensPlan ? await draftDisclosure(app, { turn, node, room, text, lineage }) : false;
  if (mediaData.media && !drafted) trace.delivered(mediaData.media);
  if (text && text !== NO_REPLY && !opensPlan && !drafted) {
    // Tool chips name the owner's workspace items: shown only where nobody else reads. `refs` are only
    // the records the reply itself names by id, so their titles show in place of the ids.
    const toolData = ownerReads ? { tools: chips(result.toolCalls.filter((call) => call.state !== "awaiting_approval")) } : {};
    // A reply to a task given to the node names that task (node/task-assignment.ts).
    const given = await taskReplyData(prisma, turn);
    const refs = [...(result.refs ?? []), ...(given && !result.refs?.some((ref) => ref.kind === "task" && ref.id === given.task.id) ? [given.ref] : [])];
    const named = refs.length ? { refs } : {};
    const posted = await postAsNode(scope, replyRoom, text, replyPrivateTo, { data: { ...toolData, ...named, ...(given ? { task: given.task } : {}), ...(showIds ? { showIds } : {}), ...(bound?.replyData ?? {}), ...mediaData }, ...(bound ? { roomBound: room.id } : {}) });
    await bound?.afterReply(posted);
  } else if (mediaData.media && !drafted) {
    // Files chosen with nothing to say (or a reply that opened a plan) still reach the owner, on their own.
    await postAsNode(scope, replyRoom, "", replyPrivateTo, { data: mediaData });
  }
  if (held.length) await holdCalls(app, node, room, conversationId, fromNonOwner, turn.private, lineage, held, planTag);
  // The lead's report turn: the plan is done, unless it added steps (they start now).
  if (turn.planId && !turn.planStep) await afterReport(app, turn.planId);
  return { status: "done", model: result.model, credits: result.credits };
}

/** One owner-only card with the writes a turn held for approval. */
async function holdCalls(
  app: FastifyInstance,
  node: NodeAgent,
  room: NodeRoom,
  conversationId: string,
  fromNonOwner: boolean,
  isPrivate: boolean,
  lineage: Lineage,
  held: AssistantToolCall[],
  planTag: Record<string, unknown>,
): Promise<void> {
  await postMessage(app.prisma, {
    roomId: room.id,
    userId: node.userId,
    authorKind: "node",
    authorNodeId: node.id,
    kind: "approval",
    body: held.map((call) => call.summary || call.name).join("\n"),
    data: {
      type: "tools",
      status: "pending",
      conversationId,
      fromNonOwner,
      private: isPrivate,
      ...planTag,
      calls: held.map((call) => ({ callId: call.id, name: call.name, summary: call.summary ?? call.name, input: call.input ?? {} })),
    },
    visibleTo: [node.userId],
    rootMessageId: lineage.rootMessageId,
    botDepth: lineage.botDepth,
  });
}
