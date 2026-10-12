/**
 * Asana: tasks and projects (search, read with comments), workspace people, and
 * task comments. Ids: Asana gids.
 */
import type { AppItem, AppItemContent, AppItemPerson } from "@ensemble/shared-types";
import { facts, itemFetch, itemMarkdown } from "../http.js";
import { ItemError, MAX_PEOPLE, type ItemContext, type ItemSource } from "../types.js";

const API = "https://app.asana.com/api/1.0";
const LABEL = "Asana";
const LIST_FIELDS = "name,completed,due_on,modified_at,permalink_url,projects.name";
const PROJECT_FIELDS = "name,archived,modified_at,permalink_url,team.name";
const TASK_FIELDS = [
  "name", "notes", "completed", "due_on", "due_at", "modified_at", "permalink_url", "assignee.name", "assignee.email", "projects.name", "tags.name",
  "memberships.section.name", "parent.name", "custom_fields.name", "custom_fields.display_value", "followers.name", "followers.email",
].join(",");
/** Workspaces searched at once; most people have one. */
const MAX_WORKSPACES = 3;

interface Named {
  gid?: string;
  name?: string;
  email?: string;
}

interface AsanaTask {
  gid: string;
  name?: string;
  notes?: string;
  completed?: boolean;
  due_on?: string | null;
  due_at?: string | null;
  modified_at?: string;
  permalink_url?: string;
  assignee?: Named | null;
  projects?: Named[];
  tags?: Named[];
  memberships?: Array<{ section?: Named | null; project?: Named | null }>;
  parent?: Named | null;
  custom_fields?: Array<{ name?: string; display_value?: string | null }>;
  followers?: Named[];
}

interface AsanaProject {
  gid: string;
  name?: string;
  notes?: string;
  archived?: boolean;
  modified_at?: string;
  permalink_url?: string;
  due_on?: string | null;
  owner?: Named | null;
  team?: Named | null;
}

interface Page<T> {
  data: T;
  next_page?: { offset?: string } | null;
}

const GID = /^\d{1,30}$/;

