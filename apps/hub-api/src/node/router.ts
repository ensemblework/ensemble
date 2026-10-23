/**
 * Who speaks after a message in an Ensemble Node room (docs/35 §5). Pure: the caller loads the
 * room, its nodes and the recent tail, and enqueues a turn for each node returned.
 *
 *   - Cards and system lines never wake anyone.
 *   - A node sees only what its owner may see, so a private message wakes only that person's nodes.
 *   - A node's message wakes only the nodes it mentions, under two brakes: consecutive node
 *     messages in the room, and the depth of the bot chain under one person's message.
 *   - A person's message wakes the nodes it mentions; mentioning only people wakes nobody;
 *     otherwise the DM's node, the crew's lead, or in a group the one representative (several:
 *     a small relevance call picks at most two).
 */
import type { Mention } from "./mentions.js";

export const MAX_BOT_STREAK = 8;
export const MAX_BOT_DEPTH = 12;
export const MAX_HUMAN_FANOUT = 6;
export const MAX_NODE_FANOUT = 3;
export const MAX_RELEVANT = 2;

export type RouteMessage = {
  kind: string;
  authorKind: "human" | "node" | "system";
  authorNodeId: string | null;
  visibleTo: readonly string[];
  mentions: readonly Mention[];
  botDepth: number;
};

export type RouteRoom = { kind: "dm" | "crew" | "room"; leadNodeIds: readonly string[] };
export type RouteNode = { id: string; ownerId: string; active: boolean; representative: boolean; role: string };

export type RouteDecision =
  | { reason: "mentioned" | "dm" | "lead"; nodeIds: string[] }
  | { reason: "relevance"; nodeIds: []; candidates: string[] }
  | { reason: "none"; nodeIds: []; brake?: "streak" | "depth" };

const none = (brake?: "streak" | "depth"): RouteDecision => ({ reason: "none", nodeIds: [], ...(brake ? { brake } : {}) });

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

export function whoSpeaks(message: RouteMessage, room: RouteRoom, nodes: readonly RouteNode[], streak: number): RouteDecision {
  if (message.kind !== "text" || message.authorKind === "system") return none();
  const eligible = nodes.filter(
    (node) => node.active && node.id !== message.authorNodeId && (message.visibleTo.length === 0 || message.visibleTo.includes(node.ownerId)),
  );
  const eligibleIds = new Set(eligible.map((node) => node.id));
  const mentioned = message.mentions.filter((row) => row.kind === "node" && eligibleIds.has(row.id)).map((row) => row.id);

  if (message.authorKind === "node") {
    if (streak >= MAX_BOT_STREAK) return none("streak");
    if (message.botDepth >= MAX_BOT_DEPTH) return none("depth");
    return mentioned.length ? { reason: "mentioned", nodeIds: mentioned.slice(0, MAX_NODE_FANOUT) } : none();
  }

  if (mentioned.length) return { reason: "mentioned", nodeIds: mentioned.slice(0, MAX_HUMAN_FANOUT) };
  if (message.mentions.length) return none();
  if (!eligible.length) return none();
  if (room.kind === "dm") return { reason: "dm", nodeIds: [eligible[0]!.id] };
  const lead = room.leadNodeIds.find((id) => eligibleIds.has(id));
  if (room.kind === "crew") {
    const pick = lead ?? eligible.find((node) => node.role === "manager")?.id ?? eligible[0]!.id;
    return { reason: "lead", nodeIds: [pick] };
  }
  if (lead) return { reason: "lead", nodeIds: [lead] };
  const representatives = eligible.filter((node) => node.representative);
  const pool = representatives.length ? representatives : eligible;
  if (pool.length === 1) return { reason: "lead", nodeIds: [pool[0]!.id] };
  return { reason: "relevance", nodeIds: [], candidates: pool.map((node) => node.id) };
}

export type RelevanceCandidate = { id: string; handle: string; owner: string; role: string; focus: string };

export function relevancePrompt(text: string, author: string, candidates: readonly RelevanceCandidate[], recent: readonly string[]): { system: string; prompt: string } {
  return {
    system:
      "You route messages in a group chat where each person has an AI teammate (a node) that represents them. " +
      'Pick the nodes whose owner the message concerns. Reply with JSON only: {"nodes": ["handle"]}. ' +
      `At most ${MAX_RELEVANT}. An empty list when the message is small talk, is addressed to people, or concerns no listed owner.`,
    prompt: [
      "Nodes:",
      ...candidates.map((row) => `- @${row.handle}: represents ${row.owner} (${row.role})${row.focus ? `; ${row.owner} handles: ${row.focus}` : ""}`),
      "",
      recent.length ? `Recent messages:\n${recent.join("\n")}\n` : "",
      `New message from ${author}:`,
      text,
    ].join("\n"),
  };
}

/** The ids of the handles a relevance answer named, in the candidates' order, capped. */
export function parseRelevance(answer: unknown, candidates: readonly RelevanceCandidate[]): string[] {
  const list = answer && typeof answer === "object" && Array.isArray((answer as { nodes?: unknown }).nodes) ? (answer as { nodes: unknown[] }).nodes : [];
  const named = new Set(list.filter((value): value is string => typeof value === "string").map((value) => value.replace(/^@/, "").toLowerCase()));
  return candidates.filter((row) => named.has(row.handle.toLowerCase())).map((row) => row.id).slice(0, MAX_RELEVANT);
}
