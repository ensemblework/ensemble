import { get, post, request, type TaskStatus } from "./api";

export type ImportSourceId = "notion" | "linear" | "jira" | "trello" | "asana" | "todoist" | "clickup" | "monday" | "github" | "csv";
export type CsvField = "title" | "due" | "start" | "labels" | "status" | "priority" | "assignee" | "description" | "project" | "url" | "id" | "done" | "completedAt" | "parent";
export type ImportAs = "tasks" | "pages";

export type ImportSourceInfo = {
  id: ImportSourceId;
  name: string;
  logo: string;
  connectorId: string | null;
  api: boolean;
  connected: boolean;
  tokenUrl: string | null;
  tokenHint: string | null;
  tokenFields: Array<"email" | "site" | "key">;
  files: string[];
  exportHelp: string | null;
  brings: string[];
};

export type ImportContainer = {
  id: string;
  name: string;
  kind: string;
  count: number | null;
  parent?: string | null;
  importAs: ImportAs;
};

export type ImportStatusFound = { value: string; count: number; proposed: TaskStatus };

export type ImportTable = {
  containerId: string;
  headers: string[];
  preset: string;
  presetLabel: string;
  columns: Partial<Record<CsvField, string[]>>;
};

export type ImportSample = {
  kind: "task" | "page" | "project";
  containerId: string | null;
  title: string;
  status: string | null;
  due: string | null;
  labels: string[];
  assignees: string[];
  project: string | null;
  priority: string | null;
};

export type ImportPreview = {
  previewId: string;
  source: ImportSourceId;
  sourceLabel: string;
  via: "account" | "token" | "file";
  format: string | null;
  formatLabel: string | null;
  fileName: string | null;
  containers: ImportContainer[];
  mapping: { fields: CsvField[]; tables: ImportTable[]; statuses: ImportStatusFound[] };
  samples: ImportSample[];
  summary: { containers: number; items: number | null; sampled: boolean };
  expiresAt: string;
};

type Counts = { created: number; updated: number; unchanged: number };

export type ImportJobRecord = {
  id: string;
  source: ImportSourceId;
  sourceLabel: string;
  status: "queued" | "running" | "cancelling" | "done" | "failed" | "cancelled" | "interrupted" | "undone";
  error: string | null;
  counts: {
    tasks?: Counts;
    pages?: Counts & { keptEdits: number };
    projects?: { created: number; linked: number };
    skipped?: number;
    failed?: number;
  };
  progress: {
    phase: "starting" | "fetching" | "writing" | "finished";
    fetched: number;
    written: number;
    total: number | null;
    note: string | null;
    created: { tasks: number; pages: number; projects: number };
    undone: { tasks: number; pages: number; projects: number; at: string } | null;
  };
  links: { projects: Array<{ id: string; name: string }>; labels: string[]; pages: string[] };
  containers: Array<{ id: string; name: string }>;
  fileName: string | null;
  canUndo: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

export type ImportCredentials = { token?: string; email?: string; site?: string; key?: string };

export type StartImportInput = {
  previewId: string;
  containers: string[];
  statusMap?: Record<string, TaskStatus>;
  importAs?: Record<string, ImportAs>;
  columns?: Record<string, Partial<Record<CsvField, string[]>>>;
  options?: { includeCompleted?: boolean };
};

export const ACTIVE_IMPORT = new Set(["queued", "running", "cancelling"]);

export const importsApi = {
  sources: () => get<{ sources: ImportSourceInfo[] }>("/api/imports/sources"),
  connect: (source: ImportSourceId, credentials?: ImportCredentials) =>
    post<ImportPreview>("/api/imports/preview", { source, ...(credentials?.token ? { credentials } : {}) }),
  refine: (
    previewId: string,
    containers: string[],
    extra: { columns?: StartImportInput["columns"]; options?: StartImportInput["options"] } = {},
  ) => post<ImportPreview>("/api/imports/preview", { previewId, containers, ...extra }),
  upload: (source: ImportSourceId, file: File) => {
    const form = new FormData();
    form.append("source", source);
    form.append("file", file, file.name);
    return request<ImportPreview>("/api/imports/preview", { method: "POST", body: form });
  },
  start: (input: StartImportInput) => post<{ job: ImportJobRecord }>("/api/imports", input),
  jobs: () => get<{ jobs: ImportJobRecord[] }>("/api/imports"),
  job: (id: string) => get<{ job: ImportJobRecord }>(`/api/imports/${encodeURIComponent(id)}`),
  cancel: (id: string) => post<{ job: ImportJobRecord }>(`/api/imports/${encodeURIComponent(id)}/cancel`),
  undo: (id: string) => post<{ job: ImportJobRecord }>(`/api/imports/${encodeURIComponent(id)}/undo`),
};
