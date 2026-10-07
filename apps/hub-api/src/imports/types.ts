import type { TaskSource, TaskStatus } from "@prisma/client";

export const IMPORT_SOURCES = ["notion", "linear", "jira", "trello", "asana", "todoist", "clickup", "monday", "github", "csv"] as const;
export type ImportSourceId = (typeof IMPORT_SOURCES)[number];

export type ImportItemKind = "task" | "page" | "project";

/** One thing from another app, already flattened. Every importer produces these; one writer stores them. */
export interface ImportItem {
  kind: ImportItemKind;
  externalId: string;
  title: string;
  /** Markdown. Short text stays on the task; long text moves to its page. */
  description?: string | null;
  /** YYYY-MM-DD for a date-only due, or an ISO datetime. */
  dueDate?: string | null;
  startDate?: string | null;
  /** The other app's status name, mapped with the import's status map. */
  status?: string | null;
  /** The other app's status group (Linear state type, Jira status category, ClickUp status type). Used when the name is unknown. */
  statusCategory?: string | null;
  /** True when the other app marks it complete regardless of status (checkbox, dueComplete, completed). */
  done?: boolean;
  priority?: string | null;
  labels?: string[];
  assignees?: string[];
  url?: string | null;
  /** Container id this item belongs to; used for per-container choices and the project link. */
  containerId?: string | null;
  projectRef?: string | null;
  projectName?: string | null;
  parentRef?: string | null;
  parentTitle?: string | null;
  /** Full page body in Markdown. */
  pageMarkdown?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  completedAt?: string | null;
}

export type ContainerKind = "database" | "project" | "board" | "team" | "list" | "repo" | "page" | "file" | "workspace" | "view";

export interface ImportContainer {
  id: string;
  name: string;
  kind: ContainerKind;
  /** Item count when the other app reports one cheaply; null when unknown. */
  count: number | null;
  /** Workspace, team or folder the container sits in, for display. */
  parent?: string | null;
  /** Default for this container. Notion databases default to tasks; plain pages to pages. */
  importAs?: ImportAs;
}

export interface SourceAuth {
  token: string;
  via: "account" | "token";
  /** Jira site host for token auth (fieldnote.atlassian.net). */
  site?: string;
  /** Jira account email for token auth. */
  email?: string;
  /** Trello app key. */
  key?: string;
  /** Atlassian cloud id for OAuth auth. */
  cloudId?: string;
}

export interface ImportHttpRequest {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ImportHttp {
  json<T>(url: string, init?: ImportHttpRequest): Promise<T>;
}

export interface SourceOptions {
  /** Linear and Jira: only issues assigned to me. */
  mine?: boolean;
  /** Include completed tasks where the API hides them by default (Todoist, ClickUp, GitHub). */
  includeCompleted?: boolean;
  /** Preview only: skip slow extras such as Notion page bodies. */
  preview?: boolean;
}

export interface SourceContext {
  auth: SourceAuth;
  http: ImportHttp;
  signal: AbortSignal;
  options: SourceOptions;
}

/** An app reached over its API. */
export interface ApiImportSource {
  id: ImportSourceId;
  listContainers(ctx: SourceContext): Promise<ImportContainer[]>;
  /** Pages of items for the chosen containers. Stops early when the signal aborts. */
  fetchItems(ctx: SourceContext, containers: ImportContainer[]): AsyncGenerator<ImportItem[]>;
}

export type ImportAs = "tasks" | "pages";

export interface ImportCounts {
  tasks: { created: number; updated: number; unchanged: number };
  pages: { created: number; updated: number; unchanged: number; keptEdits: number };
  projects: { created: number; linked: number };
  skipped: number;
  failed: number;
}

export function emptyCounts(): ImportCounts {
  return {
    tasks: { created: 0, updated: 0, unchanged: 0 },
    pages: { created: 0, updated: 0, unchanged: 0, keptEdits: 0 },
    projects: { created: 0, linked: 0 },
    skipped: 0,
    failed: 0,
  };
}

export interface WritePlan {
  /** Written to external_source so re-runs find the same rows. */
  externalSource: string;
  sourceKind: TaskSource;
  sourceLabel: string;
  /** Lower-cased raw status → Ensemble status. Anything missing falls back to guessStatus. */
  statusMap: Record<string, TaskStatus>;
  /** Per container: store items as tasks or as pages. */
  importAs: Record<string, ImportAs>;
}

export const SOURCE_KIND: Record<ImportSourceId, TaskSource> = {
  notion: "notion",
  linear: "linear",
  jira: "jira",
  trello: "trello",
  asana: "asana",
  todoist: "todoist",
  clickup: "clickup",
  monday: "monday",
  github: "github",
  csv: "other",
};

export const SOURCE_LABEL: Record<ImportSourceId, string> = {
  notion: "Notion",
  linear: "Linear",
  jira: "Jira",
  trello: "Trello",
  asana: "Asana",
  todoist: "Todoist",
  clickup: "ClickUp",
  monday: "monday.com",
  github: "GitHub",
  csv: "CSV",
};

export class ImportError extends Error {
  readonly expose = true;
  constructor(
    message: string,
    readonly statusCode = 400,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ImportError";
  }
}
