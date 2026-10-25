/**
 * Assistant replies name workspace records by title, not by id (docs/11 §4.1).
 *
 * Ids stay in machine-readable places: tool data, `AssistantRef` lists and link targets. This turns
 * reply text into what a person reads, given the records the turn knows: `[@Label](ensemble://kind/id)`
 * links show their label, and a bare id of a known record becomes its title, linked. Unknown ids,
 * code, block quotes, URLs and link targets are left alone, and nothing changes when the person
 * asked for ids. Pure, so the dock, the inline page answers and the server share it.
 */
import { EntityMentionKind, type AssistantRef } from "./assistant.js";
import { mentionAlias, mentionHref } from "./mentions.js";

export const UUID_SOURCE = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const UUID_ONLY = new RegExp(`^${UUID_SOURCE}$`);

export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_ONLY.test(value);

/** The person asked to see ids: replies then show them as written. */
export function asksForIds(message: string | null | undefined): boolean {
  return Boolean(message && /\b(?:ids?|uuids?|identifiers?)\b/i.test(message));
}

const ENTITY_KINDS = new Set<string>(EntityMentionKind.options);
const EXTRA_KINDS = new Set(["page", "meeting", "reminder"]);

/** A kind as written in a link or a tool result (`person`, `tasks`, `page`) → the ref kind, or null. */
export function refKind(word: string): string | null {
  const lower = word.toLowerCase();
  if (EXTRA_KINDS.has(lower)) return lower;
  if (EXTRA_KINDS.has(lower.replace(/s$/, ""))) return lower.replace(/s$/, "");
  const kind = mentionAlias(lower);
  return kind && ENTITY_KINDS.has(kind) ? kind : null;
}

/** Where a record opens in the Hub, or null when it has no page of its own. */
export function refPath(ref: Pick<AssistantRef, "kind" | "id" | "label">): string | null {
  if (ref.kind === "page") return `/pages/${encodeURIComponent(ref.id)}`;
  if (ref.kind === "meeting") return `/meetings?session=${encodeURIComponent(ref.id)}`;
  if (!ENTITY_KINDS.has(ref.kind)) return null;
  return mentionHref({ kind: ref.kind as EntityMentionKind, id: ref.id, label: ref.label }) ?? null;
}

/** How a record is written for a model: `[Label](ensemble://kind/id)`. */
export function refLink(ref: Pick<AssistantRef, "kind" | "id" | "label">): string {
  return `[${cleanLabel(ref.label)}](ensemble://${ref.kind}/${encodeURIComponent(ref.id)})`;
}

const KIND_WORD: Record<string, string> = {
  people: "person",
  project: "project",
  repo: "repository",
  task: "task",
  deliverable: "deliverable",
  skill: "skill",
  diagram: "diagram",
  plot: "plot",
  dataset: "dataset",
  file: "file",
  page: "page",
  meeting: "meeting notes",
  reminder: "reminder",
};

const cleanLabel = (label: string) => label.replace(/\s+/g, " ").replace(/\[/g, "(").replace(/\]/g, ")").trim();

/** Records whose id appears in the text, in the order given. */
export function refsInText(text: string, refs: readonly AssistantRef[]): AssistantRef[] {
  if (!text || !refs.length) return [];
  const lower = text.toLowerCase();
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const id = ref.id.toLowerCase();
    if (seen.has(id) || !lower.includes(id)) return false;
    seen.add(id);
    return true;
  });
}

