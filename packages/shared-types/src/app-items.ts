/**
 * Items in a person's connected apps (a Notion page, a GitHub repository, a Linear
 * issue, a Slack person…) that Ensemble can search, read and bring in: attached to
 * a task or project as context, turned into a task, or added as a person.
 * hub-api: src/connectors/items. Docs: docs/31_CONNECTORS_IN_USE.md.
 */

export type AppItemKind =
  | "page"
  | "database"
  | "repo"
  | "issue"
  | "pull_request"
  | "board"
  | "card"
  | "project"
  | "task"
  | "file"
  | "channel"
  | "person"
  | "ticket"
  | "conversation"
  | "contact"
  | "company"
  | "deal"
  | "design"
  | "deployment"
  | "dashboard"
  | "work_item"
  | "invoice"
  | "record"
  | "meeting"
  | "video"
  | "attachment"
  | "reference"
  | "collection";

export const APP_ITEM_KIND_LABEL: Readonly<Record<AppItemKind, string>> = {
  page: "Page",
  database: "Database",
  repo: "Repository",
  issue: "Issue",
  pull_request: "Pull request",
  board: "Board",
  card: "Card",
  project: "Project",
  task: "Task",
  file: "File",
  channel: "Channel",
  person: "Person",
  ticket: "Ticket",
  conversation: "Conversation",
  contact: "Contact",
  company: "Company",
  deal: "Deal",
  design: "Design",
  deployment: "Deployment",
  dashboard: "Dashboard",
  work_item: "Work item",
  invoice: "Invoice",
  record: "Record",
  meeting: "Meeting",
  video: "Video",
  attachment: "Email attachment",
  reference: "Reference",
  collection: "Collection",
};

/** Kinds that become an Ensemble task when brought in ("Add as task"). */
export const TASK_LIKE_KINDS: ReadonlySet<AppItemKind> = new Set<AppItemKind>(["issue", "pull_request", "card", "task", "ticket", "work_item", "conversation", "reference"]);

/** One search hit. `id` is the app's own id; the pair (source, kind, id) names it. */
export interface AppItem {
  /** Catalog id of the app: "notion", "github", "linear"… */
  source: string;
  kind: AppItemKind;
  id: string;
  title: string;
  /** Where it lives and its state, e.g. "fieldnote/web · open · #42". */
  subtitle?: string;
  url?: string;
  /** ISO timestamp. */
  updatedAt?: string;
}

/** What a read returns: the item and its text as Markdown, already capped. */
export interface AppItemContent extends AppItem {
  text: string;
  /** People named on the item (assignees, authors, members). */
  people?: AppItemPerson[];
  /** Small facts shown beside the text: status, labels, due date… */
  facts?: Record<string, string>;
}

export interface AppItemPerson {
  name: string;
  email?: string;
  /** The app's handle for the person (Slack user id, GitHub login…). */
  handle?: string;
  title?: string;
}

/** A connected app that Ensemble can search. */
export interface AppItemSourceInfo {
  id: string;
  name: string;
  logo: string;
  /** Kinds a search can return, in the order the picker offers them. */
  kinds: AppItemKind[];
  /** True when it can list people to add to Ensemble. */
  people: boolean;
  /** True when "Post an update" can comment on its issues, cards or tickets. */
  comments: boolean;
}

/** An item already attached to a task or project. */
export interface AttachedAppItem {
  artifactId: string;
  source: string;
  kind: AppItemKind;
  id: string;
  title: string;
  subtitle?: string;
  url?: string;
  attachedAt: string;
  /** Characters of text kept for the assistant and agents. */
  chars: number;
  taskId: string | null;
  projectId: string | null;
}
