/**
 * The Node tab: Ensemble Node at a glance, read-only. Your nodes, your rooms with their newest
 * message, approvals waiting for you, requests to join rooms, computer runs your nodes started, and your credits.
 * Chatting with nodes happens on the Node website; this tab only reads `GET /api/bridge/node`.
 */
import { ago } from "./model.js";
import { pad, truncate, wrapLine, type Line } from "./text.js";
import { TESTING, TESTING_APP } from "../channel.js";

export type NodeOverview = {
  nodes: Array<{ id: string; slug: string; name: string; role: string; status: string; busy: boolean }>;
  rooms: Array<{ id: string; kind: string; title: string; unread: number; lastMessageAt: string | null; last: { author: string; body: string } | null }>;
  approvals: Array<{ id: string; roomId: string; body: string }>;
  /** Requests to join someone's room; servers before this field send none. */
  invites?: Array<{ id: string; room: string; from: string }>;
  runs: Array<{ id: string; title: string; status: string; progress: string | null; summary: string | null; computer: string | null; createdAt: string }>;
  credits: { available: boolean; limit: number; used: number; remaining: number; resetsAt: string } | null;
};

export type NodeState = { data: NodeOverview | null; error: string | null; loading: boolean };

const RUN_GLYPH: Record<string, { glyph: string; color: string }> = {
  queued: { glyph: "○", color: "gray" },
  claimed: { glyph: "◐", color: "cyan" },
  running: { glyph: "●", color: "cyan" },
  waiting_approval: { glyph: "◆", color: "yellow" },
  blocked: { glyph: "◆", color: "yellow" },
  succeeded: { glyph: "✓", color: "green" },
  failed: { glyph: "✗", color: "red" },
  cancelled: { glyph: "–", color: "gray" },
  interrupted: { glyph: "!", color: "yellow" },
};

/** The Node website for this account's Ensemble: app.<domain> becomes node.<domain>. */
export function nodeWebUrl(appUrl: string | null | undefined, override = process.env.ENSEMBLE_NODE_URL): string {
  if (TESTING) return TESTING_APP;
  if (override?.trim()) return override.trim().replace(/\/+$/, "");
  try {
    const url = new URL(appUrl || "https://app.ensemblework.com");
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return `${url.protocol}//${url.hostname}:3300`;
    const host = url.hostname.replace(/^(app|www)\./, "");
    return `https://node.${host}`;
  } catch {
    return "https://node.ensemblework.com";
  }
}

export function nodeSidebar(state: NodeState, width: number, url: string): Line[] {
  const lines: Line[] = [[{ text: " NODES", bold: true, color: "gray" }]];
  const nodes = state.data?.nodes ?? [];
  for (const node of nodes) {
    const tail = node.status === "paused" ? "paused" : node.busy ? "working" : "";
    lines.push([
      { text: node.busy ? " ● " : " ○ ", color: node.busy ? "cyan" : "gray" },
      { text: pad(`@${node.slug}`, Math.max(4, width - 6 - tail.length)) },
      { text: tail ? ` ${tail}` : "", dim: true },
    ]);
  }
  if (!nodes.length && state.data) lines.push([{ text: " No nodes yet.", dim: true }]);
  lines.push([]);
  lines.push(...wrapLine([{ text: " Read-only here. Chat with your nodes at ", dim: true }, { text: url, color: "cyan" }], width - 1, " "));
  return lines;
}

export function nodePane(state: NodeState, width: number, now: number, signedIn: boolean, url: string): Line[] {
  if (!signedIn) return [[{ text: "Sign in to see your nodes: /login", dim: true }]];
  if (!state.data) {
    if (state.error) return wrapLine([{ text: state.error, color: "red" }], width);
    return [[{ text: state.loading ? "Loading Ensemble Node…" : "Nothing yet.", dim: true }]];
  }
  const { rooms, approvals, runs, credits } = state.data;
  const invites = state.data.invites ?? [];
  const lines: Line[] = [];
  if (state.error) lines.push(...wrapLine([{ text: `Could not refresh: ${state.error}`, color: "yellow" }], width), []);
  if (approvals.length) {
    lines.push([{ text: `WAITING FOR YOU · ${approvals.length}`, bold: true, color: "yellow" }]);
    for (const row of approvals.slice(0, 5)) lines.push([{ text: " ◆ ", color: "yellow" }, { text: truncate(row.body.replace(/\s+/g, " "), width - 4) }]);
    lines.push(...wrapLine([{ text: ` Approve or discard on ${url}`, dim: true }], width), []);
  }
  if (invites.length) {
    lines.push([{ text: `REQUESTS TO JOIN · ${invites.length}`, bold: true, color: "yellow" }]);
    for (const row of invites.slice(0, 5)) lines.push([{ text: " ◇ ", color: "yellow" }, { text: truncate(`${row.from} asks you to join “${row.room}”`, width - 4) }]);
    lines.push(...wrapLine([{ text: ` Accept or decline on ${url}`, dim: true }], width), []);
  }
  lines.push([{ text: "ROOMS", bold: true, color: "gray" }]);
  if (!rooms.length) lines.push(...wrapLine([{ text: ` No rooms yet. Make your first node on ${url}`, dim: true }], width));
  for (const room of rooms.slice(0, 12)) {
    const when = room.lastMessageAt ? ago(room.lastMessageAt, now) : "";
    const badge = room.unread ? ` ${room.unread} new` : "";
    lines.push([
      { text: room.unread ? " ● " : "   ", color: "cyan" },
      { text: pad(room.title, Math.max(8, width - 6 - badge.length - when.length)), bold: room.unread > 0 },
      { text: badge, color: "cyan" },
      { text: ` ${when}`, dim: true },
    ]);
    if (room.last) lines.push([{ text: "   " }, { text: truncate(room.last.body.replace(/\s+/g, " "), width - 4), dim: true }]);
  }
  if (runs.length) {
    lines.push([], [{ text: "COMPUTER RUNS", bold: true, color: "gray" }]);
    for (const run of runs.slice(0, 8)) {
      const glyph = RUN_GLYPH[run.status] ?? { glyph: "•", color: "gray" };
      const tail = `${run.computer ? `${run.computer} · ` : ""}${ago(run.createdAt, now)}`;
      lines.push([{ text: ` ${glyph.glyph} `, color: glyph.color }, { text: pad(run.title, Math.max(8, width - 5 - tail.length)) }, { text: ` ${tail}`, dim: true }]);
      const detail = run.progress ?? run.summary;
      if (detail) lines.push([{ text: "   " }, { text: truncate(detail.replace(/\s+/g, " "), width - 4), dim: true }]);
    }
  }
  if (credits?.available) {
    lines.push([], [{ text: "CREDITS", bold: true, color: "gray" }]);
    lines.push([{ text: ` ${Math.floor(credits.remaining).toLocaleString("en-US")} of ${Math.floor(credits.limit).toLocaleString("en-US")} left this month`, dim: false }, { text: " · shared by Ensemble, the CLI and Node", dim: true }]);
  }
  return lines;
}
