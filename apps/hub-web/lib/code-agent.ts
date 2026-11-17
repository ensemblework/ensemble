/**
 * The Code tab agent's thread as data (docs/16 §9): what kind of work each tool call is, the file it
 * touched in the folder, and the turn's work rows and timings.
 *
 * `compactCount` and `elapsed` follow T3 Code's `DiffStatLabel` and `AgentElapsed`
 * (https://github.com/pingdotgg/t3code, MIT License, Copyright (c) 2026 T3 Tools Inc.).
 */
import type { PageMention } from "@ensemble/shared-types";
import type { AgentJob, CodeThread } from "./api";
import type { TraceEntry } from "./run-trace";

/** What a tool call does, whichever agent made it (Claude Code's `Bash`, Codex's `commandExecution`, an ACP agent's `execute`…). */
export type ToolKind = "command" | "edit" | "read" | "search" | "web" | "ensemble" | "apps" | "ask" | "plan" | "agent" | "think" | "other";

export function toolKind(name: string): ToolKind {
  const n = name.toLowerCase();
  if (n.includes("ensemble_app")) return "apps";
  if (n.includes("ask_person") || n === "askuserquestion") return "ask";
  if (n.includes("ensemble")) return "ensemble";
  if (/^(bash|shell|execute|commandexecution|command|exec|run_?command|terminal|powershell)/.test(n)) return "command";
  if (/(websearch|webfetch|^fetch|browser|^web)/.test(n)) return "web";
  if (/(todo|^plan|update_plan)/.test(n)) return "plan";
  if (/(edit|write|filechange|patch|^create|^delete|^move|rename|str_replace|notebook)/.test(n)) return "edit";
  if (/^(read|view|ls$|cat$|open|list)/.test(n)) return "read";
  if (/(grep|glob|search|find)/.test(n)) return "search";
  if (/^(task|agent|subagent)/.test(n)) return "agent";
  if (/think/.test(n)) return "think";
  return "other";
}

const PATH_KEYS = ["file_path", "filePath", "path", "target_file", "notebook_path", "filename", "file"];

function parsed(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return null;
  }
}

/** A path as the folder's own relative path, or null when it is outside it (or not a plain path). */
export function relativeIn(folder: string, path: string): string | null {
  const value = path.trim();
  if (!value || value.includes("\0")) return null;
  const root = folder.replace(/\/+$/, "");
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
    if (!root || !value.startsWith(`${root}/`)) return null;
    return value.slice(root.length + 1) || null;
  }
  if (value.startsWith("~")) return null;
  const clean = value.replace(/^\.\//, "");
  return clean.split("/").includes("..") ? null : clean;
}

/** The file in the folder a tool call read or changed, when its input names one. */
export function toolPath(args: string, folder: string): string | null {
  const input = parsed(args);
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string") return relativeIn(folder, value);
  }
  const changes = record.changes;
  if (Array.isArray(changes)) {
    const first = changes.find((row) => row && typeof row === "object" && typeof (row as { path?: unknown }).path === "string") as { path: string } | undefined;
    if (first) return relativeIn(folder, first.path);
  }
  return null;
}

/** A thread's title from its first message: the first line, at most 80 characters. */
export function threadTitle(message: string): string {
  const line = message.trim().split("\n").find((row) => row.trim())?.trim() ?? "";
  const plain = line.replace(/\s+/g, " ").replace(/[.:;,]+$/, "");
  if (!plain) return "New thread";
  return plain.length > 80 ? `${plain.slice(0, 79).trimEnd()}…` : plain;
}

/** 1234 → "1.2k". */
export function compactCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 999_500) {
    const k = value / 1000;
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
  }
  const m = value / 1_000_000;
  return `${m < 10 ? m.toFixed(1).replace(/\.0$/, "") : Math.round(m)}m`;
}

/** "42s", "3m 05s", "1h 02m". */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

const LIVE = new Set<AgentJob["status"]>(["queued", "claimed", "running", "stopping", "waiting_approval"]);

/** A turn still working (or waiting to start, or for the person). */
export const isLive = (status: AgentJob["status"]): boolean => LIVE.has(status);

/** One row of a turn's work log: a tool call, the agent's thinking, or what it said on the way. */
export type WorkRow =
  | { id: string; type: "tool"; kind: ToolKind; name: string; summary: string; path: string | null; ok: boolean | null; running: boolean; ms: number | null; args: string; output: string }
  | { id: string; type: "thinking"; text: string }
  | { id: string; type: "message"; text: string };

/**
 * A turn's trace as work rows, in order. The closing answer is left out: the turn shows it as its reply.
 * `reply` is that answer, so a message repeating it is left out too.
 */
export function workRows(entries: TraceEntry[], folder: string, reply = ""): WorkRow[] {
  const answer = reply.trim();
  const rows: WorkRow[] = [];
  for (const entry of entries) {
    if (entry.reasoning) rows.push({ id: `${entry.id}:thinking`, type: "thinking", text: entry.reasoning });
    if (entry.kind === "tools") {
      for (const call of entry.calls) {
        rows.push({ id: call.key, type: "tool", kind: toolKind(call.name), name: call.name, summary: call.summary || entry.title || call.name, path: toolPath(call.args, folder), ok: call.ok, running: call.running, ms: call.ms, args: call.args, output: call.output });
      }
      if (entry.text && entry.text.trim() !== answer) rows.push({ id: `${entry.id}:text`, type: "message", text: entry.text });
    } else if (entry.kind === "thinking") {
      if (entry.text && !entry.reasoning) rows.push({ id: entry.id, type: "thinking", text: entry.text });
    } else if (entry.kind === "message") {
      if (entry.text && entry.text.trim() !== answer) rows.push({ id: entry.id, type: "message", text: entry.text });
    }
  }
  return rows;
}

