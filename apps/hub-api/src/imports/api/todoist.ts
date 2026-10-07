/** Todoist unified API v1 (https://api.todoist.com/api/v1). */
import type { ApiImportSource, ImportContainer, ImportItem, SourceContext } from "../types.js";

const API = "https://api.todoist.com/api/v1";
const COMPLETED_DAYS = 90;

interface Paged<T> { results?: T[]; items?: T[]; next_cursor?: string | null }
interface TodoistTask {
  id: string;
  project_id?: string;
  section_id?: string | null;
  parent_id?: string | null;
  content?: string;
  description?: string;
  labels?: string[];
  priority?: number;
  due?: { date?: string; datetime?: string | null; string?: string; is_recurring?: boolean } | null;
  deadline?: { date?: string } | null;
  checked?: boolean;
  is_deleted?: boolean;
  responsible_uid?: string | null;
  added_at?: string;
  updated_at?: string;
  completed_at?: string | null;
}

/** API priority 4 is p1 (urgent) in the app; 1 is the default. */
const PRIORITY: Record<number, string> = { 4: "urgent", 3: "high", 2: "medium", 1: "none" };

const headers = (ctx: SourceContext) => ({ Authorization: `Bearer ${ctx.auth.token}` });

async function* paged<T>(ctx: SourceContext, path: string, params: Record<string, string> = {}): AsyncGenerator<T[]> {
  let cursor: string | null | undefined;
  do {
    const query = new URLSearchParams({ limit: "200", ...params, ...(cursor ? { cursor } : {}) });
    const page = await ctx.http.json<Paged<T>>(`${API}${path}?${query}`, { headers: headers(ctx) });
    yield page.results ?? page.items ?? [];
    cursor = page.next_cursor;
  } while (cursor && !ctx.signal.aborted);
}

export function todoistTaskItem(task: TodoistTask, container: ImportContainer, sections: Map<string, string>, people: Map<string, string>): ImportItem {
  const due = task.due?.datetime ?? task.due?.date ?? null;
  const deadline = task.deadline?.date ?? null;
  const section = task.section_id ? sections.get(task.section_id) : undefined;
  const recurring = task.due?.is_recurring && task.due.string ? `Repeats: ${task.due.string}` : "";
  return {
    kind: "task",
    externalId: task.id,
    title: task.content ?? "",
    description: [task.description ?? "", recurring].filter(Boolean).join("\n\n") || null,
    dueDate: deadline ?? due,
    startDate: deadline ? due : null,
    done: Boolean(task.checked || task.completed_at),
    priority: PRIORITY[task.priority ?? 1] ?? null,
    labels: [...(task.labels ?? []), ...(section ? [section] : [])],
    assignees: task.responsible_uid ? [people.get(task.responsible_uid) ?? ""].filter(Boolean) : [],
    url: `https://app.todoist.com/app/task/${encodeURIComponent(task.id)}`,
    containerId: container.id,
    projectRef: container.id,
    projectName: container.name,
    createdAt: task.added_at ?? null,
    updatedAt: task.updated_at ?? null,
    completedAt: task.completed_at ?? null,
  };
}

export const todoistSource: ApiImportSource = {
  id: "todoist",
  async listContainers(ctx) {
    const containers: ImportContainer[] = [];
    for await (const projects of paged<{ id: string; name: string; is_archived?: boolean; is_deleted?: boolean; inbox_project?: boolean; is_shared?: boolean }>(ctx, "/projects")) {
      for (const project of projects) {
        if (project.is_archived || project.is_deleted) continue;
        containers.push({ id: project.id, name: project.name, kind: "project", count: null, parent: project.is_shared ? "Shared" : null, importAs: "tasks" });
      }
    }
    return containers;
  },
  async *fetchItems(ctx, containers) {
    for (const container of containers) {
      const sections = new Map<string, string>();
      for await (const batch of paged<{ id: string; name: string }>(ctx, "/sections", { project_id: container.id })) {
        for (const section of batch) sections.set(section.id, section.name);
      }
      const people = new Map<string, string>();
      if (container.parent === "Shared") {
        for await (const batch of paged<{ id: string; name?: string; email?: string }>(ctx, `/projects/${encodeURIComponent(container.id)}/collaborators`)) {
          for (const person of batch) people.set(person.id, person.name || person.email || "");
        }
      }
      for await (const tasks of paged<TodoistTask>(ctx, "/tasks", { project_id: container.id })) {
        yield tasks.filter((task) => !task.is_deleted).map((task) => todoistTaskItem(task, container, sections, people));
      }
      if (ctx.options.includeCompleted !== false) {
        const until = new Date();
        const since = new Date(until.getTime() - COMPLETED_DAYS * 86_400_000);
        for await (const tasks of paged<TodoistTask>(ctx, "/tasks/completed/by_completion_date", {
          project_id: container.id,
          since: since.toISOString(),
          until: until.toISOString(),
        })) {
          yield tasks.map((task) => todoistTaskItem({ ...task, checked: true }, container, sections, people));
        }
      }
    }
  },
};
