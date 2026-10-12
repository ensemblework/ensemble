/**
 * The @ menu: one engine for the page editor and every plain text box.
 *
 * `@` lists the groups. `@people` or `@people:` scopes to one kind, `@people:mi`
 * searches inside it, and plot spaces nest (`@plots:<space>:`). Anything else,
 * like `@anik`, searches every kind and ranks the best match first, so Enter
 * picks it.
 */
import { MENTION_PREFIX, dateMention, fileFormat, mentionAlias, mentionQuery, mentionToken, type MentionKind } from "@ensemble/shared-types";
import type { Entity } from "../api";
import { isoDate } from "../format";

export type EntitySource = () => Entity[];

export type MentionMenuItem =
  | { type: "group"; kind: string; label: string; detail: string; prefix: string; shortcut?: string }
  | { type: "action"; kind: "ensemble"; id: string; label: string; detail: string }
  | { type: "entity"; kind: string; id: string; label: string; detail: string; kindLabel?: string }
  | { type: "create"; kind: string; id: string; label: string; detail: string }
  | { type: "hint"; kind: string; label: string; detail: string };

export const MENTION_GROUPS: ReadonlyArray<{ kind: MentionKind; label: string; detail: string }> = [
  { kind: "people", label: "People", detail: "Mention someone in your workspace" },
  { kind: "project", label: "Projects", detail: "Link a project" },
  { kind: "repo", label: "Repositories", detail: "Link a repository" },
  { kind: "task", label: "Tasks / todos", detail: "Refer to another task" },
  { kind: "deliverable", label: "Deliverables", detail: "Link an outcome" },
  { kind: "skill", label: "Skills", detail: "Reference a personal skill" },
  { kind: "diagram", label: "Diagrams", detail: "Link a block diagram" },
  { kind: "plot", label: "Plots", detail: "Browse plot spaces, tiles, and data files" },
  { kind: "file", label: "Files", detail: "Attach a file you uploaded or imported" },
  { kind: "date", label: "Date & time", detail: "Mention a date without changing the due date" },
];

/** Every word that names a group, so `@proj` or `@todo` finds it. */
const GROUP_WORDS: Record<string, string[]> = {
  people: ["people", "person"],
  project: ["project", "projects"],
  repo: ["repo", "repository"],
  task: ["task", "tasks", "todo"],
  deliverable: ["deliverable", "deliverables"],
  skill: ["skill", "skills"],
  diagram: ["diagram", "diagrams"],
  plot: ["plot", "plots", "data", "dataset"],
  file: ["file", "files", "attachment"],
  date: ["date"],
};

export const KIND_LABEL: Record<string, string> = {
  people: "Person",
  project: "Project",
  repo: "Repository",
  task: "Task",
  deliverable: "Deliverable",
  skill: "Skill",
  diagram: "Diagram",
  plot: "Plot",
  dataset: "Data file",
  file: "File",
  date: "Date",
};

/** When two matches are equally good, the kind people reach for most comes first. */
const KIND_ORDER = ["people", "project", "task", "deliverable", "file", "diagram", "plot", "dataset", "repo", "skill"];

const ASK_ENSEMBLE: MentionMenuItem = { type: "action", kind: "ensemble", id: "ask-ensemble", label: "Ask Ensemble", detail: "Ask about this page, or create a diagram or plot" };
export const NEW_DIAGRAM: MentionMenuItem = { type: "create", kind: "diagram", id: "new-diagram", label: "New diagram", detail: "Start a blank diagram and mention it here" };

const UNSCOPED_LIMIT = 10;
const SCOPED_LIMIT = 40;

function groupItem(group: { kind: MentionKind; label: string; detail: string }): MentionMenuItem {
  const prefix = `${MENTION_PREFIX[group.kind]}:`;
  return { type: "group", kind: group.kind, label: group.label, detail: group.detail, prefix, shortcut: `@${prefix}` };
}

/** A file's detail leads with its type ("PDF · 2.1 MB") unless the server's detail already names it. */
function entityItem(row: Entity, kindLabel?: string): MentionMenuItem {
  const item = { type: "entity" as const, ...row, ...(kindLabel ? { kindLabel } : {}) };
  if (row.kind !== "file") return item;
  const type = fileFormat(row.label).label;
  const detail = row.detail && row.detail.toLowerCase().includes(type.toLowerCase()) ? row.detail : [type, row.detail].filter(Boolean).join(" · ");
  return { ...item, detail };
}

