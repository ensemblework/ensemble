import { z } from "zod";
import { Priority, TaskStatus } from "@ensemble/shared-types";
import { createTask, labelPriority, labelStatus, taskChangePreview, titlesMatch, updateTask } from "../../services/tasks.js";
import { softDelete } from "../../services/records.js";
import { defineTool, inTransaction, toolOk, type ToolContext } from "../types.js";

const Due = z
  .string()
  .refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isNaN(Date.parse(value)), "YYYY-MM-DD or an ISO datetime")
  .nullable()
  .optional();

const TaskDraftInput = z
  .object({
    title: z.string().min(1),
    description: z.string().optional(),
    notes: z.string().optional(),
    owner: z.enum(["me", "agent", "unassigned"]).optional(),
    status: TaskStatus.optional(),
    priority: Priority.describe("p0 = High/urgent, p1 = Normal, p2 = Low").optional(),
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
  .strict();

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
      return toolOk(`Listed ${tasks.length} of ${total} task(s).`, { tasks, total, offset: input.offset, limit: input.limit });
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
      "Add one or more todos. Prefer one call with several tasks. Set status to proposed for work you inferred. priority p0 is High, p1 is Normal, p2 is Low. Use projectName to attach tasks to a project created earlier in this turn.",
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
        return `- ${bits.join(", ")}`;
      });
      return `Add ${input.tasks.length} task(s):\n${lines.join("\n")}`;
    },
    async run(ctx, input) {
      const created = await inTransaction(ctx, async (tx) => {
        const rows = [];
        for (const draft of input.tasks) {
          const { taskId: _ignored, ...fields } = draft;
          rows.push(
            await createTask(
              tx,
              ctx.userId,
              { ...fields, due: fields.due ?? undefined, sourceRef: ctx.conversationId ? `assistant:${ctx.conversationId}` : "assistant" },
              "agent",
            ),
          );
        }
        return rows;
      });
      const listed = created.map((row) => `“${row.title}” (${row.id})`).join("; ");
      return toolOk(`Added ${created.length} task(s): ${listed}.`, { tasks: created.map((row) => ({ id: row.id, title: row.title, projectId: row.projectId })) }, {
        invalidate: ["tasks"],
        href: created[0] ? `/tasks/${created[0].id}` : undefined,
      });
    },
  }),
  defineTool({
    name: "hub_update_task",
    area: "tasks",
    description:
      "Update fields on an existing task, including marking it done. taskId must be the exact id from hub_list_tasks (search with query). matchTitle must be that task's current title. The write is refused when they do not match. priority p0 is High, p1 is Normal, p2 is Low. Do not use this to link a repo or create a person.",
    input: z
      .object({
        taskId: z.string().uuid(),
        matchTitle: z.string().min(1).describe("The task's current title. Refused when this is not the title of taskId."),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        notes: z.string().optional(),
        owner: z.enum(["me", "agent", "unassigned"]).optional(),
        status: TaskStatus.optional(),
        priority: Priority.describe("p0 = High/urgent, p1 = Normal, p2 = Low").optional(),
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
      .strict(),
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
      return taskChangePreview(task.title, {
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
    },
    async run(ctx, input) {
      const { taskId, matchTitle, ...patch } = input;
      const task = await inTransaction(ctx, (tx) =>
        updateTask(tx, ctx.userId, taskId, { ...patch, matchTitle, due: patch.due ?? undefined }, "agent"),
      );
      return toolOk(`Updated “${task.title}”.`, { task: { id: task.id, title: task.title, status: task.status, owner: task.owner, priority: task.priority, due: task.due, completedAt: task.completedAt, projectId: task.projectId } }, {
        invalidate: ["tasks"],
        href: `/tasks/${task.id}`,
      });
    },
  }),
  defineTool({
    name: "hub_delete_task",
    area: "tasks",
    description: "Move a task to Trash. It can be restored. Do not use this when the person meant a different entity.",
    input: z.object({ taskId: z.string().uuid() }).strict(),
    isWrite: true,
    risk: "medium",
    undoable: true,
    async preview(ctx, input) {
      const task = await ctx.prisma.task.findFirst({ where: { id: input.taskId, userId: ctx.userId }, select: { title: true } });
      return `Move “${task?.title ?? input.taskId}” to Trash`;
    },
    async run(ctx, input) {
      const result = await inTransaction(ctx, (tx) => softDelete(tx, ctx.userId, "task", input.taskId, "agent"));
      return toolOk(`Moved “${result.label}” to Trash.`, { ok: true }, { invalidate: ["tasks"] });
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
