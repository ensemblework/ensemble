import { z } from "zod";
import { assistantRequest } from "../request.js";
import { defineTool, inTransaction, toolOk, type ToolContext } from "../types.js";
import { AddInput, KINDS, itemLabel } from "./desk.js";
import { updateTask } from "../../services/tasks.js";
import { recordUndoInTransaction, type UndoModel } from "../../lib/undo.js";
import { sseHub } from "../../lib/sse.js";

const Id = z.string().uuid();
const DeskInput = AddInput.extend({ id: Id });

/** “A”, “B” and 2 others: names for a preview, never ids. */
async function names(ctx: ToolContext, kind: "person" | "repo", ids: string[]): Promise<string> {
  if (!ids.length) return "none";
  const rows = kind === "person"
    ? (await ctx.prisma.person.findMany({ where: { id: { in: ids }, userId: ctx.userId, deletedAt: null }, select: { name: true } })).map((row) => row.name)
    : (await ctx.prisma.repo.findMany({ where: { id: { in: ids }, userId: ctx.userId, deletedAt: null }, select: { fullName: true } })).map((row) => row.fullName);
  const shown = rows.slice(0, 6).map((name) => `“${name}”`).join(", ");
  const rest = ids.length - Math.min(rows.length, 6);
  return `${shown}${rest > 0 ? `${shown ? " and " : ""}${rest} other${rest === 1 ? "" : "s"}` : ""}`;
}

async function projectName(ctx: ToolContext, id: string): Promise<string> {
  const row = await ctx.prisma.project.findFirst({ where: { id, userId: ctx.userId, deletedAt: null }, select: { name: true } });
  if (!row) throw new Error("That project is not in this space. Call hub_list_projects and use an id it returns.");
  return row.name;
}

async function pageTitle(db: Pick<ToolContext["prisma"], "taskPage">, userId: string, id: string): Promise<string> {
  const row = await db.taskPage.findFirst({ where: { id, userId, taskId: null, deletedAt: null }, select: { title: true } });
  if (!row) throw new Error("Page not found. Call hub_list_pages and use an id it returns.");
  return row.title || "Untitled";
}

/** Desk entry fields that change, by the names hub_add_desk_item uses. */
const changedFields = (input: Record<string, unknown>) =>
  Object.entries(input)
    .filter(([key, value]) => value !== undefined && key !== "kind" && key !== "id")
    .map(([key, value]) => `${key} ${String(value).slice(0, 80)}`)
    .join(", ");
