import type { AppItem, AppItemContent, AppItemKind, AppItemSourceInfo, AttachedAppItem } from "@ensemble/shared-types";
import { del, get, post, request } from "./api";

/** The pair (source, kind, id) names one item in a connected app. */
export type AppItemRef = Pick<AppItem, "source" | "kind" | "id">;

/** What an attached item belongs to. */
export type AppItemOwner = { taskId: string } | { projectId: string };

export type AppItemSearchInput = { source?: string; q: string; kind?: AppItemKind; limit?: number };

export type AppItemSearchResult = {
  items: AppItem[];
  /** Apps that failed while the others answered. */
  errors: Array<{ source: string; message: string }>;
};

/** The issue, card or ticket a task can post an update to. */
export type UpdateTarget = { source: string; kind: AppItemKind; id: string; title: string; url?: string };

export type PeopleImport = { seen: number; added: number; matched: number; skipped: number };

const encode = encodeURIComponent;

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

const ownerKey = (owner: AppItemOwner) => ("taskId" in owner ? `task:${owner.taskId}` : `project:${owner.projectId}`);

export const APP_ITEM_QUERY = {
  sources: ["app-item-sources"] as const,
  search: (input: AppItemSearchInput) => ["app-item-search", input.source ?? "", input.kind ?? "", input.q, input.limit ?? 0] as const,
  read: (ref: AppItemRef) => ["app-item-read", ref.source, ref.kind, ref.id] as const,
  attached: (owner: AppItemOwner) => ["app-items-attached", ownerKey(owner)] as const,
  updateTarget: (taskId: string) => ["app-item-update-target", taskId] as const,
};

export const appItemsApi = {
  sources: () => get<{ sources: AppItemSourceInfo[] }>("/api/app-items/sources"),
  search: (input: AppItemSearchInput, signal?: AbortSignal) =>
    request<AppItemSearchResult>(`/api/app-items/search${query({ source: input.source, q: input.q, kind: input.kind, limit: input.limit })}`, { signal }),
  read: (ref: AppItemRef) => post<{ item: AppItemContent }>("/api/app-items/read", { source: ref.source, kind: ref.kind, id: ref.id }),
  attached: (owner: AppItemOwner) => get<{ items: AttachedAppItem[] }>(`/api/app-items/attached${query(owner)}`),
  attach: (ref: AppItemRef, owner: AppItemOwner) => post<{ item: AttachedAppItem }>("/api/app-items/attach", { source: ref.source, kind: ref.kind, id: ref.id, ...owner }),
  refresh: (artifactId: string) => post<{ item: AttachedAppItem }>(`/api/app-items/attached/${encode(artifactId)}/refresh`),
  detach: (artifactId: string, owner: AppItemOwner) => del<void>(`/api/app-items/attached/${encode(artifactId)}${query(owner)}`),
  toTask: (ref: AppItemRef, projectId?: string) =>
    post<{ taskId: string; created: boolean }>("/api/app-items/task", { source: ref.source, kind: ref.kind, id: ref.id, ...(projectId ? { projectId } : {}) }),
  addPeople: (source: string) => post<PeopleImport>("/api/app-items/people", { source }),
  updateTarget: (taskId: string) => get<{ target: UpdateTarget | null }>(`/api/app-items/update-target${query({ taskId })}`),
  postUpdate: (taskId: string, body: string) => post<{ source: string; url?: string }>("/api/app-items/update", { taskId, body }),
};
