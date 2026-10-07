/** ClickUp API v2: workspaces → spaces → folders → lists; lists become projects. */
import { normalizeDate } from "../mapping.js";
import type { ApiImportSource, ImportContainer, ImportItem, SourceContext } from "../types.js";

const API = "https://api.clickup.com/api/v2";

interface ClickUpList { id: string; name: string; task_count?: number | string | null }
interface ClickUpTask {
  id: string;
  name?: string;
  description?: string | null;
  text_content?: string | null;
  markdown_description?: string | null;
  status?: { status?: string; type?: string } | null;
  priority?: { priority?: string } | null;
  due_date?: string | null;
  start_date?: string | null;
  date_closed?: string | null;
  date_created?: string | null;
  date_updated?: string | null;
  tags?: Array<{ name?: string }>;
  assignees?: Array<{ username?: string; email?: string }>;
  url?: string;
  parent?: string | null;
  archived?: boolean;
}

export function clickupAuth(token: string): string {
  // Personal tokens start with pk_ and go in as-is.
  return token.startsWith("pk_") ? token : `Bearer ${token}`;
}

const get = <T>(ctx: SourceContext, path: string) => ctx.http.json<T>(`${API}${path}`, { headers: { Authorization: clickupAuth(ctx.auth.token) } });

export function clickupTaskItem(task: ClickUpTask, container: ImportContainer): ImportItem {
  return {
    kind: "task",
    externalId: task.id,
    title: task.name ?? "",
    description: task.markdown_description || task.text_content || task.description || null,
    dueDate: normalizeDate(task.due_date),
    startDate: normalizeDate(task.start_date),
    status: task.status?.status ?? null,
    statusCategory: task.status?.type ?? null,
    priority: task.priority?.priority ?? null,
    labels: (task.tags ?? []).map((tag) => tag.name ?? ""),
    assignees: (task.assignees ?? []).map((person) => person.username || person.email || ""),
    url: task.url ?? null,
    containerId: container.id,
    projectRef: container.id,
    projectName: container.name,
    parentRef: task.parent ?? null,
    createdAt: normalizeDate(task.date_created),
    updatedAt: normalizeDate(task.date_updated),
    completedAt: normalizeDate(task.date_closed),
  };
}

export const clickupSource: ApiImportSource = {
  id: "clickup",
  async listContainers(ctx) {
    const containers: ImportContainer[] = [];
    const add = (list: ClickUpList, parent: string) =>
      containers.push({ id: list.id, name: list.name, kind: "list", count: list.task_count === null || list.task_count === undefined ? null : Number(list.task_count), parent, importAs: "tasks" });
    const { teams } = await get<{ teams: Array<{ id: string; name: string }> }>(ctx, "/team");
    for (const team of teams ?? []) {
      const { spaces } = await get<{ spaces: Array<{ id: string; name: string }> }>(ctx, `/team/${team.id}/space?archived=false`);
      for (const space of spaces ?? []) {
        const { lists } = await get<{ lists: ClickUpList[] }>(ctx, `/space/${space.id}/list?archived=false`);
        for (const list of lists ?? []) add(list, `${team.name} / ${space.name}`);
        const { folders } = await get<{ folders: Array<{ id: string; name: string; lists?: ClickUpList[] }> }>(ctx, `/space/${space.id}/folder?archived=false`);
        for (const folder of folders ?? []) for (const list of folder.lists ?? []) add(list, `${team.name} / ${space.name} / ${folder.name}`);
      }
    }
    return containers;
  },
  async *fetchItems(ctx, containers) {
    const closed = ctx.options.includeCompleted === false ? "false" : "true";
    for (const container of containers) {
      for (let page = 0; page < 500 && !ctx.signal.aborted; page += 1) {
        const result = await get<{ tasks: ClickUpTask[]; last_page?: boolean }>(
          ctx,
          `/list/${container.id}/task?page=${page}&include_closed=${closed}&subtasks=true&include_markdown_description=true`,
        );
        yield (result.tasks ?? []).filter((task) => !task.archived).map((task) => clickupTaskItem(task, container));
        if (result.last_page === true || (result.tasks?.length ?? 0) < 100) break;
      }
    }
  },
};
