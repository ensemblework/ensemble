import { z } from "zod";
import { Priority, TaskStatus } from "@ensemble/shared-types";
import { inferComplexity } from "../../lib/complexity.js";
import { createTask, labelPriority, labelStatus, taskChangePreview, titlesMatch, updateTask } from "../../services/tasks.js";
import { softDelete, trashTasks } from "../../services/records.js";
import { defineTool, inTransaction, toolOk, type ToolContext } from "../types.js";
import { MAX_MARKDOWN, appendToTaskPage, droppedNote } from "./pages.js";
import { titleList } from "../refs.js";

const Due = z
  .string()
  .refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isNaN(Date.parse(value)), "YYYY-MM-DD or an ISO datetime")
  .nullable()
  .optional();

/**
 * The short description and the notes field are the person's to fill in. Anything the assistant
 * writes about a task goes on its page, so a `description` or `notes` it still sends is moved
 * there before the input is checked.
 */
export function foldIntoPage(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const { description, notes, ...rest } = raw as Record<string, unknown>;
  const parts = [rest.page, description, notes].filter((part): part is string => typeof part === "string" && part.trim().length > 0);
  return parts.length ? { ...rest, page: parts.join("\n\n") } : rest;
}

const PageMarkdown = z
  .string()
  .max(MAX_MARKDOWN)
  .optional()
  .describe("Markdown for the task's page: detail, steps, context, links as [@Label](ensemble://kind/id). Everything you write about the task goes here.");

const TaskDraftInput = z.preprocess(foldIntoPage, z
  .object({
    title: z.string().min(1),
    page: PageMarkdown,
    owner: z.enum(["me", "agent", "unassigned"]).optional(),
    status: TaskStatus.optional(),
    priority: Priority.describe("critical = Critical/drop everything, p0 = High/urgent, p1 = Medium, p2 = Low").optional(),
    complexity: z.enum(["easy", "medium", "high", "max"]).optional(),
    due: Due.describe("YYYY-MM-DD or ISO datetime. Resolve relative dates from the system prompt."),
    projectId: z.string().uuid().optional(),
    projectName: z.string().min(1).optional().describe("Resolved when the write is applied, so a project created earlier in the turn can be used."),
    people: z.array(z.string()).optional(),
    labels: z.array(z.string().max(40)).max(20).optional().describe("Tags such as client, area or type."),
    todayFocus: z.enum(["auto", "keep", "hidden"]).optional(),
    skillIds: z.array(z.string()).optional(),
    taskId: z.string().optional(),
  })
  .strict());

const MAX_BULK_TASKS = 500;
const BULK_PREVIEW_TITLES = 8;

