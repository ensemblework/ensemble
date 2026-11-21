/**
 * Who speaks after a message in an Ensemble Node room (docs/35 §4). Pure: the caller loads the
 * room, its nodes and the recent tail, and enqueues a turn for each node returned.
 *
 *   - Cards and system lines never wake anyone.
 *   - A node sees only what its owner may see, so a private message wakes only that person's nodes.
 *   - In a crew one node answers a person: the one node they mention, else the lead, which
 *     coordinates the others through a plan (node/plans.ts). Nodes' messages there wake nobody.
 *   - In a room with other people (rooms v2, docs/35 §12): public talk is people and their leads.
 *     Only a mention wakes a node; only leads answer in public, as room-bound turns; a person's own
 *     other nodes answer them privately (My crew); another person's other node is answered by that
 *     person's lead; `@leads status` is a card built by code; nodes' messages wake nobody.
 *   - Elsewhere a node's message wakes only the nodes it mentions, under two brakes: consecutive
 *     node messages in the room, and the depth of the bot chain under one person's message.
 *   - A person's message wakes the nodes it mentions; mentioning only people wakes nobody;
 *     otherwise the DM's node.
 *
 * The brakes and fan-outs are the heuristics config's (node/heuristics.ts); the caller passes the active
 * one and records each decision with `routeRecord` (node_decisions, kind `route`).
 */
import { DEFAULT_NODE_HEURISTICS, type RouterBrakes } from "./heuristics.js";
import type { Mention } from "./mentions.js";

export const MAX_BOT_STREAK = DEFAULT_NODE_HEURISTICS.router.botStreak;
export const MAX_BOT_DEPTH = DEFAULT_NODE_HEURISTICS.router.botDepth;
export const MAX_HUMAN_FANOUT = DEFAULT_NODE_HEURISTICS.router.humanFanout;
export const MAX_NODE_FANOUT = DEFAULT_NODE_HEURISTICS.router.nodeFanout;

export type RouteMessage = {
  kind: string;
  authorKind: "human" | "node" | "system";
  authorNodeId: string | null;
  /** The author's account: the person, or the node's owner. */
  authorId?: string;
  /** The message's words: `@leads status` is recognised from them. */
  text?: string;
  visibleTo: readonly string[];
  mentions: readonly Mention[];
  botDepth: number;
};

export type RouteRoom = { kind: "dm" | "crew" | "room" | "task"; leadNodeIds: readonly string[] };
export type RouteNode = { id: string; ownerId: string; active: boolean; representative: boolean; role: string; handle?: string };

/** One turn to start: which node, in which thread, for whom it answers. */
export type RouteTarget = {
  nodeId: string;
  /** The owner's private thread (My crew) rather than the shared one. */
  private: boolean;
  /** room: everyone in the room reads the answer, so the turn is room-bound (node/audience.ts). */
  audience: "owner" | "room";
  /** A hint for the turn, for example that another node was named and only leads answer in public. */
  note?: string;
};

/**
 * `capped`: nodes the message named that the fan-out left out (the heuristics' `humanFanout` or
 * `nodeFanout`), only when there were some.
 */
export type RouteDecision =
  | { reason: "mentioned" | "dm" | "lead"; nodeIds: string[]; targets?: RouteTarget[]; capped?: number }
  | { reason: "status"; nodeIds: [] }
  | { reason: "none"; nodeIds: []; brake?: "streak" | "depth" };

const none = (brake?: "streak" | "depth"): RouteDecision => ({ reason: "none", nodeIds: [], ...(brake ? { brake } : {}) });

/** At most `limit` of the named nodes, with how many were left out when any were. */
function upTo<T>(items: readonly T[], limit: number): { kept: T[]; capped?: number } {
  const kept = items.slice(0, limit);
  return items.length > kept.length ? { kept, capped: items.length - kept.length } : { kept };
}

/**
 * `@leads status`, and the same with punctuation ("@leads, status?", "@Leads: status!"): nothing else.
 * In a room with other people it is answered by code with every person's status card, without a model.
 */
export function leadsStatus(text: string): boolean {
  return /^\s*@leads\b[\s,:;.!?\u2013\u2014-]*status\s*[?!.]*\s*$/i.test(text);
}