export const recordTools = [
  defineTool({ name: "hub_update_project", area: "projects", description: "Change an existing project's name, summary, notes, active/done status, People links or repository links. personIds/repoIds replace that entire list; omit to keep it. Read project/People/repositories first.", input: z.object({ projectId: Id, name: z.string().min(1).max(200).optional(), summary: z.string().max(4000).optional(), notes: z.string().max(30000).optional(), status: z.enum(["active", "done"]).optional(), personIds: z.array(Id).max(100).optional(), repoIds: z.array(Id).max(100).optional() }), isWrite: true, risk: "low", outsideTransaction: true,
    async preview(ctx, input) {
      const name = await projectName(ctx, input.projectId);
      const changes = [
        input.name !== undefined && input.name !== name ? `rename to “${input.name}”` : "",
        input.status ? `mark ${input.status}` : "",
        input.summary !== undefined ? "rewrite the summary" : "",
        input.notes !== undefined ? "rewrite the notes" : "",
        input.personIds ? `people: ${await names(ctx, "person", input.personIds)}` : "",
        input.repoIds ? `repositories: ${await names(ctx, "repo", input.repoIds)}` : "",
      ].filter(Boolean);
      return `Update project “${name}”${changes.length ? `: ${changes.join("; ")}` : ""}`;
    },
    async run(ctx, input) { const { projectId, ...patch } = input; await assistantRequest(ctx, "PATCH", `/api/projects/${projectId}`, patch); const name = await projectName(ctx, projectId); return toolOk(`Updated project “${name}”.`, { id: projectId, name }, { href: `/projects/${projectId}`, invalidate: ["projects", "context"] }); }
  }),
  defineTool({ name: "hub_update_repo", area: "context", description: "Change a known repository's tracked status or description. Link projects with hub_link_repo.", input: z.object({ repoId: Id, tracked: z.boolean().optional(), description: z.string().max(4000).nullable().optional() }), isWrite: true, risk: "low", outsideTransaction: true,
    async preview(ctx, input) {
      const repo = await ctx.prisma.repo.findFirst({ where: { id: input.repoId, userId: ctx.userId, deletedAt: null }, select: { fullName: true } });
      if (!repo) throw new Error("That repository is not in this space. Call hub_list_repos and use an id it returns.");
      const changes = [input.tracked !== undefined ? (input.tracked ? "track it" : "stop tracking it") : "", input.description !== undefined ? (input.description ? `description “${input.description.slice(0, 120)}”` : "clear the description") : ""].filter(Boolean);
      return `Update repository “${repo.fullName}”${changes.length ? `: ${changes.join("; ")}` : ""}`;
    },
    async run(ctx, input) { const { repoId, ...patch } = input; await assistantRequest(ctx, "PATCH", `/api/repos/${repoId}`, patch); const repo = await ctx.prisma.repo.findFirst({ where: { id: repoId, userId: ctx.userId }, select: { fullName: true } }); return toolOk(repo ? `Updated repository “${repo.fullName}”.` : "Updated the repository.", { id: repoId, ...(repo ? { fullName: repo.fullName } : {}) }, { invalidate: ["repos", "context"] }); }
  }),
  defineTool({ name: "hub_update_desk_item", area: "context", description: "Update an existing profile-list entry without changing its ID: parts, checks, objectives, timetable, attendance, citations, grades, deploys, hearings, matters, papers and other lists. Use kind/id from hub_list_desk_items and only the changed fields, named as hub_add_desk_item.", input: DeskInput, isWrite: true, risk: "low", undoable: true,
    async preview(ctx, input) {
      const label = await itemLabel(ctx, input.kind, input.id);
      if (!label) throw new Error(`No ${KINDS[input.kind].label.toLowerCase()} entry with that id. Call hub_list_desk_items with kind ${input.kind}.`);
      const fields = changedFields(input as Record<string, unknown>);
      return `Update “${label}” in ${KINDS[input.kind].label}${fields ? `: ${fields}` : ""}`;
    },
    async run(ctx, input) {
      const label = await inTransaction(ctx, async tx => {
        const kind = input.kind, spec = KINDS[kind];
        if (spec.store === "task") {
          const before = await tx.task.findFirst({ where: { id: input.id, userId: ctx.userId, deletedAt: null, taskType: kind } });
          if (!before) throw new Error("That entry is not in this list.");
          if (input.score !== undefined && input.outOf !== undefined && input.score > input.outOf) throw new Error("Score cannot exceed outOf.");
          const row = await updateTask(tx, ctx.userId, input.id, { title: input.title, due: input.day, subject: input.subject, court: input.court, orderDate: input.orderDate, limitationRule: input.rule, wordCount: input.words, ...(input.stage !== undefined ? (kind === "matter" || kind === "hearing" ? { matterStage: input.stage } : { pipelineStage: input.stage }) : {}), ...(input.hours !== undefined ? { measure: Math.round(input.hours * 60) } : input.score !== undefined ? { measure: input.score } : {}), ...(input.outOf !== undefined ? { weight: input.outOf } : {}) }, "agent");
          return row?.title ?? before.title;
        }
        const mapping: Record<string, { model: string; schema: z.ZodTypeAny; fields: Record<string, unknown> }> = {
          part: { model: "partRow", schema: z.object({ name: z.string().min(1).max(200).optional(), qty: z.number().int().min(1).optional(), status: z.enum(["out", "ordered", "in"]).optional() }), fields: { name: input.title, qty: input.qty, status: input.status } },
          test: { model: "testResult", schema: z.object({ name: z.string().min(1).max(200).optional(), build: z.string().max(40).optional(), status: z.enum(["pass", "fail", "unknown"]).optional() }), fields: { name: input.title, build: input.build, status: input.status } },
          objective: { model: "objective", schema: z.object({ title: z.string().min(1).max(200).optional(), progress: z.number().int().min(0).max(100).optional() }), fields: { title: input.title, progress: input.progress } },
          grade: { model: "gradingRow", schema: z.object({ className: z.string().min(1).max(200).optional(), expected: z.number().int().nonnegative().optional(), marked: z.number().int().nonnegative().optional() }), fields: { className: input.title, expected: input.expected, marked: input.marked } },
          citation: { model: "citationLink", schema: z.object({ fromTitle: z.string().min(1).optional(), toTitle: z.string().min(1).optional() }), fields: { fromTitle: input.title, toTitle: input.cites } },
          deploy: { model: "deployEvent", schema: z.object({ name: z.string().min(1).optional(), env: z.string().max(20).optional() }), fields: { name: input.title, env: input.env } },
          holiday: { model: "courtHoliday", schema: z.object({ name: z.string().min(1).optional(), day: z.date().optional() }), fields: { name: input.title, day: input.day ? new Date(`${input.day}T00:00:00Z`) : undefined } },
          person: { model: "person", schema: z.object({ name: z.string().min(1).optional(), capacityHours: z.number().min(0).max(80).optional(), oneOnOneDays: z.number().int().min(1).max(90).optional() }), fields: { name: input.title, capacityHours: input.capacity, oneOnOneDays: input.cadence } },
          slot: { model: "timetableSlot", schema: z.object({ title: z.string().min(1).optional(), weekday: z.number().int().min(0).max(6).optional(), startMin: z.number().int().optional(), endMin: z.number().int().optional(), course: z.string().optional() }), fields: { title: input.title, weekday: input.weekday, startMin: input.start ? Number(input.start.slice(0, 2)) * 60 + Number(input.start.slice(3)) : undefined, endMin: input.end ? Number(input.end.slice(0, 2)) * 60 + Number(input.end.slice(3)) : undefined, course: input.course } },
          attendance: { model: "attendanceMark", schema: z.object({ present: z.boolean().optional(), day: z.date().optional() }), fields: { present: input.present, day: input.day ? new Date(`${input.day}T00:00:00Z`) : undefined } },
        };
        const item = mapping[spec.store]; if (!item) throw new Error("That list cannot be updated.");
        const delegate = (tx as unknown as Record<string, any>)[item.model];
        const before = await delegate.findFirst({ where: { id: input.id, userId: ctx.userId, ...(spec.store === "person" ? { deletedAt: null } : {}) } });
        if (!before) throw new Error("That entry was not found in this space.");
        const data = item.schema.parse(Object.fromEntries(Object.entries(item.fields).filter(([, value]) => value !== undefined)));
        if (!Object.keys(data).length) throw new Error("Send at least one field this list supports.");
        if (spec.store === "slot" && (data.endMin ?? before.endMin) <= (data.startMin ?? before.startMin)) throw new Error("The class must end after it starts.");
        const after = await delegate.update({ where: { id: input.id }, data });
        const op = { op: "update" as const, model: item.model as UndoModel, id: input.id, before, after };
        await recordUndoInTransaction(tx, { userId: ctx.userId, actor: "agent", label: `Updated ${kind}`, kind: "update", subject: kind, inverse: op, forward: op });
        return itemLabel({ ...ctx, prisma: tx as ToolContext["prisma"] }, kind, input.id);
      });
      return toolOk(label ? `Updated “${label}” in ${KINDS[input.kind].label}.` : `Updated ${input.kind}.`, { id: input.id, kind: input.kind, ...(label ? { title: label } : {}) }, { href: "/today", invalidate: ["desk-live", "context", "tasks"] });
    }
  }),
  defineTool({ name: "hub_move_page", area: "projects", description: "Move a standalone page beneath another page, or to the top level with parentId null. Keeps the page and its descendants. Cannot create a nesting cycle.", input: z.object({ pageId: Id, parentId: Id.nullable() }), isWrite: true, risk: "low", undoable: true,
    async preview(ctx, input) { return `Move “${await pageTitle(ctx.prisma, ctx.userId, input.pageId)}” ${input.parentId ? `under “${await pageTitle(ctx.prisma, ctx.userId, input.parentId)}”` : "to the top level"}.`; },
    async run(ctx, input) {
      const moved = await inTransaction(ctx, async tx => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${ctx.userId} FOR UPDATE`;
        const before = await tx.taskPage.findFirst({ where: { id: input.pageId, userId: ctx.userId, taskId: null, deletedAt: null } });
        if (!before) throw new Error("Page not found.");
        let parent = input.parentId; const seen = new Set([input.pageId]);
        while (parent) { if (seen.has(parent)) throw new Error("A page cannot be nested under itself or a descendant."); seen.add(parent); const row = await tx.taskPage.findFirst({ where: { id: parent, userId: ctx.userId, taskId: null, deletedAt: null }, select: { parentId: true } }); if (!row) throw new Error("Parent page not found."); parent = row.parentId; }
        const after = await tx.taskPage.update({ where: { id: before.id }, data: { parentId: input.parentId } });
        const op = { op: "update" as const, model: "taskPage" as const, id: before.id, before, after };
        await recordUndoInTransaction(tx, { userId: ctx.userId, actor: "agent", label: "Moved page", kind: "update", subject: "page", inverse: op, forward: op });
        return { title: before.title || "Untitled", parent: input.parentId ? await pageTitle(tx, ctx.userId, input.parentId) : null };
      });
      sseHub.publish(ctx.userId, { event: "page", data: { id: input.pageId, action: "save" } });
      return toolOk(`Moved “${moved.title}” ${moved.parent ? `under “${moved.parent}”` : "to the top level"}.`, { id: input.pageId, title: moved.title }, { invalidate: ["pages"] });
    }
  }),
];