const LINKED = /\[@?([^\]\n]{1,200})\]\(ensemble:\/\/([a-z]+)\/([^)\s]+)\)|[“"]([^”"\n]{1,200})[”"] → ensemble:\/\/([a-z]+)\/([^\s;,)]+)/gi;

/** Records a text already names as links: `[Label](ensemble://kind/id)` or `“Label” → ensemble://kind/id`. */
export function linkedRefs(text: string): AssistantRef[] {
  const out: AssistantRef[] = [];
  for (const match of text.matchAll(LINKED)) {
    const label = (match[1] ?? match[4] ?? "").trim();
    const kind = refKind(match[2] ?? match[5] ?? "");
    let id = match[3] ?? match[6] ?? "";
    try {
      id = decodeURIComponent(id);
    } catch {
      continue;
    }
    if (kind && label && id && !isUuid(label)) out.push({ kind, id, label });
  }
  return out;
}

type Shown = AssistantRef & { original: string };

/** One display label per record; records that share a title get a qualifier so they stay apart. */
export function displayRefs(refs: readonly AssistantRef[]): Map<string, Shown> {
  const unique = new Map<string, AssistantRef>();
  for (const ref of refs) {
    if (!ref?.id || !ref.label?.trim()) continue;
    const key = ref.id.toLowerCase();
    if (!unique.has(key)) unique.set(key, ref);
  }
  const groups = new Map<string, AssistantRef[]>();
  for (const ref of unique.values()) {
    const key = cleanLabel(ref.label).toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), ref]);
  }
  const shown = new Map<string, Shown>();
  for (const group of groups.values()) {
    for (const ref of group) {
      const original = cleanLabel(ref.label);
      let label = original;
      if (group.length > 1) {
        const sameKind = group.filter((other) => other.kind === ref.kind);
        const detail = ref.detail?.trim();
        const qualifier =
          sameKind.length === 1
            ? (KIND_WORD[ref.kind] ?? ref.kind)
            : detail && sameKind.filter((other) => other.detail?.trim() === detail).length === 1
              ? detail
              : String(sameKind.indexOf(ref) + 1);
        label = `${original} (${qualifier})`;
      }
      shown.set(ref.id.toLowerCase(), { ...ref, label, original });
    }
  }
  return shown;
}

export interface EntityTextOptions {
  /** The person asked for ids: bare ids stay as written. Links still show their labels. */
  showIds?: boolean;
  /** The text is still arriving: a half-written id or record link at the end is held back. */
  streaming?: boolean;
  /** Labels only, no Markdown links (one-line summaries). */
  plain?: boolean;
  /** Where a record's link points. Default: its Hub path (`refPath`). Null: the label alone. */
  link?: (ref: AssistantRef) => string | null;
}

