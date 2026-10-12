/**
 * ClickUp: tasks (search, read with comments, comment), lists as projects, and
 * workspace members. ClickUp has no full-text search API, so a search reads the
 * most recently updated tasks and matches their names.
 * Ids: ClickUp task ids and list ids.
 */
import type { AppItem, AppItemContent, AppItemPerson } from "@ensemble/shared-types";
import { clickupAuth } from "../../../imports/api/clickup.js";
import { facts, itemFetch, itemMarkdown, type ItemRequest } from "../http.js";
import { ItemError, MAX_PEOPLE, type ItemContext, type ItemSource } from "../types.js";

const API = "https://api.clickup.com/api/v2";
const LABEL = "ClickUp";
/** Pages of 100 recently updated tasks read per workspace when matching names. */
const SEARCH_PAGES = 3;
const MAX_TEAMS = 2;
const MAX_SPACES = 5;

interface Team {
  id: string;
  name?: string;
  members?: Array<{ user?: { id?: number | string; username?: string | null; email?: string | null } }>;
}

interface Task {
  id: string;
  name?: string;
  markdown_description?: string | null;
  text_content?: string | null;
  status?: { status?: string } | null;
  priority?: { priority?: string } | null;
  due_date?: string | null;
  date_updated?: string | null;
  assignees?: Array<{ username?: string | null; email?: string | null }>;
  creator?: { username?: string | null; email?: string | null } | null;
  tags?: Array<{ name?: string }>;
  url?: string;
  list?: { id?: string; name?: string } | null;
  folder?: { name?: string; hidden?: boolean } | null;
}

interface List {
  id: string;
  name?: string;
  content?: string;
  task_count?: number | string | null;
  folder?: { name?: string; hidden?: boolean } | null;
  space?: { name?: string } | null;
}

const TASK_ID = /^[A-Za-z0-9]{1,30}$/;
const LIST_ID = /^\d{1,30}$/;