export const taskTools = [
  defineTool({
    name: "hub_list_tasks",
    area: "tasks",
    description:
      "List the person's tasks. Pass query to search title, description, and notes. Use offset when total is larger than the page. Match the exact title before you update or complete a task.",
    input: z.object({
      status: TaskStatus.optional(),
      owner: z.enum(["me", "agent", "unassigned"]).optional(),
      query: z.string().min(1).max(200).optional(),
      ids: z.array(z.string().uuid()).max(100).optional().describe("Only these real task IDs, for a selection or visible board rows."),
      label: z.string().min(1).max(40).optional().describe("Only tasks with this tag."),
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).max(500).default(0),
    }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const where = {
        userId: ctx.userId,
        deletedAt: null,
        ...(input.ids ? { id: { in: input.ids } } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.owner ? { owner: input.owner } : {}),
        ...(input.label ? { labels: { has: input.label } } : {}),
        ...(input.query
          ? {
              OR: [
                { title: { contains: input.query, mode: "insensitive" as const } },
                { description: { contains: input.query, mode: "insensitive" as const } },
                { notes: { contains: input.query, mode: "insensitive" as const } },
              ],
            }
          : {}),
      };
      const [tasks, total] = await Promise.all([
        ctx.prisma.task.findMany({
          where,
          orderBy: [{ updatedAt: "desc" }, { boardOrder: "asc" }],
          skip: input.offset,
          take: input.limit,
          select: { id: true, title: true, status: true, owner: true, priority: true, due: true, projectId: true, labels: true },
        }),
        ctx.prisma.task.count({ where }),
      ]);
      // total first and empty fields left out: a long list must still carry every id in full.
      const rows = tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        owner: task.owner,
        priority: task.priority,
        ...(task.due ? { due: task.due.toISOString().slice(0, 10) } : {}),
        ...(task.projectId ? { projectId: task.projectId } : {}),
        ...(task.labels.length ? { labels: task.labels } : {}),
      }));
      return toolOk(`Listed ${tasks.length} of ${total} task(s).`, { total, offset: input.offset, limit: input.limit, tasks: rows });
    },
  }),
  defineTool({
    name: "hub_get_task",
    area: "tasks",
    description: "Read one task by id. Never invent an id — list first and match by name.",
    input: z.object({ taskId: z.string().uuid() }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const task = await ctx.prisma.task.findFirst({
        where: { id: input.taskId, userId: ctx.userId, deletedAt: null },
      });
      if (!task) throw new Error("No task with that id. Call hub_list_tasks and match by name.");
      return toolOk(`Read “${task.title}”.`, { task }, { href: `/tasks/${task.id}` });
    },
  }),
  defineTool({
    name: "hub_create_tasks",
    area: "tasks",
    description:
      "Add one or more todos. Prefer one call with several tasks. Write any detail in page (the task's page, Markdown); the short description is the person's and is never set. Set owner, priority, complexity, due, labels, projectName or people only when the person said so or it is clear from what they said; otherwise leave them out. Set status to proposed for work you inferred. priority critical is Critical, p0 is High, p1 is Medium, p2 is Low. Use projectName to attach tasks to a project created earlier in this turn.",
    input: z.object({ tasks: z.array(TaskDraftInput).min(1).max(12) }),
    isWrite: true,
    risk: "low",
    undoable: true,
    async preview(ctx, input) {
      for (const name of input.tasks.map((task) => task.projectName).filter((name): name is string => Boolean(name))) {
        await assertProjectName(ctx, name);
      }
      const lines = input.tasks.map((task) => {
        const bits = [task.title];
        if (task.due) bits.push(`due ${String(task.due).slice(0, 10)}`);
        if (task.priority) bits.push(labelPriority(task.priority));
        if (task.projectName) bits.push(`in ${task.projectName}`);
        if (task.labels?.length) bits.push(`tagged ${task.labels.join(", ")}`);
        if (task.owner === "me") bits.push("assigned to you");
        if (task.page?.trim()) bits.push("with a page");
        return `- ${bits.join(", ")}`;
      });
      return `Add ${input.tasks.length} task(s):\n${lines.join("\n")}`;
    },
    async run(ctx, input) {
      const dropped: string[] = [];
      const created = await inTransaction(ctx, async (tx) => {
        const rows = [];
        for (const draft of input.tasks) {
          const { taskId: _ignored, page, ...fields } = draft;
          const row = await createTask(
            tx,
            ctx.userId,
            {
              ...fields,
              complexity: fields.complexity ?? inferComplexity({ title: fields.title, description: page }),
              due: fields.due ?? undefined,
              sourceRef: ctx.conversationId ? `assistant:${ctx.conversationId}` : "assistant",
            },
            "agent",
          );
          if (page?.trim()) dropped.push(...(await appendToTaskPage(tx, ctx.userId, row.id, page)).dropped);
          rows.push(row);
        }
        return rows;
      });
      // Titles for the person; the ids stay in data, for links and later calls.
      const listed = titleList(created.map((row) => ({ title: row.title, detail: row.due ? `due ${row.due.toISOString().slice(0, 10)}` : null })));
      const summary = created.length === 1 ? `Added ${listed}.` : `Added ${created.length} tasks: ${listed}.`;
      const tasks = created.map((row) => ({ id: row.id, title: row.title, projectId: row.projectId, ...(row.due ? { due: row.due.toISOString().slice(0, 10) } : {}) }));
      return toolOk(`${summary}${droppedNote(dropped)}`, { tasks }, {
        invalidate: ["tasks"],
        href: created[0] ? `/tasks/${created[0].id}` : undefined,
      });
    },
  }),
  defineTool({
    name: "hub_update_task",
    area: "tasks",
    description:
      "Update fields on an existing task, including marking it done. taskId must be the exact id from hub_list_tasks (search with query). matchTitle must be that task's current title. The write is refused when they do not match. page adds Markdown to the end of the task's page; to rewrite the page use hub_update_page. The short description is the person's and is never set. priority critical is Critical, p0 is High, p1 is Medium, p2 is Low. Do not use this to link a repo or create a person.",
    input: z.preprocess(foldIntoPage, z
      .object({
        taskId: z.string().uuid(),
        matchTitle: z.string().min(1).describe("The task's current title. Refused when this is not the title of taskId."),
        title: z.string().min(1).optional(),
        page: PageMarkdown.describe("Markdown added to the end of the task's page."),
        owner: z.enum(["me", "agent", "unassigned"]).optional(),
        status: TaskStatus.optional(),
        priority: Priority.describe("critical = Critical/drop everything, p0 = High/urgent, p1 = Medium, p2 = Low").optional(),
        complexity: z.enum(["easy", "medium", "high", "max"]).optional(),
        due: Due,
        projectId: z.string().uuid().nullable().optional(),
        projectName: z.string().min(1).optional(),
        people: z.array(z.string()).optional(),
        labels: z.array(z.string().max(40)).max(20).optional().describe("Replaces the task's tags."),
        repoId: z.string().uuid().nullable().optional(),
        deliverableId: z.string().uuid().nullable().optional(),
        skillIds: z.array(z.string()).optional(),
        todayFocus: z.enum(["auto", "keep", "hidden"]).optional(),
        snoozedUntil: z.string().datetime().nullable().optional(),
      })
      .strict()),
    isWrite: true,
    risk: "low",
    undoable: true,
    async preview(ctx, input) {
      if (input.projectName) await assertProjectName(ctx, input.projectName);
      const task = await ctx.prisma.task.findFirst({
        where: { id: input.taskId, userId: ctx.userId, deletedAt: null },
        select: { title: true, status: true, priority: true, owner: true, due: true },
      });
      if (!task) throw Object.assign(new Error("That task is not on your board."), { statusCode: 404 });
      if (!titlesMatch(input.matchTitle, task.title)) {
        throw Object.assign(
          new Error(`That id is “${task.title}”, not “${input.matchTitle}”. Call hub_list_tasks with query set to the exact title and use the id it returns.`),
          { statusCode: 409 },
        );
      }
      const change = taskChangePreview(task.title, {
        title: task?.title,
        status: task?.status,
        priority: task?.priority,
        owner: task?.owner,
        due: task?.due?.toISOString() ?? null,
      }, {
        title: input.title,
        status: input.status,
        priority: input.priority,
        owner: input.owner,
        due: input.due,
        projectName: input.projectName,
        complexity: input.complexity,
      });
      const first = input.page?.trim().split("\n")[0]?.replace(/^#+\s*/, "").slice(0, 80);
      if (!first) return change;
      return change.endsWith(": details") ? `Add to the page of “${task.title}”: ${first}` : `${change}; add to its page: ${first}`;
    },
    async run(ctx, input) {
      const { taskId, matchTitle, page, ...patch } = input;
      const fields = Object.values(patch).some((value) => value !== undefined);
      const { task, dropped } = await inTransaction(ctx, async (tx) => {
        const row = fields || !page?.trim()
          ? await updateTask(tx, ctx.userId, taskId, { ...patch, matchTitle, due: patch.due ?? undefined }, "agent")
          : await tx.task.findFirst({ where: { id: taskId, userId: ctx.userId, deletedAt: null } });
        if (!row) throw Object.assign(new Error("That task is not on your board."), { statusCode: 404 });
        if (!fields && page?.trim() && !titlesMatch(matchTitle, row.title)) throw Object.assign(new Error(`That id is “${row.title}”, not “${matchTitle}”.`), { statusCode: 409 });
        const written = page?.trim() ? await appendToTaskPage(tx, ctx.userId, taskId, page) : { dropped: [] };
        return { task: row, dropped: written.dropped };
      });
      return toolOk(`${updateSummary(matchTitle, task.title, patch, Boolean(page?.trim()))}${droppedNote(dropped)}`, { task: { id: task.id, title: task.title, status: task.status, owner: task.owner, priority: task.priority, due: task.due, completedAt: task.completedAt, projectId: task.projectId } }, {
        invalidate: ["tasks"],
        href: `/tasks/${task.id}`,
      });
    },
  }),
  defineTool({
    name: "hub_delete_task",
    area: "tasks",
    description: "Move one task to Trash. It can be restored. For more than one task use hub_delete_tasks. Do not use this when the person meant a different entity.",
    input: z.object({ taskId: z.string().uuid() }).strict(),
    isWrite: true,
    risk: "medium",
    undoable: true,
    async preview(ctx, input) {
      const task = await ctx.prisma.task.findFirst({ where: { id: input.taskId, userId: ctx.userId, deletedAt: null }, select: { title: true } });
      if (!task) throw Object.assign(new Error("That task is not on your board. Call hub_list_tasks and use an id it returns."), { statusCode: 404 });
      return `Move “${task.title}” to Trash`;
    },
    async run(ctx, input) {
      const result = await inTransaction(ctx, (tx) => softDelete(tx, ctx.userId, "task", input.taskId, "agent"));
      return toolOk(`Moved “${result.label}” to Trash.`, { ok: true }, { invalidate: ["tasks"] });
    },
  }),
  defineTool({
    name: "hub_delete_tasks",
    area: "tasks",
    description:
      "Move many tasks to Trash in one change (they can be restored, and one Undo brings them all back). For “delete all my tasks” or “clear the board” pass all: true. To narrow it, pass status, owner, label, projectId or query instead of ids. Or pass taskIds copied from hub_list_tasks. Use this instead of several hub_delete_task calls.",
    input: z
      .object({
        taskIds: z.array(z.string().uuid()).min(1).max(MAX_BULK_TASKS).optional().describe("Exact ids from hub_list_tasks. Leave out when using a filter."),
        all: z.boolean().optional().describe("Every task on the board (not already in Trash)."),
        status: TaskStatus.optional(),
        owner: z.enum(["me", "agent", "unassigned"]).optional(),
        label: z.string().min(1).max(40).optional().describe("Only tasks with this tag."),
        projectId: z.string().uuid().optional(),
        query: z.string().min(1).max(200).optional().describe("Only tasks whose title, description or notes contain this."),
      })
      .strict()
      .refine((input) => Boolean(input.taskIds?.length || input.all || input.status || input.owner || input.label || input.projectId || input.query), {
        message: "Pass taskIds, or all: true, or a filter (status, owner, label, projectId, query).",
      }),
    isWrite: true,
    risk: "medium",
    undoable: true,
    async prepare(ctx, input) {
      return { taskIds: await bulkTaskIds(ctx, input) };
    },
    async preview(ctx, input) {
      const ids = await bulkTaskIds(ctx, input);
      const rows = await ctx.prisma.task.findMany({ where: { userId: ctx.userId, id: { in: ids }, deletedAt: null }, select: { id: true, title: true } });
      if (rows.length !== ids.length) throw Object.assign(new Error(`${ids.length - rows.length} of those tasks are not on your board. List the tasks again, or pass a filter such as all: true.`), { statusCode: 404 });
      const shown = rows.slice(0, BULK_PREVIEW_TITLES).map((row) => `- ${row.title}`);
      const more = rows.length > BULK_PREVIEW_TITLES ? [`- …and ${rows.length - BULK_PREVIEW_TITLES} more`] : [];
      return rows.length === 1 ? `Move “${rows[0]!.title}” to Trash` : [`Move ${rows.length} tasks to Trash:`, ...shown, ...more].join("\n");
    },
    async run(ctx, input) {
      const ids = await bulkTaskIds(ctx, input);
      const { titles } = await inTransaction(ctx, (tx) => trashTasks(tx, ctx.userId, ids, "agent"));
      const summary = titles.length === 1 ? `Moved “${titles[0]}” to Trash.` : `Moved ${titles.length} tasks to Trash.`;
      return toolOk(summary, { moved: titles.length }, { invalidate: ["tasks"] });
    },
  }),
  defineTool({
    name: "hub_read_task_page",
    area: "tasks",
    description: "Read the page body for a task.",
    input: z.object({ taskId: z.string().uuid() }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const page = await ctx.prisma.taskPage.findFirst({ where: { taskId: input.taskId, userId: ctx.userId } });
      const task = await ctx.prisma.task.findFirst({
        where: { id: input.taskId, userId: ctx.userId },
        select: { notes: true, title: true, status: true, description: true },
      });
      if (!task) throw new Error("No task with that id.");
      return toolOk(`Read page for “${task.title}”.`, {
        title: task.title,
        status: labelStatus(task.status),
        description: task.description,
        notes: task.notes ?? "",
        content: page?.content ?? null,
      });
    },
  }),
];

