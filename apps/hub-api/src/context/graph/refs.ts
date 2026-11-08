/**
 * Handles for records in the context graph. Agents and the Hub name a record as
 * `ensemble://<kind>/<id>` (the same links Ensemble Node replies use); people also paste Hub
 * links (`/tasks/<id>`, `https://app…/projects/<id>`), and tools pass `{kind, id}`.
 */
export const GRAPH_KINDS = ["task", "project", "person", "repo", "deliverable", "meeting", "file", "page", "event"] as const;
export type GraphKind = (typeof GRAPH_KINDS)[number];

export interface ItemRef {
  kind: GraphKind;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID.test(value);

const ALIASES: Record<string, GraphKind> = {
  people: "person",
  persons: "person",
  contact: "person",
  repository: "repo",
  repositories: "repo",
  repos: "repo",
  meeting_note: "meeting",
  meeting_notes: "meeting",
  meetings: "meeting",
  note: "meeting",
  notes: "meeting",
  session: "meeting",
  sessions: "meeting",
  document: "file",
  documents: "file",
  files: "file",
  tasks: "task",
  todo: "task",
  projects: "project",
  deliverables: "deliverable",
  milestone: "deliverable",
  pages: "page",
  events: "event",
  calendar: "event",
};

/** A kind as an agent or a link writes it → the graph kind, or null. */
export function graphKind(word: string | null | undefined): GraphKind | null {
  if (!word) return null;
  const lower = word.trim().toLowerCase();
  if ((GRAPH_KINDS as readonly string[]).includes(lower)) return lower as GraphKind;
  return ALIASES[lower] ?? null;
}

/** Hub paths a person pastes, by their first segment. */
const PATH_KINDS: Record<string, GraphKind> = { tasks: "task", projects: "project", pages: "page", files: "file" };

/**
 * One record from what an agent passed: `ensemble://task/<id>`, `task/<id>`, `task:<id>`, a Hub link,
 * `{kind, id}`, or a bare id with `fallbackKind`. Null when it names no record.
 */
export function parseItemRef(input: string | { kind?: string | null; id?: string | null } | null | undefined, fallbackKind?: string | null): ItemRef | null {
  if (!input) return null;
  if (typeof input === "object") {
    const kind = graphKind(input.kind ?? fallbackKind);
    const id = (input.id ?? "").trim();
    return kind && isUuid(id) ? { kind, id: id.toLowerCase() } : null;
  }
  const text = input.trim().replace(/^<|>$/g, "");
  const link = /^ensemble:\/\/([a-z_]+)\/([0-9a-f-]{36})/i.exec(text) ?? /^([a-z_]+)[/:]([0-9a-f-]{36})$/i.exec(text);
  if (link) {
    const kind = graphKind(link[1]);
    return kind && isUuid(link[2]!) ? { kind, id: link[2]!.toLowerCase() } : null;
  }
  const query = /[?&](session|note|meeting|person|deliverable)=([0-9a-f-]{36})/i.exec(text);
  if (query && isUuid(query[2]!)) {
    const word = query[1]!.toLowerCase();
    const kind: GraphKind = word === "person" ? "person" : word === "deliverable" ? "deliverable" : "meeting";
    return { kind, id: query[2]!.toLowerCase() };
  }
  const path = /(?:^|\/)(tasks|projects|pages|files)\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(text);
  if (path) return { kind: PATH_KINDS[path[1]!.toLowerCase()]!, id: path[2]!.toLowerCase() };
  if (isUuid(text)) {
    const kind = graphKind(fallbackKind);
    return kind ? { kind, id: text.toLowerCase() } : null;
  }
  return null;
}

/** The handle for a record, as tools return and accept it. */
export function refOf(kind: string, id: string): string {
  return `ensemble://${kind}/${id}`;
}

/** Page mention kinds (`people`, `file`…) → the kind a graph item card carries. */
export function mentionGraphKind(kind: string): string {
  return kind === "people" ? "person" : kind;
}

/** Where a record opens in the Hub, as a path (the same places page mentions open). */
export function hubPath(kind: string, id: string, label = ""): string | null {
  const encoded = encodeURIComponent(id);
  switch (kind) {
    case "task":
      return `/tasks/${encoded}`;
    case "project":
      return `/projects/${encoded}`;
    case "deliverable":
      return `/today?deliverable=${encoded}`;
    case "person":
      return `/context?tab=people&person=${encoded}${label ? `&search=${encodeURIComponent(label)}` : ""}`;
    case "repo":
      return `/context?tab=repos&repo=${encoded}`;
    case "meeting":
      return `/meetings?note=${encoded}`;
    case "session":
      return `/meetings?session=${encoded}`;
    case "file":
      return `/files/${encoded}`;
    case "page":
      return `/pages/${encoded}`;
    case "event":
      return "/meetings";
    case "skill":
      return `/skills?skill=${encoded}`;
    case "diagram":
      return `/diagrams/${encoded}`;
    case "plot":
      return `/plots/${encoded}`;
    default:
      return null;
  }
}