/** The turn's reply while it is still working: the last thing it said. */
export function liveReply(entries: TraceEntry[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if ((entry.kind === "message" || entry.kind === "result") && entry.text.trim()) return entry.text;
  }
  return "";
}

/** How long a turn took, or has taken so far. */
export function turnMs(turn: Pick<AgentJob, "createdAt" | "startedAt" | "finishedAt">, now = Date.now()): number {
  const from = Date.parse(turn.startedAt ?? turn.createdAt);
  const to = turn.finishedAt ? Date.parse(turn.finishedAt) : now;
  return Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, to - from) : 0;
}

/** Mention kinds Ensemble's context tools open by an `ensemble://` handle; the rest go by kind and id. */
const HANDLE_KINDS = new Set(["people", "project", "repo", "task", "deliverable", "file"]);

const MENTIONS_MARK = "\n\n(Mentioned in Ensemble:";

/**
 * A message with the records it @mentions written after it for the agent, as handles its Ensemble tools
 * open (`ensemble://task/<id>`). The thread shows the message without them (`splitMentions`).
 */
export function withMentions(text: string, mentions: readonly PageMention[]): string {
  const named = mentions.filter((row) => row.kind !== "date");
  if (!named.length) return text;
  const items = named.map((row) => `@${row.label} [${row.kind}] ${HANDLE_KINDS.has(row.kind) ? `ensemble://${row.kind}/${row.id}` : `${row.kind} id ${row.id}`}`);
  return `${text}${MENTIONS_MARK} ${items.join("; ")})`;
}

/** A turn's message and the records it mentioned, from what was sent (`withMentions`). */
export function splitMentions(instructions: string): { text: string; mentions: PageMention[] } {
  const at = instructions.indexOf(MENTIONS_MARK);
  if (at < 0) return { text: instructions, mentions: [] };
  const tail = instructions.slice(at + MENTIONS_MARK.length).replace(/\)\s*$/, "");
  const mentions: PageMention[] = [];
  for (const match of tail.matchAll(/@(.+?) \[([a-z]+)\] (?:ensemble:\/\/[a-z]+\/|[a-z]+ id )([\w/-]+)/g)) {
    mentions.push({ kind: match[2] as PageMention["kind"], label: match[1]!, id: match[3]! });
  }
  return { text: instructions.slice(0, at), mentions };
}

/** A thread's place as one key: the computer and the folder (empty for none). */
export const placeKey = (place: { deviceId: string | null; folder: string | null }): string => `${place.deviceId ?? "local"}:${place.folder ?? ""}`;

/** The last part of a folder's path. */
export function folderName(path: string | null | undefined): string {
  if (!path) return "";
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || trimmed || path;
}

export type ThreadGroup = { key: string; label: string; folder: string | null; deviceId: string | null; deviceName: string | null; pinned: boolean; threads: CodeThread[] };

/**
 * The sessions list: pinned threads first, then one group per folder (and computer, when there are
 * several), "No folder" for threads in a new workspace folder; each group and thread newest first.
 */
export function groupThreads(threads: readonly CodeThread[], pinned: ReadonlySet<string>, options: { computers: number } = { computers: 1 }): ThreadGroup[] {
  const top = threads.filter((row) => pinned.has(row.id));
  const groups = new Map<string, ThreadGroup>();
  for (const thread of threads) {
    if (pinned.has(thread.id)) continue;
    const key = placeKey(thread.place);
    const name = thread.place.folder ? folderName(thread.place.folder) : "No folder";
    const where = options.computers > 1 && thread.place.deviceName ? ` · ${thread.place.deviceName}` : "";
    const group = groups.get(key) ?? { key, label: `${name}${where}`, folder: thread.place.folder, deviceId: thread.place.deviceId, deviceName: thread.place.deviceName, pinned: false, threads: [] };
    group.threads.push(thread);
    groups.set(key, group);
  }
  const newest = (group: ThreadGroup) => group.threads[0]?.updatedAt ?? "";
  const rest = [...groups.values()].map((group) => ({ ...group, threads: [...group.threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) })).sort((a, b) => newest(b).localeCompare(newest(a)));
  return top.length ? [{ key: "pinned", label: "Pinned", folder: null, deviceId: null, deviceName: null, pinned: true, threads: top }, ...rest] : rest;
}

/** "now", "5m", "3h", "2d", "3w": how long ago, as the sessions list shows it. */
export function shortAgo(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return "now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 14 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

/** The tasks a thread's messages @mentioned, once each, the latest first. */
export function linkedTasks(instructions: readonly string[]): Array<{ id: string; label: string }> {
  const seen = new Map<string, string>();
  for (const text of [...instructions].reverse()) {
    for (const mention of splitMentions(text).mentions) if (mention.kind === "task" && !seen.has(mention.id)) seen.set(mention.id, mention.label);
  }
  return [...seen].map(([id, label]) => ({ id, label }));
}

/** A Code window's main area: the editor, or a thread with the person's coding agent (docs/16 §9). */
export type IdeView = "editor" | "agent";

/**
 * Where a thread (or a folder) opens: its folder in the IDE, or Code's home for a thread with no
 * folder. `thread` "new" starts a thread there.
 */
export function agentHref(place: { deviceId: string | null; folder: string | null }, options: { thread?: string | null; view?: IdeView; file?: string } = {}): string {
  const view = options.view ?? "agent";
  const params = new URLSearchParams({ ...(place.deviceId ? { device: place.deviceId } : {}), ...(place.folder ? { repo: place.folder } : {}), view, ...(options.thread ? { thread: options.thread } : {}), ...(options.file ? { file: options.file } : {}) });
  return place.folder ? `/code/review?${params.toString()}` : `/code?${params.toString()}`;
}
