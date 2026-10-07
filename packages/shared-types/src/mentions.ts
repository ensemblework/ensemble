import { EntityMentionKind, type MentionKind } from "./assistant.js";
import { PageDocument, PageMention, type PageNode } from "./domain.js";

const MENTION_ALIASES: Record<string, MentionKind> = {
  person: "people",
  people: "people",
  project: "project",
  projects: "project",
  repo: "repo",
  repository: "repo",
  task: "task",
  tasks: "task",
  todo: "task",
  deliverable: "deliverable",
  deliverables: "deliverable",
  skill: "skill",
  skills: "skill",
  diagram: "diagram",
  diagrams: "diagram",
  plot: "plot",
  plots: "plot",
  dataset: "dataset",
  data: "dataset",
  date: "date",
};

export function mentionQuery(query: string): { kind: MentionKind; search: string } | null {
  const colon = query.indexOf(":");
  if (colon < 0) return null;
  const raw = query.slice(0, colon).toLowerCase();
  const kind = MENTION_ALIASES[raw];
  return kind ? { kind, search: query.slice(colon + 1).trim() } : null;
}

export function mentionHref(mention: PageMention): string | undefined {
  const id = encodeURIComponent(mention.id);
  const label = encodeURIComponent(mention.label);
  switch (mention.kind) {
    case "task":
      return `/tasks/${id}`;
    case "project":
      return `/projects/${id}`;
    case "people":
      return `/context?tab=people&search=${label}`;
    case "repo":
      return `/context?tab=repos&search=${label}`;
    case "skill":
      return `/skills?skill=${id}`;
    case "diagram":
      return `/diagrams/${id}`;
    case "plot":
      if (mention.id.includes("/")) {
        const [spaceId, tileId] = mention.id.split("/");
        return `/plots?space=${encodeURIComponent(spaceId!)}&tile=${tileId}`;
      }
      return `/plots/${id}`;
    case "dataset":
      return "/plots";
    case "deliverable":
      return `/today?deliverable=${id}`;
    case "date":
      return undefined;
    default:
      return undefined;
  }
}

export function dateMention(value: string): PageMention | null {
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?$/.test(value)) return null;
  const dateOnly = value.length === 10;
  const date = new Date(dateOnly ? `${value}T12:00:00` : value.replace(" ", "T"));
  if (!Number.isFinite(date.getTime())) return null;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) {
    return null;
  }
  return {
    kind: "date",
    id: dateOnly ? value : date.toISOString(),
    label: new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      ...(dateOnly ? {} : { hour: "2-digit", minute: "2-digit" }),
    }).format(date),
  };
}

export const isEntityKind = (kind: MentionKind): kind is EntityMentionKind =>
  EntityMentionKind.safeParse(kind).success;

export function documentMentions(document: PageDocument): PageMention[] {
  const found = new Map<string, PageMention>();
  const walk = (node: PageNode) => {
    if (node.type === "mention" && node.attrs) {
      const mention = PageMention.parse({
        kind: String(node.attrs.kind ?? "people"),
        id: String(node.attrs.id ?? ""),
        label: String(node.attrs.label ?? ""),
      });
      if (mention.id) found.set(JSON.stringify([mention.kind, mention.id]), mention);
    }
    node.content?.forEach(walk);
  };
  document.content.forEach(walk);
  return [...found.values()];
}

/**
 * TipTap serialises mentions as links with a `ensemble:` href. Reload those
 * back into mention nodes so the editor and the page store share one document.
 */
export function restoreMentionLinks(document: PageDocument): PageDocument {
  const restore = (node: PageNode): PageNode => {
      const link = node.marks?.find((mark: { type: string; attrs?: Record<string, unknown> }) => mark.type === "link");
    if (node.type === "text" && link?.attrs?.href) {
      const href = String(link.attrs.href);
      const question = href.match(/^ensemble:\/\/ask\/([0-9a-f-]{36})$/i);
      if (question) return { type: "ensemble", attrs: { id: question[1]! } };
      const match = href.match(/^ensemble:\/\/(people|project|repo|task|deliverable|skill|diagram|plot|dataset|date)\/(.+)$/);
      if (match) {
        const mention = PageMention.parse({
          kind: match[1],
          id: decodeURIComponent(match[2]!),
          label: node.text?.replace(/^@+/, "") ?? "",
        });
        return { type: "mention", attrs: mention };
      }
    }
    return node.content ? { ...node, content: node.content.map(restore) } : node;
  };
  return { type: "doc", content: document.content.map(restore) };
}
