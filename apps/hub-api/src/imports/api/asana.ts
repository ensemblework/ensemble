/** Asana REST: projects per workspace, plus each workspace's "My tasks". */
import { cleanTitle } from "../mapping.js";
import type { ApiImportSource, ImportContainer, ImportItem, SourceContext } from "../types.js";

const API = "https://app.asana.com/api/1.0";
const TASK_FIELDS = [
  "name", "notes", "due_on", "due_at", "start_on", "completed", "completed_at", "assignee.name", "tags.name", "permalink_url",
  "memberships.section.name", "memberships.project.gid", "memberships.project.name", "created_at", "modified_at", "parent.name",
].join(",");

interface Page<T> { data: T[]; next_page?: { offset?: string } | null }
interface AsanaTask {
  gid: string;
  name?: string;
  notes?: string;
  due_on?: string | null;
  due_at?: string | null;
  start_on?: string | null;
  completed?: boolean;
  completed_at?: string | null;
  assignee?: { name?: string } | null;
  tags?: Array<{ name?: string }>;
  permalink_url?: string;
  memberships?: Array<{ section?: { name?: string } | null; project?: { gid: string; name?: string } | null }>;
  created_at?: string;
  modified_at?: string;
  parent?: { name?: string } | null;
}

const headers = (ctx: SourceContext) => ({ Authorization: `Bearer ${ctx.auth.token}` });

async function* pages<T>(ctx: SourceContext, path: string, params: Record<string, string>): AsyncGenerator<T[]> {
  let offset: string | undefined;
  do {
    const query = new URLSearchParams({ ...params, limit: "100", ...(offset ? { offset } : {}) });
    const page = await ctx.http.json<Page<T>>(`${API}${path}?${query}`, { headers: headers(ctx) });
    yield page.data ?? [];
    offset = page.next_page?.offset ?? undefined;
  } while (offset && !ctx.signal.aborted);
}

export function asanaTaskItem(task: AsanaTask, container: ImportContainer): ImportItem {
  const membership = task.memberships?.find((entry) => entry.project?.gid === container.id) ?? task.memberships?.[0];
  return {
    kind: "task",
    externalId: task.gid,
    title: cleanTitle(task.name),
    description: [task.notes ?? "", task.parent?.name ? `Subtask of ${task.parent.name}` : ""].filter(Boolean).join("\n\n") || null,
    dueDate: task.due_at ?? task.due_on ?? null,
    startDate: task.start_on ?? null,
    status: membership?.section?.name ?? null,
    done: Boolean(task.completed),
    labels: (task.tags ?? []).map((tag) => tag.name ?? ""),
    assignees: task.assignee?.name ? [task.assignee.name] : [],
    url: task.permalink_url ?? null,
    containerId: container.id,
    projectRef: membership?.project?.gid ?? null,
    projectName: membership?.project?.name ?? null,
    createdAt: task.created_at ?? null,
    updatedAt: task.modified_at ?? null,
    completedAt: task.completed_at ?? null,
  };
}

export const asanaSource: ApiImportSource = {
  id: "asana",
  async listContainers(ctx) {
    const containers: ImportContainer[] = [];
    for await (const workspaces of pages<{ gid: string; name: string }>(ctx, "/workspaces", {})) {
      for (const workspace of workspaces) {
        containers.push({ id: `mine:${workspace.gid}`, name: `My tasks in ${workspace.name}`, kind: "view", count: null, parent: workspace.name, importAs: "tasks" });
        for await (const projects of pages<{ gid: string; name: string }>(ctx, "/projects", { workspace: workspace.gid, archived: "false", opt_fields: "name" })) {
          for (const project of projects) containers.push({ id: project.gid, name: project.name, kind: "project", count: null, parent: workspace.name, importAs: "tasks" });
        }
      }
    }
    return containers;
  },
  async *fetchItems(ctx, containers) {
    const open: Record<string, string> = ctx.options.includeCompleted === false ? { completed_since: "now" } : {};
    for (const container of containers) {
      const params: Record<string, string> = container.id.startsWith("mine:")
        ? { assignee: "me", workspace: container.id.slice(5), opt_fields: TASK_FIELDS, ...open }
        : { project: container.id, opt_fields: TASK_FIELDS, ...open };
      for await (const tasks of pages<AsanaTask>(ctx, "/tasks", params)) yield tasks.map((task) => asanaTaskItem(task, container));
    }
  },
};
