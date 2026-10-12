/**
 * Todoist (unified API v1): tasks and projects (search, read with comments) and
 * task comments. Ids: Todoist ids.
 */
import type { AppItem, AppItemContent } from "@ensemble/shared-types";
import { facts, itemFetch, itemMarkdown } from "../http.js";
import { ItemError, type ItemContext, type ItemSource } from "../types.js";

const API = "https://api.todoist.com/api/v1";
const LABEL = "Todoist";

interface Paged<T> {
  results?: T[];
  next_cursor?: string | null;
}

interface TodoistTask {
  id: string;
  content?: string;
  description?: string;
  project_id?: string;
  labels?: string[];
  priority?: number;
  due?: { date?: string; string?: string; is_recurring?: boolean } | null;
  deadline?: { date?: string } | null;
  checked?: boolean;
  updated_at?: string;
  added_at?: string;
}

interface TodoistProject {
  id: string;
  name?: string;
  is_archived?: boolean;
  updated_at?: string;
}

const ID = /^[A-Za-z0-9]{1,40}$/;

/** "https://app.todoist.com/app/task/write-the-brief-6X7rM8997g3RQmvh" → that task's id. */
export function todoistRef(text: string): { kind: "task" | "project"; id: string } | null {
  const match = /^https?:\/\/(?:app\.)?todoist\.com\/app\/(task|project)\/(?:[^/?#]*-)?([A-Za-z0-9]+)(?:[/?#]|$)/i.exec(text.trim());
  return match ? { kind: match[1]!.toLowerCase() as "task" | "project", id: match[2]! } : null;
}

const get = <T>(ctx: ItemContext, path: string, params: Record<string, string> = {}) =>
  itemFetch<T>(ctx, "todoist", LABEL, `${API}${path}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ""}`, { headers: { Authorization: `Bearer ${ctx.token.token}` } });

const hit = ({ source, kind, id, title, subtitle, url, updatedAt }: AppItem): AppItem => ({ source, kind, id, title, subtitle, url, updatedAt });
const taskLink = (id: string) => `https://app.todoist.com/app/task/${id}`;
const projectLink = (id: string) => `https://app.todoist.com/app/project/${id}`;
/** The API's priority 4 is what the app shows as P1. */
const priority = (value: number | undefined) => (value && value > 1 ? `P${5 - value}` : null);

const missing = (error: unknown): null => {
  if (error instanceof ItemError) return null;
  throw error;
};

function taskItem(task: TodoistTask, projectName?: string): AppItem {
  return {
    source: "todoist",
    kind: "task",
    id: task.id,
    title: task.content || "Untitled task",
    subtitle: [projectName, task.checked ? "done" : task.due?.date ? `due ${task.due.date.slice(0, 10)}` : null].filter(Boolean).join(" · "),
    url: taskLink(task.id),
    updatedAt: task.updated_at ?? task.added_at,
  };
}

function projectItem(project: TodoistProject): AppItem {
  return { source: "todoist", kind: "project", id: project.id, title: project.name || "Untitled project", subtitle: "Project", url: projectLink(project.id), updatedAt: project.updated_at };
}

async function readTask(ctx: ItemContext, id: string): Promise<AppItemContent> {
  const [task, comments] = await Promise.all([get<TodoistTask>(ctx, `/tasks/${id}`), get<Paged<{ content?: string; posted_at?: string }>>(ctx, "/comments", { task_id: id, limit: "100" })]);
  const project = task.project_id && ID.test(task.project_id) ? await get<TodoistProject>(ctx, `/projects/${task.project_id}`).catch(missing) : null;
  const list = facts({
    Project: project?.name,
    Due: task.due?.date,
    Repeats: task.due?.is_recurring ? task.due.string : null,
    Deadline: task.deadline?.date,
    Priority: priority(task.priority),
    Labels: (task.labels ?? []).join(", "),
    Done: task.checked ? "yes" : null,
  });
  const thread = (comments.results ?? [])
    .slice(-10)
    .map((comment) => `**${(comment.posted_at ?? "").slice(0, 10)}**: ${comment.content ?? ""}`)
    .join("\n\n");
  const item = taskItem(task, project?.name);
  return { ...item, facts: list, text: itemMarkdown(item.title, list, [task.description ?? "", thread ? `## Latest comments\n\n${thread}` : ""].filter(Boolean).join("\n\n")) };
}

async function readProject(ctx: ItemContext, id: string): Promise<AppItemContent> {
  const [project, tasks] = await Promise.all([get<TodoistProject>(ctx, `/projects/${id}`), get<Paged<TodoistTask>>(ctx, "/tasks", { project_id: id, limit: "200" })]);
  const rows = tasks.results ?? [];
  const list = facts({ "Open tasks": `${rows.length}${tasks.next_cursor ? "+" : ""}`, Archived: project.is_archived ? "yes" : null });
  const lines = rows.map((task) => `- ${task.content ?? ""}${task.due?.date ? ` (due ${task.due.date.slice(0, 10)})` : ""}`);
  const item = projectItem(project);
  return { ...item, facts: list, text: itemMarkdown(item.title, list, lines.join("\n")) };
}

async function read(ctx: ItemContext, ref: { kind: string; id: string }): Promise<AppItemContent> {
  if (!ID.test(ref.id)) throw new ItemError("That is not a Todoist task or project id.", 400);
  return ref.kind === "project" ? readProject(ctx, ref.id) : readTask(ctx, ref.id);
}

export const todoistItems: ItemSource = {
  id: "todoist",
  provider: "todoist",
  label: LABEL,
  kinds: ["task", "project"],
  async search(ctx, query) {
    const direct = todoistRef(query.q);
    if (direct && (!query.kind || query.kind === direct.kind)) return [hit(await read(ctx, direct))];
    // Filter syntax treats these as operators.
    const text = query.q.replace(/[&|!(),\\\n\r]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    const projects = (await get<Paged<TodoistProject>>(ctx, "/projects", { limit: "200" })).results ?? [];
    const out: AppItem[] = [];
    if (!query.kind || query.kind === "task") {
      const names = new Map(projects.map((project) => [project.id, project.name]));
      const found = await get<Paged<TodoistTask>>(ctx, "/tasks/filter", { query: text ? `search: ${text}` : "today | overdue", limit: String(query.limit) });
      out.push(...(found.results ?? []).map((task) => taskItem(task, names.get(task.project_id ?? ""))));
    }
    if (!query.kind || query.kind === "project") {
      const needle = text.toLowerCase();
      const matching = projects.filter((project) => !project.is_archived && (!needle || (project.name ?? "").toLowerCase().includes(needle)));
      out.push(...matching.slice(0, query.kind ? query.limit : Math.min(5, query.limit)).map(projectItem));
    }
    return out;
  },
  read,
  fromUrl(url) {
    const ref = todoistRef(url);
    return ref?.kind === "task" ? ref : null;
  },
  async comment(ctx, ref, body) {
    if (ref.kind !== "task" || !ID.test(ref.id)) throw new ItemError("Only Todoist tasks take comments.", 400);
    await itemFetch(ctx, "todoist", LABEL, `${API}/comments`, { method: "POST", headers: { Authorization: `Bearer ${ctx.token.token}` }, body: { task_id: ref.id, content: body } });
    return { url: taskLink(ref.id) };
  },
};