/** "https://app.clickup.com/t/86abc123" → that task's id. Custom task ids (/t/{team}/DEV-12) are not read. */
export function clickupRef(text: string): string | null {
  const match = /^https?:\/\/app\.clickup\.com\/t\/([A-Za-z0-9]+)\/?(?:[?#]|$)/i.exec(text.trim());
  return match ? match[1]! : null;
}

const call = <T>(ctx: ItemContext, path: string, init: Omit<ItemRequest, "headers"> = {}) =>
  itemFetch<T>(ctx, "clickup", LABEL, `${API}${path}`, { ...init, headers: { Authorization: clickupAuth(ctx.token.token) } });

const hit = ({ source, kind, id, title, subtitle, url, updatedAt }: AppItem): AppItem => ({ source, kind, id, title, subtitle, url, updatedAt });
const fromMillis = (value: string | null | undefined) => (value && /^\d+$/.test(value) ? new Date(Number(value)).toISOString() : undefined);
const taskLink = (id: string) => `https://app.clickup.com/t/${id}`;
const listLink = (teamId: string | undefined, listId: string) => (teamId ? `https://app.clickup.com/${teamId}/v/li/${listId}` : undefined);

function taskItem(task: Task): AppItem {
  return {
    source: "clickup",
    kind: "task",
    id: task.id,
    title: task.name || "Untitled task",
    subtitle: [task.list?.name, task.status?.status].filter(Boolean).join(" · "),
    url: task.url ?? taskLink(task.id),
    updatedAt: fromMillis(task.date_updated),
  };
}

function listItem(list: List, teamId: string | undefined, space?: string): AppItem {
  const folder = list.folder && !list.folder.hidden ? list.folder.name : null;
  return {
    source: "clickup",
    kind: "project",
    id: list.id,
    title: list.name || "Untitled list",
    subtitle: ["List", [space ?? list.space?.name, folder].filter(Boolean).join(" › ")].filter(Boolean).join(" · "),
    url: listLink(teamId, list.id),
  };
}

async function teams(ctx: ItemContext): Promise<Team[]> {
  return (await call<{ teams?: Team[] }>(ctx, "/team")).teams ?? [];
}

async function searchTasks(ctx: ItemContext, team: Team, needle: string, limit: number): Promise<AppItem[]> {
  const out: AppItem[] = [];
  for (let page = 0; page < (needle ? SEARCH_PAGES : 1) && out.length < limit; page += 1) {
    const params = new URLSearchParams({ page: String(page), order_by: "updated", include_closed: "false", subtasks: "true" });
    const found = await call<{ tasks?: Task[]; last_page?: boolean }>(ctx, `/team/${team.id}/task?${params}`);
    for (const task of found.tasks ?? []) {
      if (needle && !(task.name ?? "").toLowerCase().includes(needle)) continue;
      out.push(taskItem(task));
      if (out.length >= limit) break;
    }
    if (found.last_page || (found.tasks ?? []).length < 100) break;
  }
  return out;
}

async function searchLists(ctx: ItemContext, team: Team, needle: string, limit: number): Promise<AppItem[]> {
  const spaces = (await call<{ spaces?: Array<{ id: string; name?: string }> }>(ctx, `/team/${team.id}/space?archived=false`)).spaces ?? [];
  const out: AppItem[] = [];
  for (const space of spaces.slice(0, MAX_SPACES)) {
    const [folders, loose] = await Promise.all([
      call<{ folders?: Array<{ name?: string; hidden?: boolean; lists?: List[] }> }>(ctx, `/space/${space.id}/folder?archived=false`),
      call<{ lists?: List[] }>(ctx, `/space/${space.id}/list?archived=false`),
    ]);
    const lists = [...(loose.lists ?? []), ...(folders.folders ?? []).flatMap((folder) => (folder.lists ?? []).map((list) => ({ ...list, folder: { name: folder.name, hidden: folder.hidden } })))];
    for (const list of lists) if (!needle || (list.name ?? "").toLowerCase().includes(needle)) out.push(listItem(list, team.id, space.name));
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

async function readTask(ctx: ItemContext, id: string): Promise<AppItemContent> {
  const [task, comments] = await Promise.all([
    call<Task>(ctx, `/task/${id}?include_markdown_description=true`),
    call<{ comments?: Array<{ comment_text?: string; date?: string; user?: { username?: string | null } }> }>(ctx, `/task/${id}/comment`),
  ]);
  const assignees = task.assignees ?? [];
  const list = facts({
    Status: task.status?.status,
    Priority: task.priority?.priority,
    Assignees: assignees.map((row) => row.username || row.email).filter(Boolean).join(", "),
    Due: fromMillis(task.due_date)?.slice(0, 10),
    List: task.list?.name,
    Folder: task.folder && !task.folder.hidden ? task.folder.name : null,
    Tags: (task.tags ?? []).map((tag) => tag.name).filter(Boolean).join(", "),
  });
  const thread = [...(comments.comments ?? [])]
    .sort((a, b) => Number(a.date ?? 0) - Number(b.date ?? 0))
    .slice(-10)
    .map((comment) => `**${comment.user?.username ?? "Someone"}** (${fromMillis(comment.date)?.slice(0, 10) ?? ""}):\n${comment.comment_text ?? ""}`)
    .join("\n\n");
  const people: AppItemPerson[] = [...assignees, ...(task.creator ? [task.creator] : [])]
    .filter((row) => row.username || row.email)
    .map((row) => ({ name: row.username || row.email!, ...(row.email ? { email: row.email } : {}) }));
  const item = taskItem(task);
  return {
    ...item,
    facts: list,
    people: [...new Map(people.map((row) => [row.email ?? row.name, row])).values()],
    text: itemMarkdown(item.title, list, [task.markdown_description || task.text_content || "", thread ? `## Latest comments\n\n${thread}` : ""].filter(Boolean).join("\n\n")),
  };
}

async function readList(ctx: ItemContext, id: string): Promise<AppItemContent> {
  const [list, tasks, all] = await Promise.all([
    call<List>(ctx, `/list/${id}`),
    call<{ tasks?: Task[] }>(ctx, `/list/${id}/task?include_closed=false&subtasks=true&page=0`),
    teams(ctx),
  ]);
  const rows = tasks.tasks ?? [];
  const details = facts({ Space: list.space?.name, Folder: list.folder && !list.folder.hidden ? list.folder.name : null, "Open tasks": `${rows.length}${rows.length === 100 ? "+" : ""}` });
  const lines = rows.map((task) => {
    const extra = [task.status?.status, ...(task.assignees ?? []).map((row) => row.username)].filter(Boolean).join(", ");
    return `- ${task.name ?? ""}${extra ? ` (${extra})` : ""}`;
  });
  const item = listItem(list, all.length === 1 ? all[0]!.id : undefined);
  return { ...item, facts: details, text: itemMarkdown(item.title, details, [list.content ?? "", lines.join("\n")].filter(Boolean).join("\n\n")) };
}

async function read(ctx: ItemContext, ref: { kind: string; id: string }): Promise<AppItemContent> {
  if (ref.kind === "project") {
    if (!LIST_ID.test(ref.id)) throw new ItemError("That is not a ClickUp list id.", 400);
    return readList(ctx, ref.id);
  }
  if (!TASK_ID.test(ref.id)) throw new ItemError("That is not a ClickUp task id.", 400);
  return readTask(ctx, ref.id);
}

export const clickupItems: ItemSource = {
  id: "clickup",
  provider: "clickup",
  label: LABEL,
  kinds: ["task", "project"],
  async search(ctx, query) {
    const direct = clickupRef(query.q);
    if (direct && query.kind !== "project") return [hit(await readTask(ctx, direct))];
    const needle = query.q.trim().toLowerCase().slice(0, 200);
    const out: AppItem[] = [];
    for (const team of (await teams(ctx)).slice(0, MAX_TEAMS)) {
      if (!query.kind || query.kind === "task") out.push(...(await searchTasks(ctx, team, needle, query.limit)));
      // Lists take a call per space and folder, so only an explicit list search reads them.
      if (query.kind === "project") out.push(...(await searchLists(ctx, team, needle, query.limit)));
    }
    return out.slice(0, query.limit);
  },
  read,
  async people(ctx) {
    const seen = new Map<string, AppItemPerson>();
    for (const team of await teams(ctx)) {
      for (const member of team.members ?? []) {
        const user = member.user;
        if (!user?.id || !(user.username || user.email)) continue;
        seen.set(String(user.id), { name: user.username || user.email!, ...(user.email ? { email: user.email } : {}) });
      }
    }
    return [...seen.values()].slice(0, MAX_PEOPLE);
  },
  fromUrl(url) {
    const id = clickupRef(url);
    return id ? { kind: "task", id } : null;
  },
  async comment(ctx, ref, body) {
    if (ref.kind !== "task" || !TASK_ID.test(ref.id)) throw new ItemError("Only ClickUp tasks take comments.", 400);
    await call(ctx, `/task/${ref.id}/comment`, { method: "POST", body: { comment_text: body, notify_all: false } });
    return { url: taskLink(ref.id) };
  },
};
