/**
 * Records a turn knows by id and title (docs/11 §4.1), so replies and receipts can name them by
 * title while the ids stay in tool data, link targets and later calls.
 */
import {
  isUuid,
  linkedRefs,
  refKind,
  refLink,
  type AssistantRef,
  type PageMention,
} from "@ensemble/shared-types";

/** Records kept on one tool call: enough for a list page, small enough for the saved receipt. */
export const MAX_CALL_REFS = 50;
/** Records sent before a reply streams, and kept on a reply that names them. */
export const MAX_TURN_REFS = 200;
export const MAX_REPLY_REFS = 60;

const KIND_OF_KEY: Record<string, string> = {
  task: "task",
  tasks: "task",
  project: "project",
  projects: "project",
  person: "people",
  people: "people",
  file: "file",
  files: "file",
  document: "file",
  documents: "file",
  diagram: "diagram",
  diagrams: "diagram",
  plot: "plot",
  plots: "plot",
  dataset: "dataset",
  datasets: "dataset",
  skill: "skill",
  skills: "skill",
  deliverable: "deliverable",
  deliverables: "deliverable",
  repo: "repo",
  repos: "repo",
  page: "page",
  pages: "page",
  session: "meeting",
  meeting: "meeting",
  meetings: "meeting",
  reminder: "reminder",
  reminders: "reminder",
};

const TOOL_KINDS: Array<[RegExp, string]> = [
  [/meeting/, "meeting"],
  [/deliverable/, "deliverable"],
  [/dataset/, "dataset"],
  [/plot/, "plot"],
  [/diagram/, "diagram"],
  [/reminder/, "reminder"],
  [/person|people/, "people"],
  [/project/, "project"],
  [/_repos?(?:_|$)/, "repo"],
  [/skill/, "skill"],
  [/task/, "task"],
  [/page/, "page"],
  [/file/, "file"],
];

/** The kind of record a tool deals in, from its name (`hub_create_tasks` → task). */
export function toolKind(name: string): string | null {
  return TOOL_KINDS.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

const LABEL_KEYS = ["title", "name", "filename", "fullName", "label"] as const;

function detailOf(row: Record<string, unknown>, kind: string): string | undefined {
  if (kind === "people" && typeof row.email === "string" && row.email) return row.email.slice(0, 80);
  if (kind !== "task") return undefined;
  const due = row.due instanceof Date ? row.due.toISOString() : typeof row.due === "string" ? row.due : "";
  if (/^\d{4}-\d{2}-\d{2}/.test(due)) return `due ${due.slice(0, 10)}`;
  return typeof row.status === "string" && row.status ? row.status.replace(/_/g, " ") : undefined;
}

class RefList {
  private readonly rows = new Map<string, AssistantRef>();
  constructor(private readonly limit: number) {}
  add(ref: AssistantRef | null | undefined): void {
    if (!ref || this.rows.size >= this.limit) return;
    const label = ref.label.replace(/\s+/g, " ").trim().slice(0, 200);
    const key = ref.id.toLowerCase();
    if (!label || !ref.id || this.rows.has(key)) return;
    this.rows.set(key, { kind: ref.kind, id: ref.id, label, ...(ref.detail ? { detail: ref.detail } : {}) });
  }
  addAll(refs: Iterable<AssistantRef> | null | undefined): void {
    for (const ref of refs ?? []) this.add(ref);
  }
  list(): AssistantRef[] {
    return [...this.rows.values()];
  }
}

/**
 * The records in a tool's result: objects with a real id and a title or name. The kind comes from
 * the row's own `kind`, else the key it sits under (`tasks`, `project`), else the tool's name.
 * A result that is only `{ id }` takes its title from the one quoted title in the summary.
 */
export function refsFromResult(toolName: string, data: unknown, summary = "", limit = MAX_CALL_REFS): AssistantRef[] {
  const out = new RefList(limit);
  const fallback = toolKind(toolName);
  const visit = (value: unknown, keyKind: string | null, depth: number): void => {
    if (!value || typeof value !== "object" || depth > 4) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 200)) visit(item, keyKind, depth + 1);
      return;
    }
    if (value instanceof Date) return;
    const row = value as Record<string, unknown>;
    const label = LABEL_KEYS.map((key) => row[key]).find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
    if (isUuid(row.id) && label) {
      const own = typeof row.kind === "string" ? refKind(row.kind) : null;
      const kind = own ?? keyKind ?? (depth <= 2 ? fallback : null) ?? "item";
      if (kind === "page" && isUuid(row.taskId)) out.add({ kind: "task", id: row.taskId, label });
      out.add({ kind, id: row.id, label, detail: detailOf(row, kind) });
    }
    for (const [key, child] of Object.entries(row)) {
      if (child && typeof child === "object") visit(child, KIND_OF_KEY[key] ?? null, depth + 1);
    }
  };
  visit(data, null, 0);
  const top = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  if (top && isUuid(top.id) && !LABEL_KEYS.some((key) => typeof top[key] === "string" && top[key])) {
    const titles = [...summary.matchAll(/“([^”\n]{1,200})”/g)];
    const kind = (typeof top.kind === "string" ? refKind(top.kind) : null) ?? fallback;
    if (titles.length === 1 && kind) out.add({ kind, id: top.id, label: titles[0]![1]! });
  }
  return out.list();
}