/** Node messages at the end of the room (newest first), not counting cards. */
export function botStreak(recentNewestFirst: ReadonlyArray<{ authorKind: string; kind: string }>): number {
  let count = 0;
  for (const row of recentNewestFirst) {
    if (row.kind !== "text") continue;
    if (row.authorKind !== "node") break;
    count += 1;
  }
  return count;
}

/**
 * Rooms v2 (docs/35 §12): a room with other people. Unaddressed messages wake nobody; a lead answers
 * in public only when it is mentioned; a person's own other nodes answer them in private.
 */
function roomRoute(message: RouteMessage, nodes: readonly RouteNode[], stewards: readonly string[], brakes: RouterBrakes): RouteDecision {
  if (message.authorKind !== "human") return none();
  if (leadsStatus(message.text ?? "")) return { reason: "status", nodeIds: [] };
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const leadOf = (ownerId: string) => nodes.find((node) => node.ownerId === ownerId && node.representative);
  const named = message.mentions.filter((row) => row.kind === "node").map((row) => byId.get(row.id)).filter((node): node is RouteNode => Boolean(node));
  const targets: RouteTarget[] = [];
  const add = (target: RouteTarget) => {
    const same = targets.find((row) => row.nodeId === target.nodeId && row.private === target.private);
    if (!same) targets.push(target);
    else if (target.note) same.note = [same.note, target.note].filter(Boolean).join("\n");
  };

  if (message.visibleTo.length) {
    // My crew: only the person's own nodes, in private. Their lead answers unless they named their own node.
    const own = (node: RouteNode) => message.visibleTo.includes(node.ownerId) && node.active;
    const picked = named.filter(own);
    if (picked.length) {
      const { kept, capped } = upTo(picked, brakes.humanFanout);
      const ids = kept.map((node) => node.id);
      return { reason: "mentioned", nodeIds: ids, targets: ids.map((nodeId) => ({ nodeId, private: true, audience: "owner" })), ...(capped ? { capped } : {}) };
    }
    const lead = message.authorId ? leadOf(message.authorId) : undefined;
    return lead && own(lead) ? { reason: "lead", nodeIds: [lead.id], targets: [{ nodeId: lead.id, private: true, audience: "owner" }] } : none();
  }

  for (const node of named) {
    if (node.representative) {
      if (node.active) add({ nodeId: node.id, private: false, audience: "room" });
    } else if (stewards.includes(node.id)) {
      // The room's steward answers whoever named it, in public, for them (node/steward.ts).
      if (node.active) add({ nodeId: node.id, private: false, audience: "room" });
    } else if (node.ownerId === message.authorId) {
      // The person's own other node answers them in My crew, never in public.
      if (node.active) add({ nodeId: node.id, private: true, audience: "owner" });
    } else {
      const lead = leadOf(node.ownerId);
      if (lead?.active) {
        add({
          nodeId: lead.id,
          private: false,
          audience: "room",
          note: `@${node.handle ?? "a node"} (your owner's node) was named in this message. Only leads answer in public, so you answer for your owner; @${node.handle ?? "it"} does not.`,
        });
      }
    }
  }
  const { kept, capped } = upTo(targets, brakes.humanFanout);
  return kept.length ? { reason: "mentioned", nodeIds: kept.map((row) => row.nodeId), targets: kept, ...(capped ? { capped } : {}) } : none();
}