/** An Asana link (old /0/… or new /1/… form) → a task or project gid. */
export function asanaRef(text: string): { kind: "task" | "project"; id: string } | null {
  const value = text.trim();
  if (!/^https?:\/\/app\.asana\.com\//i.test(value)) return null;
  const task = /\/1\/\d+\/(?:[a-z_]+\/\d+\/)*task\/(\d+)/i.exec(value) ?? /\/0\/\d+\/(\d+)(?:[/?#]|$)/.exec(value);
  if (task) return { kind: "task", id: task[1]! };
  const project = /\/1\/\d+\/project\/(\d+)/i.exec(value) ?? /\/0\/(\d+)(?:\/[a-z_]+)?\/?(?:[?#]|$)/i.exec(value);
  return project && project[1] !== "0" ? { kind: "project", id: project[1]! } : null;
}

const get = <T>(ctx: ItemContext, path: string, params: Record<string, string> = {}) =>
  itemFetch<Page<T>>(ctx, "asana", LABEL, `${API}${path}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${ctx.token.token}` } });

const hit = ({ source, kind, id, title, subtitle, url, updatedAt }: AppItem): AppItem => ({ source, kind, id, title, subtitle, url, updatedAt });
const names = (rows: Named[] | undefined) => (rows ?? []).map((row) => row.name).filter(Boolean).join(", ");
const taskLink = (gid: string) => `https://app.asana.com/0/0/${gid}/f`;

function taskItem(task: AsanaTask): AppItem {
  return {
    source: "asana",
    kind: "task",
    id: task.gid,
    title: task.name || "Untitled task",
    subtitle: [names(task.projects), task.completed ? "done" : task.due_on ? `due ${task.due_on}` : null].filter(Boolean).join(" · "),
    url: task.permalink_url ?? taskLink(task.gid),
    updatedAt: task.modified_at,
  };
}

function projectItem(project: AsanaProject): AppItem {
  return {
    source: "asana",
    kind: "project",
    id: project.gid,
    title: project.name || "Untitled project",
    subtitle: ["Project", project.team?.name, project.archived ? "archived" : null].filter(Boolean).join(" · "),
    url: project.permalink_url,
    updatedAt: project.modified_at,
  };
}

async function workspaces(ctx: ItemContext): Promise<Named[]> {
  const found = await get<Named[]>(ctx, "/workspaces", { opt_fields: "name", limit: "10" });
  return found.data.filter((row) => row.gid && GID.test(row.gid)).slice(0, MAX_WORKSPACES);
}

const person = (row: Named | null | undefined): AppItemPerson | null => (row?.name ? { name: row.name, ...(row.email ? { email: row.email } : {}) } : null);

async function readTask(ctx: ItemContext, gid: string): Promise<AppItemContent> {
  const [task, stories] = await Promise.all([get<AsanaTask>(ctx, `/tasks/${gid}`, { opt_fields: TASK_FIELDS }), comments(ctx, gid)]);
  const data = task.data;
  const sections = [...new Set((data.memberships ?? []).map((row) => row.section?.name).filter((name): name is string => Boolean(name) && name !== "Untitled section"))];
  const custom = (data.custom_fields ?? []).filter((field) => field.name && field.display_value).slice(0, 6);
  const list = facts({
    Status: data.completed ? "Completed" : "Open",
    Assignee: data.assignee?.name,
    Due: data.due_on ?? data.due_at?.slice(0, 10),
    Projects: names(data.projects),
    Section: sections.join(", "),
    Tags: names(data.tags),
    Parent: data.parent?.name,
    ...Object.fromEntries(custom.map((field) => [field.name!, field.display_value!])),
  });
  const thread = stories.map((story) => `**${story.created_by?.name ?? "Someone"}** (${(story.created_at ?? "").slice(0, 10)}):\n${story.text ?? ""}`).join("\n\n");
  const people = new Map<string, AppItemPerson>();
  for (const row of [data.assignee, ...(data.followers ?? [])].map(person)) if (row) people.set(row.email ?? row.name, row);
  const item = taskItem(data);
  return {
    ...item,
    facts: list,
    people: [...people.values()],
    text: itemMarkdown(item.title, list, [data.notes ?? "", thread ? `## Latest comments\n\n${thread}` : ""].filter(Boolean).join("\n\n")),
  };
}

/** The last 10 comments, oldest first. Stories come oldest first, so a long task needs a few pages. */
async function comments(ctx: ItemContext, gid: string): Promise<Array<{ text?: string; created_at?: string; created_by?: Named | null }>> {
  const out: Array<{ type?: string; text?: string; created_at?: string; created_by?: Named | null }> = [];
  let offset: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const found = await get<typeof out>(ctx, `/tasks/${gid}/stories`, { opt_fields: "type,text,created_at,created_by.name", limit: "100", ...(offset ? { offset } : {}) });
    out.push(...found.data.filter((story) => story.type === "comment"));
    offset = found.next_page?.offset ?? undefined;
    if (!offset) break;
  }
  return out.slice(-10);
}

async function readProject(ctx: ItemContext, gid: string): Promise<AppItemContent> {
  const [project, tasks] = await Promise.all([
    get<AsanaProject>(ctx, `/projects/${gid}`, { opt_fields: `${PROJECT_FIELDS},notes,due_on,owner.name,owner.email` }),
    get<AsanaTask[]>(ctx, `/projects/${gid}/tasks`, { completed_since: "now", limit: "100", opt_fields: "name,due_on,assignee.name,memberships.project.gid,memberships.section.name" }),
  ]);
  const data = project.data;
  const bySection = new Map<string, string[]>();
  for (const task of tasks.data) {
    const section = task.memberships?.find((row) => row.project?.gid === gid)?.section?.name ?? "Tasks";
    const extra = [task.assignee?.name, task.due_on ? `due ${task.due_on}` : null].filter(Boolean).join(", ");
    bySection.set(section, [...(bySection.get(section) ?? []), `- ${task.name ?? ""}${extra ? ` (${extra})` : ""}`]);
  }
  const list = facts({
    Team: data.team?.name,
    Owner: data.owner?.name,
    Due: data.due_on,
    "Open tasks": `${tasks.data.length}${tasks.next_page?.offset ? "+" : ""}`,
    Archived: data.archived ? "yes" : null,
  });
  const body = [...bySection].map(([section, lines]) => `## ${section}\n\n${lines.join("\n")}`).join("\n\n");
  const item = projectItem(data);
  const owner = person(data.owner);
  return { ...item, facts: list, people: owner ? [owner] : [], text: itemMarkdown(item.title, list, [data.notes ?? "", body].filter(Boolean).join("\n\n")) };
}

async function read(ctx: ItemContext, ref: { kind: string; id: string }): Promise<AppItemContent> {
  if (!GID.test(ref.id)) throw new ItemError("That is not an Asana task or project id.", 400);
  return ref.kind === "project" ? readProject(ctx, ref.id) : readTask(ctx, ref.id);
}

export const asanaItems: ItemSource = {
  id: "asana",
  provider: "asana",
  label: LABEL,
  kinds: ["task", "project"],
  async search(ctx, query) {
    const direct = asanaRef(query.q);
    if (direct && (!query.kind || query.kind === direct.kind)) return [hit(await read(ctx, direct))];
    const text = query.q.trim().slice(0, 200);
    const projectCount = query.kind ? query.limit : Math.min(5, query.limit);
    const tasks: AppItem[] = [];
    const projects: AppItem[] = [];
    for (const workspace of await workspaces(ctx)) {
      if (!query.kind || query.kind === "task") {
        const found = text
          ? await get<AsanaTask[]>(ctx, `/workspaces/${workspace.gid}/typeahead`, { resource_type: "task", query: text, count: String(query.limit), opt_fields: LIST_FIELDS })
          : await get<AsanaTask[]>(ctx, "/tasks", { assignee: "me", workspace: workspace.gid!, completed_since: "now", limit: "50", opt_fields: LIST_FIELDS });
        tasks.push(...found.data.map(taskItem));
      }
      if (!query.kind || query.kind === "project") {
        const found = await get<AsanaProject[]>(ctx, `/workspaces/${workspace.gid}/typeahead`, { resource_type: "project", query: text, count: String(projectCount), opt_fields: PROJECT_FIELDS });
        projects.push(...found.data.map(projectItem));
      }
    }
    if (!text) tasks.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return [...tasks.slice(0, query.limit), ...projects.slice(0, projectCount)];
  },
  read,
  async people(ctx) {
    const seen = new Map<string, AppItemPerson>();
    for (const workspace of await workspaces(ctx)) {
      const users = await get<Named[]>(ctx, `/workspaces/${workspace.gid}/users`, { opt_fields: "name,email" });
      for (const user of users.data) {
        const row = person(user);
        if (row && user.gid) seen.set(user.gid, row);
      }
      if (seen.size >= MAX_PEOPLE) break;
    }
    return [...seen.values()].slice(0, MAX_PEOPLE);
  },
  fromUrl(url) {
    const ref = asanaRef(url);
    return ref?.kind === "task" ? ref : null;
  },
  async comment(ctx, ref, body) {
    if (ref.kind !== "task" || !GID.test(ref.id)) throw new ItemError("Only Asana tasks take comments.", 400);
    await itemFetch(ctx, "asana", LABEL, `${API}/tasks/${ref.id}/stories`, { method: "POST", headers: { Authorization: `Bearer ${ctx.token.token}` }, body: { data: { text: body } } });
    return { url: taskLink(ref.id) };
  },
};