export function mentionRefs(mentions: readonly PageMention[] | null | undefined): AssistantRef[] {
  return (mentions ?? []).filter((mention) => mention.kind !== "date" && mention.id && mention.label).map((mention) => ({ kind: mention.kind, id: mention.id, label: mention.label }));
}

type StateLike = {
  todo?: ReadonlyArray<{ id: string; title: string; status?: string }>;
  projects?: ReadonlyArray<{ id: string; name: string }>;
  people?: ReadonlyArray<{ id: string; name: string }>;
  skills?: ReadonlyArray<{ id: string; name: string }>;
};

type OpenLike = { kind?: string; id: string; title: string; status?: string } | undefined;

/** The records the system prompt lists by id: the open item, tasks on the board, projects, people, skills. */
export function stateRefs(state: StateLike, open?: OpenLike): AssistantRef[] {
  const out: AssistantRef[] = [];
  if (open?.id && open.title) out.push({ kind: open.kind === "meeting" ? "meeting" : open.kind === "project" ? "project" : open.status ? "task" : "page", id: open.id, label: open.title });
  for (const task of state.todo ?? []) out.push({ kind: "task", id: task.id, label: task.title, ...(task.status ? { detail: task.status.replace(/_/g, " ") } : {}) });
  for (const project of state.projects ?? []) out.push({ kind: "project", id: project.id, label: project.name });
  for (const person of state.people ?? []) out.push({ kind: "people", id: person.id, label: person.name });
  for (const skill of state.skills ?? []) out.push({ kind: "skill", id: skill.id, label: skill.name });
  return out;
}

/** Records named by earlier messages: their tool calls, the mentions saved on them, and links in their text. */
export function historyRefs(rows: ReadonlyArray<{ content?: string; toolCalls?: unknown; mentions?: unknown }>): AssistantRef[] {
  const out: AssistantRef[] = [];
  for (const row of [...rows].reverse()) {
    for (const call of Array.isArray(row.toolCalls) ? row.toolCalls : []) out.push(...savedRefs((call as { refs?: unknown })?.refs));
    out.push(...savedRefs(row.mentions));
    if (row.content) out.push(...linkedRefs(row.content));
  }
  return out;
}

/** Refs read back from JSON, keeping only well-formed ones. */
export function savedRefs(value: unknown): AssistantRef[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (ref): ref is AssistantRef =>
      Boolean(ref) && typeof ref === "object" && typeof (ref as AssistantRef).id === "string" && typeof (ref as AssistantRef).label === "string" && typeof (ref as AssistantRef).kind === "string" && (ref as AssistantRef).kind !== "date",
  );
}

/** Merges ref lists, first one wins for an id, capped. */
export function mergeRefs(lists: ReadonlyArray<ReadonlyArray<AssistantRef> | null | undefined>, limit = MAX_TURN_REFS): AssistantRef[] {
  const out = new RefList(limit);
  for (const list of lists) out.addAll(list);
  return out.list();
}

/** The records a receipt names, written for a model: `Records: [Draft brief](ensemble://task/…), …`. */
export function refsNote(refs: readonly AssistantRef[] | null | undefined, max = 12): string {
  const shown = (refs ?? []).filter((ref) => ref.kind !== "item").slice(0, max);
  if (!shown.length) return "";
  const more = (refs ?? []).length - shown.length;
  return `Records: ${shown.map(refLink).join(", ")}${more > 0 ? ` and ${more} more` : ""}.`;
}

const KIND_NAME: Record<string, string> = {
  task: "task",
  project: "project",
  people: "person",
  person: "person",
  file: "file",
  document: "file",
  page: "page",
  diagram: "diagram",
  plot: "plot",
  dataset: "dataset",
  skill: "skill",
  deliverable: "deliverable",
  repo: "repository",
  reminder: "reminder",
  meeting: "meeting note",
  parent: "page",
};