const KIND_WORDS = "(?:tasks?|projects?|people|persons?|repos?|repositor(?:y|ies)|deliverables?|skills?|diagrams?|plots?|datasets?|files?|pages?|meetings?|reminders?)";
const BARE_ID = new RegExp(`(?<![\\w/.=?&#%@-])(?:${KIND_WORDS}[:/])?(${UUID_SOURCE})(?![\\w-])`, "gi");
const OPENER = /\s*[([]\s*(?:[A-Za-z]+\s*[:#]?\s*)?$/;
const CLOSER = /^\s*[)\]]/;
const TITLE_END = /[”"'’*_]*$/;
const FENCE = /^\s{0,3}(?:`{3,}|~{3,})/;
const QUOTE = /^\s{0,3}>/;
/** Inline code, Markdown links, autolinks, web addresses and bare record links: each is one token. */
const TOKEN =
  /``[^`\n]+``|`[^`\n]+`|\[([^\]\n]*)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)|<[a-z][a-z0-9+.-]*:[^\s<>]*>|\b(?:https?|ftp|mailto|file):[^\s<>]+|\bwww\.[^\s<>]+|\bensemble:\/\/([a-z]+)\/([^\s)\]>]+)/gi;
const RECORD_LINK = /^ensemble:\/\/([a-z]+)\/(.+)$/i;

/** Drops a half-written record link or a known id at the very end of streaming text. */
function holdBack(text: string, ids: readonly string[]): string {
  let out = text;
  const link = /\[@?([^\]\n]*)\]\(([^)\s]*)$/.exec(out);
  if (link) out = out.slice(0, link.index) + link[1]!;
  out = out.replace(/\bensemble:\/\/\S*$/i, "");
  const run = /(?<![\w-])((?:[a-z]+[:/])?)([0-9a-f][0-9a-f-]{3,})(\s*)$/i.exec(out);
  if (run) {
    const partial = run[2]!.toLowerCase();
    const complete = run[2]!.length >= 36;
    const opened = OPENER.exec(out.slice(0, run.index));
    if (!complete && ids.some((id) => id.startsWith(partial))) {
      out = out.slice(0, opened && opened[0].trim() ? opened.index : run.index);
    } else if (complete && opened && opened[0].trim() && ids.includes(partial)) {
      // An annotation still waiting for its closing bracket: shown whole once it closes.
      out = out.slice(0, opened.index);
    }
  }
  return out;
}

/**
 * Reply text for a person: records named by title (linked unless `plain`), ids kept where the
 * person asked for them, in code and quotes, and in link targets.
 */
export function formatEntityText(text: string, given: readonly AssistantRef[], options: EntityTextOptions = {}): string {
  if (!text) return text;
  const refs = given.filter((ref) => ref && typeof ref.id === "string" && typeof ref.label === "string" && typeof ref.kind === "string");
  const source = options.streaming ? holdBack(text, refs.map((ref) => ref.id.toLowerCase())) : text;
  // Titles are told apart only among the records this text names.
  const named = displayRefs(refsInText(source, refs));
  const known = (id: string): Shown | undefined => named.get(id.toLowerCase());
  const target = (ref: AssistantRef) => (options.link ? options.link(ref) : refPath(ref));
  const show = (ref: AssistantRef, label = ref.label): string => {
    const clean = cleanLabel(label);
    if (options.plain) return clean;
    const href = target(ref);
    return href ? `[${clean}](${href})` : clean;
  };

  const ids = (segment: string): string => {
    if (options.showIds || !/[0-9a-f]{8}-/i.test(segment)) return segment;
    let out = segment;
    const matches = [...segment.matchAll(BARE_ID)].reverse();
    for (const match of matches) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      const ref = known(match[1]!);
      const before = out.slice(0, start);
      const after = out.slice(end);
      const opener = OPENER.exec(before);
      const closer = CLOSER.exec(after);
      if (opener && opener[0].trim() && closer) {
        const head = before.slice(0, opener.index);
        const tail = after.slice(closer[0].length);
        const quote = TITLE_END.exec(head)![0];
        const title = head.slice(0, head.length - quote.length);
        if (ref && title.toLowerCase().endsWith(ref.original.toLowerCase())) {
          const at = title.length - ref.original.length;
          out = title.slice(0, at) + show(ref, title.slice(at)) + quote + tail;
        } else if (ref) {
          const open = opener[0].replace(/[A-Za-z]+\s*[:#]?\s*$/, "").replace(/\s+$/, "");
          out = head + open + show(ref) + closer[0].trimStart() + tail;
        } else if (/[”"]$/.test(quote)) {
          // `“Title” (id)`: the id only annotates the title beside it.
          out = head + tail;
        }
        continue;
      }
      if (ref) out = before + show(ref) + after;
    }
    return out;
  };

  const line = (row: string): string => {
    let out = "";
    let last = 0;
    for (const match of row.matchAll(TOKEN)) {
      const at = match.index ?? 0;
      out += ids(row.slice(last, at));
      last = at + match[0].length;
      const whole = match[0];
      const dest = match[2] !== undefined ? match[2] : match[3] !== undefined ? whole : null;
      const record = dest ? RECORD_LINK.exec(dest) : null;
      const kind = record ? refKind(record[1]!) : null;
      if (!record || !kind) {
        out += whole;
        continue;
      }
      let id = record[2]!;
      try {
        id = decodeURIComponent(id);
      } catch {
        out += whole;
        continue;
      }
      const ref = known(id);
      const written = match[1] !== undefined ? match[1].replace(/^@+/, "").trim() : "";
      const label = written && !isUuid(written) ? written : (ref?.label ?? "");
      if (!label) {
        out += whole;
        continue;
      }
      out += show(ref ?? { kind, id, label }, label);
    }
    return out + ids(row.slice(last));
  };

  let fenced = false;
  return source
    .split("\n")
    .map((row) => {
      if (FENCE.test(row)) {
        fenced = !fenced;
        return row;
      }
      if (fenced || QUOTE.test(row)) return row;
      return line(row);
    })
    .join("\n");
}