/** 0 exact, 1 starts with, 2 a word starts with, 3 contains, null no match. Case-insensitive. */
export function matchQuality(text: string, needle: string): number | null {
  const value = text.toLowerCase();
  if (!needle) return 0;
  if (value === needle) return 0;
  if (value.startsWith(needle)) return 1;
  let found = false;
  for (let at = value.indexOf(needle); at >= 0; at = value.indexOf(needle, at + 1)) {
    found = true;
    if (/[^\p{L}\p{N}]/u.test(value[at - 1] ?? " ")) return 2;
  }
  return found ? 3 : null;
}

/** People match on their email too, below any match on the name. */
function entityQuality(row: Entity, needle: string): number | null {
  const label = matchQuality(row.label, needle);
  if (label !== null) return label;
  if (row.kind !== "people" || !row.detail) return null;
  const detail = matchQuality(row.detail, needle);
  return detail === null ? null : detail <= 2 ? 4 : 5;
}

const AUTOMATED_WORD = /^(?:no-?reply|do-?not-?reply|notifications?|alerts?|support|updates?|news(?:letter)?|mailer(?:-daemon)?|digest|billing|info|hello|team|admin|service)$/i;

/**
 * Mail senders such as `alerts`, `support` or `nse_alerts`. They stay in the list,
 * after people with real names that match as well.
 */
export function looksAutomated(label: string): boolean {
  const name = label.trim();
  if (!name || /[@_]/.test(name)) return true;
  if (/\s/.test(name)) return false;
  return !/\p{Lu}/u.test(name) || AUTOMATED_WORD.test(name);
}

type Ranked = { item: MentionMenuItem; quality: number; automated: boolean; tier: number; kind: number; index: number };

function byRank(a: Ranked, b: Ranked): number {
  return a.quality - b.quality || Number(a.automated) - Number(b.automated) || a.tier - b.tier || a.kind - b.kind || a.index - b.index;
}

function kindRank(kind: string): number {
  const at = KIND_ORDER.indexOf(kind);
  return at < 0 ? KIND_ORDER.length : at;
}

export function dateItems(search: string, now = new Date()): MentionMenuItem[] {
  const add = (days: number) => {
    const date = new Date(now);
    date.setDate(date.getDate() + days);
    return date;
  };
  const nextMonday = add(((8 - now.getDay()) % 7) || 7);
  const presets: Array<[string, Date]> = [
    ["Today", now],
    ["Tomorrow", add(1)],
    ["Next Monday", nextMonday],
    ["In a week", add(7)],
  ];
  const items: MentionMenuItem[] = [];
  const typed = dateMention(search.trim());
  if (typed) items.push({ type: "entity", kind: "date", id: typed.id, label: typed.label, detail: "The date you typed" });
  for (const [name, date] of presets) {
    if (search && !name.toLowerCase().includes(search.trim().toLowerCase())) continue;
    const mention = dateMention(isoDate(date));
    if (mention) items.push({ type: "entity", kind: "date", id: mention.id, label: mention.label, detail: name });
  }
  if (!items.length) items.push({ type: "hint", kind: "date", label: "Type a date", detail: "YYYY-MM-DD or YYYY-MM-DD HH:MM" });
  return items;
}

function plotItems(search: string, rows: Entity[]): MentionMenuItem[] {
  const parts = search.split(":");
  const parent = parts.length > 1 ? parts.shift()!.trim().toLowerCase() : null;
  const needle = parts.join(":").trim().toLowerCase();
  if (parent) {
    const space = rows.find((row) => row.isSpace && (row.id.toLowerCase() === parent || row.label.toLowerCase() === parent));
    const parentId = space?.id ?? (parent === "data" || parent === "data files" ? "data" : parent === "saved" || parent === "saved plots" ? "saved" : null);
    if (!parentId) return [];
    return rows.filter((row) => row.parentId === parentId && row.label.toLowerCase().includes(needle))
      .slice(0, SCOPED_LIMIT).map((row) => entityItem(row));
  }
  const spaces: MentionMenuItem[] = rows.filter((row) => row.isSpace && row.label.toLowerCase().includes(needle))
    .map((row) => ({ type: "group", kind: "plot", label: row.label, detail: row.detail, prefix: `plots:${row.id}:` }));
  const saved: MentionMenuItem[] = "saved plots".includes(needle) && rows.some((row) => row.parentId === "saved")
    ? [{ type: "group", kind: "plot", label: "Saved plots", detail: "Browse saved charts", prefix: "plots:saved:" }] : [];
  const data = rows.filter((row) => row.kind === "dataset" && row.label.toLowerCase().includes(needle))
    .slice(0, 30).map((row) => entityItem(row));
  return [...spaces, ...saved, ...data];
}