function words(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
}

const quoteLabel = (label: string) => `“${label}”`;
const plural = (word: string, count = 2) => (count === 1 ? word : word === "person" ? "people" : word.endsWith("y") ? `${word.slice(0, -1)}ies` : word.endsWith("notes") ? word : `${word}s`);

/**
 * Titles for a summary: `“A”`, `“A” and “B”`, `“A”, “B”, “C” and 4 more`. Titles that repeat get
 * their detail (a due date, an email) or a number, so the records stay apart.
 */
export function titleList(items: ReadonlyArray<{ title: string; detail?: string | null }>, max = 5): string {
  const names = items.map((item, index) => {
    const title = item.title.replace(/\s+/g, " ").trim() || "Untitled";
    const same = items.filter((other) => (other.title.replace(/\s+/g, " ").trim() || "Untitled").toLowerCase() === title.toLowerCase());
    if (same.length < 2) return quoteLabel(title);
    const detail = item.detail?.trim();
    const qualifier = detail && same.filter((other) => other.detail?.trim() === detail).length === 1 ? detail : String(same.indexOf(items[index]!) + 1);
    return `${quoteLabel(title)} (${qualifier})`;
  });
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= max) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

/**
 * A held write shown to the person when its tool has no preview of its own: what it does and its
 * fields, with ids replaced by the titles the turn knows. Never raw JSON.
 */
export function readablePreview(toolName: string, input: unknown, known: ReadonlyMap<string, AssistantRef>): string {
  const action = toolName.replace(/^(hub|apps|node|mcp)_/, "").replace(/_/g, " ");
  const head = action.charAt(0).toUpperCase() + action.slice(1);
  if (!input || typeof input !== "object" || Array.isArray(input)) return head;
  const idWord = (key: string) => KIND_NAME[key.replace(/Ids?$/, "").toLowerCase()] ?? "record";
  const value = (key: string, raw: unknown, depth = 0): string | null => {
    if (raw === undefined || raw === null || raw === "") return null;
    if (isUuid(raw)) {
      const ref = known.get(raw.toLowerCase());
      return ref ? quoteLabel(ref.label) : `a ${idWord(key)}`;
    }
    if (typeof raw === "string") {
      const flat = raw.replace(/\s+/g, " ").trim();
      return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
    }
    if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
    if (Array.isArray(raw)) {
      if (!raw.length) return "none";
      if (raw.every((item) => isUuid(item))) {
        const names = raw.map((item) => known.get(String(item).toLowerCase())).filter(Boolean).map((ref) => quoteLabel(ref!.label));
        const unknown = raw.length - names.length;
        const rest = unknown ? `${unknown} ${plural(idWord(key), unknown)}` : "";
        return names.length ? `${names.slice(0, 8).join(", ")}${names.length > 8 ? ` and ${names.length - 8} more` : ""}${rest ? ` and ${rest}` : ""}` : rest;
      }
      if (raw.every((item) => typeof item !== "object" || item === null)) {
        const shown = raw.slice(0, 8).map((item) => value(key, item, depth + 1)).filter(Boolean);
        return `${shown.join(", ")}${raw.length > 8 ? ` and ${raw.length - 8} more` : ""}`;
      }
      return `${raw.length} item${raw.length === 1 ? "" : "s"}`;
    }
    if (typeof raw === "object" && depth < 1) {
      const parts = Object.entries(raw as Record<string, unknown>)
        .map(([inner, item]) => {
          const shown = value(inner, item, depth + 1);
          return shown ? `${words(inner.replace(/Ids?$/, "") || inner)} ${shown}` : null;
        })
        .filter(Boolean)
        .slice(0, 6);
      return parts.length ? parts.join(", ") : null;
    }
    return null;
  };
  const lines = Object.entries(input as Record<string, unknown>)
    .map(([key, raw]) => {
      const shown = value(key, raw);
      const label = /Ids$/.test(key) && Array.isArray(raw) ? plural(idWord(key)) : isUuid(raw) ? words(key.replace(/Id$/, "") || key) : words(key);
      return shown ? `- ${label}: ${shown}` : null;
    })
    .filter((line): line is string => Boolean(line));
  const kept = lines.slice(0, 10);
  if (lines.length > kept.length) kept.push(`- …and ${lines.length - kept.length} more`);
  return kept.length ? `${head}:\n${kept.join("\n")}` : head;
}
