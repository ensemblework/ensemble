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

/** A thread's first name, from its first message (@ensemble/shared-types thread-title.ts). */
export { threadTitle } from "@ensemble/shared-types";

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
const HANDLE_KINDS = new Set(["people", "project", "repo", "task", "deliverable", "file", "page", "meeting"]);

const MENTIONS_MARK = "\n\n(Mentioned in Ensemble:";
/** What the server adds after the mentions: the mentioned records' content (hub-api workspace/mentioned.ts). */
const ATTACHED_MARK = "\n\n(Attached from Ensemble:";

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
export function splitMentions(sent: string): { text: string; mentions: PageMention[] } {
  const attached = sent.indexOf(ATTACHED_MARK);
  const instructions = attached < 0 ? sent : sent.slice(0, attached);
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

/** The Ensemble tool a call used, whatever prefix its agent puts on it (`mcp__ensemble__`, `ensemble-`, `ensemble.`). */
export function ensembleTool(name: string): string | null {
  const match = /^(?:mcp__ensemble__|ensemble[-.:/]|ensemble__)(.+)$/i.exec(name);
  if (match) return match[1]!.toLowerCase();
  return /^(ensemble_\w+|report_result|attach_evidence|ask_person|secret_http)$/i.test(name) ? name.toLowerCase() : null;
}

const ENSEMBLE_LABEL: Record<string, string> = {
  ensemble: "Asked Ensemble",
  report_result: "Reported the result",
  attach_evidence: "Attached evidence",
  ask_person: "Asked you",
  ensemble_actions: "Looked up what it can do in Ensemble",
  ensemble_context: "Read from Ensemble",
  ensemble_search: "Searched Ensemble",
  ensemble_list_tasks: "Read your tasks",
  ensemble_create_task: "Made a task",
  ensemble_apps: "Looked up your connected apps",
  ensemble_app_call: "Used a connected app",
  secret_http: "Called an API with a saved key",
};

const PAST: Record<string, string> = {
  create: "Made", make: "Made", add: "Added", update: "Updated", edit: "Edited", move: "Moved", delete: "Deleted", remove: "Removed", link: "Linked", unlink: "Unlinked",
  set: "Set", put: "Put", write: "Wrote", append: "Added to", rename: "Renamed", attach: "Attached", export: "Exported", save: "Saved", draw: "Drew", plot: "Plotted",
  assign: "Assigned", complete: "Completed", archive: "Archived", share: "Shared", schedule: "Scheduled", comment: "Commented on", mark: "Marked", start: "Started",
};

function words(text: string): string[] {
  return text.replace(/^(hub|apps)_/, "").split(/[_\s.-]+/).filter(Boolean).map((word) => word.toLowerCase());
}

/** An Ensemble action (`hub_create_page`) as what it did: "Made a page". */
export function ensembleActionLabel(action: string): string {
  const parts = words(action);
  if (!parts.length) return "Used Ensemble";
  const verb = PAST[parts[0]!];
  const rest = parts.slice(1).join(" ");
  if (verb) return rest ? `${verb} ${/^[aeiou]/.test(rest) ? "an" : "a"} ${rest}` : verb;
  const text = parts.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Built-in tool names as words, for agents that name them tersely. */
const TOOL_WORDS: Record<string, string> = {
  apply_patch: "Edited files",
  str_replace_editor: "Edited a file",
  str_replace: "Edited a file",
  report_intent: "Said what it is doing",
  update_plan: "Updated its plan",
  todowrite: "Updated its plan",
  todo_write: "Updated its plan",
  websearch: "Searched the web",
  web_search: "Searched the web",
  webfetch: "Read a web page",
  web_fetch: "Read a web page",
  fetch: "Read a web page",
  glob: "Found files",
  grep: "Searched the code",
  rg: "Searched the code",
  view: "Read",
  read: "Read",
  read_file: "Read",
  ls: "Listed files",
  list_dir: "Listed files",
  create: "Created",
  write: "Wrote",
  edit: "Edited",
  multiedit: "Edited",
  task: "Started a helper agent",
};

const pickString = (record: Record<string, unknown>, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
};

function inputOf(args: string): Record<string, unknown> | null {
  const input = parsed(args);
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
}

/** A command a tool call ran, and the agent's own words for why, when its input says. */
export function commandOf(args: string): { command: string; description: string | null } | null {
  const input = inputOf(args);
  if (!input) return null;
  const raw = input.command ?? input.cmd ?? input.commandLine ?? input.script;
  const command = Array.isArray(raw) ? raw.filter((part) => typeof part === "string").join(" ") : typeof raw === "string" ? raw : null;
  if (!command?.trim()) return null;
  // `bash -lc "…"` as Codex runs commands: the command inside.
  const inner = /^(?:\/bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  return { command: (inner ? inner[2]! : command).trim(), description: pickString(input, ["description", "intent", "reason", "explanation"]) };
}

/**
 * A tool call as a person reads it: a short label, the detail beside it (a command, a path, a query),
 * and whether it is one of Ensemble's tools.
 */
export function toolLine(name: string, args: string, summary: string): { label: string; detail: string | null; ensemble: boolean } {
  const line = toolLineOf(name, args, summary);
  return { ...line, label: plainEntities(line.label), detail: line.detail === null ? null : plainEntities(line.detail) };
}

function toolLineOf(name: string, args: string, summary: string): { label: string; detail: string | null; ensemble: boolean } {
  const ensemble = ensembleTool(name);
  const input = inputOf(args) ?? {};
  if (ensemble) {
    if (ensemble === "ensemble_act") {
      const action = typeof input.action === "string" ? input.action : "";
      const inner = input.input && typeof input.input === "object" ? (input.input as Record<string, unknown>) : {};
      return { label: action ? ensembleActionLabel(action) : "Used Ensemble", detail: pickString(inner, ["title", "name", "label", "query"]), ensemble: true };
    }
    if (ensemble === "ensemble_app_call") {
      const app = pickString(input, ["app", "appId"]);
      const tool = pickString(input, ["tool", "name"]);
      return { label: app ? `Used ${app}` : "Used a connected app", detail: tool ? tool.replace(/_/g, " ") : null, ensemble: true };
    }
    return { label: ENSEMBLE_LABEL[ensemble] ?? ensembleActionLabel(ensemble), detail: pickString(input, ["query", "title", "handle", "app", "summary"]), ensemble: true };
  }
  const command = commandOf(args);
  if (command) return { label: command.description ?? "Ran a command", detail: command.command, ensemble: false };
  const key = name.toLowerCase().replace(/^mcp__[^_]+__/, "");
  const path = pickString(input, PATH_KEYS);
  const query = pickString(input, ["pattern", "query", "url", "prompt", "description"]);
  const known = TOOL_WORDS[key];
  const tidy = summary && summary !== name ? summary : null;
  if (known) return { label: known, detail: path ?? query ?? tidy, ensemble: false };
  const label = key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return { label: tidy ?? (label ? label.charAt(0).toUpperCase() + label.slice(1) : "Tool"), detail: tidy ? null : path ?? query, ensemble: false };
}

/** What a tool call answered, as text to show: a command's output and its exit code, or the answer's own text. */
export function toolOutput(output: string): { text: string; exitCode: number | null } {
  const trimmed = output.trim();
  if (!trimmed) return { text: "", exitCode: null };
  let value: unknown = null;
  try {
    value = JSON.parse(trimmed);
  } catch {
    value = null;
  }
  let text = trimmed;
  let exitCode: number | null = null;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const contents = Array.isArray(record.contents) ? (record.contents as Array<Record<string, unknown>>) : [];
    const exit = contents.find((row) => row && typeof row.exitCode === "number");
    if (exit) exitCode = exit.exitCode as number;
    if (typeof record.exitCode === "number") exitCode = record.exitCode;
    if (typeof record.exit_code === "number") exitCode = record.exit_code;
    const body = [record.content, record.output, record.stdout, record.result, record.text].find((field) => (typeof field === "string" && field.trim()) || Array.isArray(field));
    const stderr = typeof record.stderr === "string" && record.stderr.trim() ? record.stderr : "";
    if (typeof body === "string") text = [body, stderr].filter(Boolean).join("\n");
    else if (Array.isArray(body)) text = body.map((block) => (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : JSON.stringify(block))).join("\n");
    else if (stderr) text = stderr;
    else if (exitCode !== null) text = "";
    else text = JSON.stringify(value, null, 2);
  } else if (typeof value === "string") {
    text = value;
  }
  // Copilot ends a shell's output with `<shellId: 0 completed with exit code 0>`.
  const marker = /\n?<shellId:[^>]*?exit code (-?\d+)>\s*$/.exec(text);
  if (marker) {
    exitCode ??= Number(marker[1]);
    text = text.slice(0, marker.index);
  }
  return { text: text.replace(/\s+$/, ""), exitCode };
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", "#160": " " };

/** Text some agents send with HTML entities in it (`&nbsp;`), as the characters they stand for. */
export function plainEntities(text: string): string {
  return text.replace(/&(nbsp|amp|lt|gt|quot|apos|#39|#160);/g, (_match, name: string) => ENTITIES[name] ?? _match);
}

/** A thought as a title and the rest: agents open a thought with a bold line (`**Checking the tests**`). */
export function thought(text: string): { title: string; body: string } {
  const clean = plainEntities(text).replace(/\u00a0/g, " ").trim();
  const bold = /^\*\*(.+?)\*\*\s*\n*/.exec(clean);
  if (bold) return { title: bold[1]!.trim(), body: clean.slice(bold[0].length).trim() };
  const first = clean.split("\n")[0] ?? "";
  const title = first.replace(/[*_`#>]+/g, "").trim();
  return { title: title.length > 100 ? `${title.slice(0, 99).trimEnd()}…` : title, body: clean.split("\n").slice(1).join("\n").trim() || (title.length > 100 ? clean : "") };
}

/** An Ensemble record a reply links to: a file, a page, a task and so on. */
export type RecordLink = { kind: "file" | "page" | "task" | "diagram" | "plot" | "project" | "meeting" | "dataset"; id: string; label: string | null; href: string };

const RECORD_PATHS: Array<[RegExp, RecordLink["kind"]]> = [
  [/^\/files\/([\w-]{8,})/, "file"],
  [/^\/pages\/([\w-]{8,})/, "page"],
  [/^\/tasks\/([\w-]{8,})/, "task"],
  [/^\/diagrams\/([\w-]{8,})/, "diagram"],
  [/^\/plots\/([\w-]{8,})/, "plot"],
  [/^\/projects\/([\w-]{8,})/, "project"],
  [/^\/context\/datasets\/([\w-]{8,})/, "dataset"],
];

const HANDLE_KIND: Record<string, RecordLink["kind"]> = { file: "file", page: "page", task: "task", diagram: "diagram", plot: "plot", project: "project", meeting: "meeting", dataset: "dataset" };

function recordOf(url: string, label: string | null): RecordLink | null {
  const handle = /^ensemble:\/\/([a-z]+)\/([\w-]+)/.exec(url);
  if (handle) {
    const kind = HANDLE_KIND[handle[1]!];
    if (!kind) return null;
    const href = kind === "meeting" ? `/meetings?session=${handle[2]}` : kind === "dataset" ? `/context/datasets/${handle[2]}` : `/${kind}s/${handle[2]}`;
    return { kind, id: handle[2]!, label, href };
  }
  let path = url;
  if (/^https?:\/\//.test(url)) {
    try {
      const parsedUrl = new URL(url);
      path = `${parsedUrl.pathname}${parsedUrl.search}`;
    } catch {
      return null;
    }
  }
  if (!path.startsWith("/")) return null;
  const meeting = /^\/meetings\?session=([\w-]{8,})/.exec(path);
  if (meeting) return { kind: "meeting", id: meeting[1]!, label, href: path };
  for (const [pattern, kind] of RECORD_PATHS) {
    const match = pattern.exec(path);
    // A record's id has a digit: `/pages/new` and other words are screens, not records.
    if (match && /\d/.test(match[1]!)) return { kind, id: match[1]!, label, href: path };
  }
  return null;
}

/** The Ensemble records a reply links to, in order, once each: Markdown links, bare paths and `ensemble://` handles. */
export function recordLinks(text: string): RecordLink[] {
  const found = new Map<string, RecordLink>();
  const add = (link: RecordLink | null) => {
    if (!link) return;
    const key = `${link.kind}:${link.id}`;
    const known = found.get(key);
    if (!known) found.set(key, link);
    else if (!known.label && link.label) found.set(key, { ...known, label: link.label });
  };
  for (const match of text.matchAll(/\[([^\]\n]{1,200})\]\(([^)\s]+)\)/g)) add(recordOf(match[2]!, match[1]!.replace(/[*_`]/g, "").trim() || null));
  for (const match of text.matchAll(/(?:^|[\s(])((?:https?:\/\/[^\s)]+)?\/(?:files|pages|tasks|diagrams|plots|projects)\/[\w-]{8,}|ensemble:\/\/[a-z]+\/[\w-]+)/g)) add(recordOf(match[1]!, null));
  return [...found.values()].slice(0, 8);
}

/** Words a first message often opens with that say nothing about the work. */
export type DiffLine = { sign: "+" | "-" | " " | "@"; text: string };

const MAX_DIFF_LINES = 200;

/** An edit's change as diff lines, from whatever its agent sent: a patch, old and new text, or a whole file. */
export function editLines(args: string): DiffLine[] | null {
  const input = inputOf(args);
  if (!input && !args.includes("\n")) return null;
  const lines: DiffLine[] = [];
  const push = (sign: DiffLine["sign"], text: string) => {
    for (const line of text.replace(/\n$/, "").split("\n")) if (lines.length < MAX_DIFF_LINES) lines.push({ sign, text: line });
  };
  const patch = input ? pickString(input, ["patch", "input", "diff", "unified_diff"]) : args;
  if (patch && /^(\*\*\* |@@|[+-])/m.test(patch)) {
    for (const line of patch.split("\n")) {
      if (lines.length >= MAX_DIFF_LINES) break;
      if (/^\*\*\* (Begin|End) Patch/.test(line) || /^(---|\+\+\+) /.test(line)) continue;
      if (line.startsWith("*** ")) lines.push({ sign: "@", text: line.slice(4) });
      else if (line.startsWith("@@")) lines.push({ sign: "@", text: line });
      else if (line.startsWith("+")) lines.push({ sign: "+", text: line.slice(1) });
      else if (line.startsWith("-")) lines.push({ sign: "-", text: line.slice(1) });
      else lines.push({ sign: " ", text: line.replace(/^ /, "") });
    }
    return lines;
  }
  if (!input) return null;
  const edits = Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : [input];
  for (const edit of edits) {
    if (!edit || typeof edit !== "object") continue;
    const before = pickString(edit, ["old_string", "old_str", "oldText", "old_text"]);
    const after = edit.new_string ?? edit.new_str ?? edit.newText ?? edit.new_text;
    if (before !== null || typeof after === "string") {
      if (edits.length > 1 && lines.length) lines.push({ sign: "@", text: "" });
      if (before) push("-", before);
      if (typeof after === "string" && after) push("+", after);
    }
  }
  if (lines.length) return lines;
  const whole = pickString(input, ["content", "file_text", "new_content", "text", "contents"]);
  if (whole) push("+", whole);
  return lines.length ? lines : null;
}

/** A tool call's input as name and value pairs to read, without what its row already shows. */
export function inputLines(args: string): Array<[string, string]> {
  const input = inputOf(args);
  if (!input) return args.trim() && args.trim() !== "{}" ? [["input", args.trim().slice(0, 2000)]] : [];
  const skip = new Set(["command", "description", "cmd"]);
  return Object.entries(input)
    .filter(([key, value]) => !skip.has(key) && value !== null && value !== undefined && value !== "")
    .slice(0, 12)
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
      return [key.replace(/_/g, " "), text.length > 600 ? `${text.slice(0, 599)}…` : text];
    });
}

/** The narrowest the sessions panel may be dragged: wide enough for its longest names (up to 30 characters) beside the state, agent and time. */
export function sessionsMinWidth(titles: readonly string[]): number {
  const longest = titles.reduce((most, title) => Math.max(most, Math.min(title.trim().length, 30)), 0);
  return Math.max(200, Math.min(320, Math.round(longest * 6.6) + 84));
}