const FIELD_WORDS: Record<string, string> = {
  status: "status",
  priority: "priority",
  owner: "owner",
  complexity: "complexity",
  due: "due date",
  projectId: "project",
  projectName: "project",
  people: "people",
  labels: "tags",
  repoId: "repository",
  deliverableId: "deliverable",
  skillIds: "skills",
  todayFocus: "Today focus",
  snoozedUntil: "snooze",
};

/** `Marked “Draft brief” done.`, `Renamed “Old” to “New”.`, `Updated “Draft brief”: priority and due date.` */
export function updateSummary(before: string, title: string, patch: Record<string, unknown>, page: boolean): string {
  const renamed = typeof patch.title === "string" && !titlesMatch(before, title);
  const fields = [...new Set(Object.entries(patch).filter(([key, value]) => value !== undefined && FIELD_WORDS[key]).map(([key]) => FIELD_WORDS[key]!))];
  if (page) fields.push("page");
  const list = fields.length > 1 ? `${fields.slice(0, -1).join(", ")} and ${fields[fields.length - 1]}` : (fields[0] ?? "");
  if (renamed) return `Renamed “${before}” to “${title}”${list ? `; changed ${list}` : ""}.`;
  if (patch.status === "done" && fields.length === 1) return `Marked “${title}” done.`;
  return list ? `Updated “${title}”: ${list}.` : `Updated “${title}”.`;
}