export function whoSpeaks(message: RouteMessage, room: RouteRoom, nodes: readonly RouteNode[], streak: number, brakes: RouterBrakes = DEFAULT_NODE_HEURISTICS.router): RouteDecision {
  if (message.kind !== "text" || message.authorKind === "system") return none();
  const eligible = nodes.filter(
    (node) => node.active && node.id !== message.authorNodeId && (message.visibleTo.length === 0 || message.visibleTo.includes(node.ownerId)),
  );
  // In a room with other people `leadNodeIds` holds only its steward, if it has one.
  if (room.kind === "room") return roomRoute(message, nodes.filter((node) => node.id !== message.authorNodeId), room.leadNodeIds, brakes);
  const eligibleIds = new Set(eligible.map((node) => node.id));
  const mentioned = message.mentions.filter((row) => row.kind === "node" && eligibleIds.has(row.id)).map((row) => row.id);

  if (message.authorKind === "node") {
    if (room.kind === "crew") return none();
    // A helper's room is nodes only: the depth limit (reset by each owner message) is its brake.
    if (room.kind !== "task" && streak >= brakes.botStreak) return none("streak");
    if (message.botDepth >= brakes.botDepth) return none("depth");
    if (!mentioned.length) return none();
    const { kept, capped } = upTo(mentioned, brakes.nodeFanout);
    return { reason: "mentioned", nodeIds: kept, ...(capped ? { capped } : {}) };
  }

  const lead = room.leadNodeIds.find((id) => eligibleIds.has(id));
  if (room.kind === "crew") {
    if (mentioned.length === 1) return { reason: "mentioned", nodeIds: mentioned };
    // Talking only to people (or only to nodes that cannot answer) wakes nobody.
    if (!mentioned.length && message.mentions.length) return none();
    if (!eligible.length) return none();
    const pick = lead ?? eligible.find((node) => node.role === "manager")?.id ?? eligible[0]!.id;
    return { reason: "lead", nodeIds: [pick] };
  }
  if (mentioned.length) {
    const { kept, capped } = upTo(mentioned, brakes.humanFanout);
    return { reason: "mentioned", nodeIds: kept, ...(capped ? { capped } : {}) };
  }
  if (message.mentions.length) return none();
  if (!eligible.length) return none();
  if (room.kind === "dm") return { reason: "dm", nodeIds: [eligible[0]!.id] };
  return lead ? { reason: "lead", nodeIds: [lead] } : none();
}

/** The message as a routing decision records it: who wrote it, where, whom it names and what it answers; never its words. */
export type RouteInput = RouteMessage & { id: string; roomId: string; replyTo?: { id?: unknown; seq?: unknown; authorKind?: unknown } | null };

/**
 * A routing decision as `node_decisions` keeps it (kind `route`): the inputs the rules read (the message's
 * author, mentions and reply, the room's kind and leads, the nodes that could answer and the brakes'
 * state) and the choice (the reason, the nodes woken in which thread, a brake or a cap). No model decides
 * routing, so it is never ambiguous and has no scores. The caller adds each woken node's turn.
 */
export function routeRecord(message: RouteInput, room: RouteRoom, nodes: readonly RouteNode[], streak: number, brakes: RouterBrakes, decision: RouteDecision) {
  const replyTo = message.replyTo && typeof message.replyTo === "object" ? message.replyTo : null;
  const inputs = {
    messageId: message.id,
    roomId: message.roomId,
    roomKind: room.kind,
    author: { kind: message.authorKind, ...(message.authorNodeId ? { nodeId: message.authorNodeId } : {}) },
    private: message.visibleTo.length > 0,
    mentions: message.mentions.map((row) => ({ kind: row.kind, id: row.id })),
    replyTo: replyTo ? { ...(typeof replyTo.id === "string" ? { id: replyTo.id } : {}), ...(typeof replyTo.seq === "number" ? { seq: replyTo.seq } : {}), ...(typeof replyTo.authorKind === "string" ? { authorKind: replyTo.authorKind } : {}) } : null,
    leadNodeIds: [...room.leadNodeIds],
    nodes: nodes.map((node) => ({ id: node.id, active: node.active, ...(node.representative ? { lead: true } : {}), ...(message.authorId && node.ownerId === message.authorId ? { authorsOwn: true } : {}) })),
    brakes: { streak, depth: message.botDepth, ...brakes },
  };
  const targets: RouteTarget[] = decision.reason === "mentioned" || decision.reason === "dm" || decision.reason === "lead" ? (decision.targets ?? decision.nodeIds.map((nodeId) => ({ nodeId, private: message.visibleTo.length > 0, audience: "owner" }))) : [];
  const choice = {
    reason: decision.reason,
    ...(decision.reason === "none" && decision.brake ? { brake: decision.brake } : {}),
    ...("capped" in decision && decision.capped ? { capped: decision.capped } : {}),
    woken: targets.map((target) => ({ nodeId: target.nodeId, private: target.private, audience: target.audience, ...(target.note ? { forNamedNode: true } : {}) })),
  };
  return { inputs, choice };
}