function scopedItems(kind: MentionKind, search: string, rows: Entity[]): MentionMenuItem[] {
  if (kind === "date") return dateItems(search);
  if (kind === "plot") return plotItems(search, rows);
  const needle = search.trim().toLowerCase();
  const ranked: Ranked[] = [];
  rows.forEach((row, index) => {
    if (row.kind !== kind || row.isSpace) return;
    const quality = entityQuality(row, needle);
    if (quality === null) return;
    ranked.push({ item: entityItem(row), quality, automated: row.kind === "people" && looksAutomated(row.label), tier: 0, kind: 0, index });
  });
  return ranked.sort(byRank).slice(0, SCOPED_LIMIT).map((entry) => entry.item);
}

/**
 * The menu for what follows `@`. `editor` adds the page-only rows: Ask Ensemble
 * and New diagram. `diagramsOn` and `plotsOn` follow the modules; null means
 * the shell has not loaded yet, and counts as off.
 */
export function mentionItems(
  query: string,
  entities: EntitySource,
  diagramsOn: () => boolean | null,
  plotsOn: () => boolean | null,
  options: { editor?: boolean } = {},
): MentionMenuItem[] {
  const diagrams = diagramsOn() === true;
  const plots = plotsOn() === true;
  const allowed = (kind: string) => (kind !== "diagram" || diagrams) && (kind !== "plot" && kind !== "dataset" ? true : plots);
  const groups = MENTION_GROUPS.filter((group) => allowed(group.kind));
  const needle = query.trim().toLowerCase();
  if (!needle) return [...(options.editor ? [ASK_ENSEMBLE] : []), ...groups.map(groupItem)];

  const typed = mentionQuery(query);
  if (typed) return allowed(typed.kind) ? scopedItems(typed.kind, typed.search, entities()) : [];
  const bare = mentionAlias(needle);
  if (bare && allowed(bare)) {
    const group = MENTION_GROUPS.find((row) => row.kind === bare);
    return [...(group ? [groupItem(group)] : []), ...scopedItems(bare, "", entities())];
  }

  const rows = entities();
  const ranked: Ranked[] = [];
  if (options.editor) {
    const quality = Math.min(matchQuality("Ask Ensemble", needle) ?? 9, matchQuality("ensemble", needle) ?? 9);
    if (quality <= 2) ranked.push({ item: ASK_ENSEMBLE, quality, automated: false, tier: -1, kind: 0, index: 0 });
  }
  rows.forEach((row, index) => {
    if (!allowed(row.kind)) return;
    if (row.isSpace) {
      const quality = matchQuality(row.label, needle);
      if (quality !== null) ranked.push({ item: { type: "group", kind: "plot", label: row.label, detail: row.detail || "Plot space", prefix: `plots:${row.id}:` }, quality, automated: false, tier: 1, kind: kindRank("plot"), index });
      return;
    }
    const quality = entityQuality(row, needle);
    if (quality === null) return;
    ranked.push({
      item: entityItem(row, KIND_LABEL[row.kind] ?? row.kind),
      quality,
      automated: row.kind === "people" && looksAutomated(row.label),
      tier: 0,
      kind: kindRank(row.kind),
      index,
    });
  });
  groups.forEach((group, index) => {
    const words = [group.label, ...(GROUP_WORDS[group.kind] ?? [])];
    const quality = Math.min(...words.map((word) => matchQuality(word, needle) ?? 9));
    if (quality < 9) ranked.push({ item: groupItem(group), quality, automated: false, tier: 1, kind: 0, index });
  });
  return [
    ...ranked.sort(byRank).slice(0, UNSCOPED_LIMIT).map((entry) => entry.item),
    ...(options.editor && diagrams && (needle.includes("diagram") || needle === "new") ? [NEW_DIAGRAM] : []),
  ];
}

/** What a plain text box gets when this item is picked, or null when the item does nothing there. */
export function mentionInsertText(item: MentionMenuItem): string | null {
  if (item.type === "group") return `@${item.prefix}`;
  if (item.type === "action") return "@ensemble ";
  if (item.type === "entity" && item.kind in MENTION_PREFIX) return `${mentionToken(item.kind as MentionKind, item.label)} `;
  return null;
}