type BulkTaskInput = { taskIds?: string[]; all?: boolean; status?: z.infer<typeof TaskStatus>; owner?: "me" | "agent" | "unassigned"; label?: string; projectId?: string; query?: string };

/** The exact tasks a bulk change means: the ids given, or every task on the board that matches the filter. */
async function bulkTaskIds(ctx: ToolContext, input: BulkTaskInput): Promise<string[]> {
  if (input.taskIds?.length) return [...new Set(input.taskIds)];
  const rows = await ctx.prisma.task.findMany({
    where: {
      userId: ctx.userId,
      deletedAt: null,
      ...(input.status ? { status: input.status } : {}),
      ...(input.owner ? { owner: input.owner } : {}),
      ...(input.label ? { labels: { has: input.label } } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.query
        ? {
            OR: [
              { title: { contains: input.query, mode: "insensitive" as const } },
              { description: { contains: input.query, mode: "insensitive" as const } },
              { notes: { contains: input.query, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    orderBy: [{ boardOrder: "asc" }, { createdAt: "asc" }],
    take: MAX_BULK_TASKS + 1,
    select: { id: true },
  });
  if (!rows.length) throw Object.assign(new Error("No tasks on the board match that."), { statusCode: 404 });
  if (rows.length > MAX_BULK_TASKS) throw Object.assign(new Error(`More than ${MAX_BULK_TASKS} tasks match. Narrow it with status, label or projectId and do it in parts.`), { statusCode: 400 });
  return rows.map((row) => row.id);
}

/** A project proposed earlier in this batch can be named before it exists in the database. */
export function proposedProjectName(call: { name: string; state?: string; input?: Record<string, unknown> }): string | null {
  if (call.name !== "hub_create_project") return null;
  if (call.state !== "awaiting_approval" && call.state !== "ok") return null;
  const name = call.input?.name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

async function assertProjectName(ctx: ToolContext, name: string): Promise<void> {
  const wanted = name.trim().toLowerCase();
  if ((ctx.pendingProjectNames ?? []).some((pending) => pending.trim().toLowerCase() === wanted)) return;
  const project = await ctx.prisma.project.findFirst({
    where: { userId: ctx.userId, deletedAt: null, name: { equals: name, mode: "insensitive" } },
    select: { id: true },
  });
  if (!project) {
    throw Object.assign(new Error(`No project named “${name}”. Ask which project to use, or offer to create it first.`), {
      statusCode: 400,
    });
  }
}
