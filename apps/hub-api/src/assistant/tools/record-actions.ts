import { z } from "zod";
import { hasModule } from "@ensemble/shared-types";
import { assistantRequest } from "../request.js";
import { defineTool, toolOk, type ToolContext } from "../types.js";

const Input = z.object({
  action: z.enum(["restore", "convert_page", "delete_plot", "duplicate_plot", "delete_dataset", "rename_dataset", "delete_diagram", "duplicate_diagram", "restore_diagram_revision", "tag_file", "add_comment", "edit_comment", "resolve_comment", "delete_comment"]),
  id: z.string().uuid(),
  kind: z.enum(["task", "project", "person", "skill", "document", "repo", "deliverable", "reminder", "comment", "meeting", "diagram", "page"]).optional(),
  title: z.string().max(200).optional(), revision: z.number().int().nonnegative().optional(),
  text: z.string().max(20000).optional(),
  projectIds: z.array(z.string().uuid()).max(100).optional(), personIds: z.array(z.string().uuid()).max(100).optional(), repoIds: z.array(z.string().uuid()).max(100).optional(), taskIds: z.array(z.string().uuid()).max(100).optional(),
});
function route(ctx: ToolContext, input: z.infer<typeof Input>): { method: "POST" | "PATCH" | "DELETE"; url: string; body?: object } {
  const need = <T>(value: T | undefined, name: string): T => { if (value === undefined) throw new Error(`Send ${name}.`); return value; };
  const module = input.action.includes("plot") || input.action.includes("dataset") ? "plots" : input.action.includes("diagram") || input.kind === "diagram" ? "diagrams" : input.kind === "skill" ? "skills" : null;
  if (module && ctx.modules !== undefined && !hasModule(ctx.modules, module)) throw new Error("This feature is off in this space.");
  switch (input.action) {
    case "restore": return { method: "POST", url: "/api/deleted/restore", body: { id: input.id, kind: need(input.kind, "kind") } };
    case "convert_page": if (!["page", "task"].includes(input.kind ?? "")) throw new Error("Choose kind page or task."); return { method: "POST", url: `/api/pages/${input.kind}/${input.id}/convert`, body: { revision: need(input.revision, "revision") } };
    case "delete_plot": return { method: "DELETE", url: `/api/plots/${input.id}` };
    case "duplicate_plot": return { method: "POST", url: `/api/plots/${input.id}/duplicate` };
    case "delete_dataset": return { method: "DELETE", url: `/api/plots/datasets/${input.id}` };
    case "rename_dataset": return { method: "PATCH", url: `/api/plots/datasets/${input.id}`, body: { name: need(input.title, "title") } };
    case "delete_diagram": return { method: "DELETE", url: `/api/diagrams/${input.id}` };
    case "duplicate_diagram": return { method: "POST", url: `/api/diagrams/${input.id}/duplicate` };
    case "restore_diagram_revision": return { method: "POST", url: `/api/diagrams/${input.id}/restore`, body: { version: need(input.revision, "revision") } };
    case "tag_file": return { method: "PATCH", url: `/api/documents/${input.id}/tags`, body: { projectIds: input.projectIds ?? [], personIds: input.personIds ?? [], repoIds: input.repoIds ?? [], taskIds: input.taskIds ?? [] } };
    case "add_comment": if (!["page", "task", "project", "deliverable"].includes(input.kind ?? "")) throw new Error("Choose page, task, project or deliverable for the comment."); return { method: "POST", url: `/api/pages/${input.kind}/${input.id}/comments`, body: { body: { text: need(input.text, "text") } } };
    case "edit_comment": return { method: "PATCH", url: `/api/comments/${input.id}`, body: { body: { text: need(input.text, "text") } } };
    case "resolve_comment": return { method: "PATCH", url: `/api/comments/${input.id}`, body: { status: "resolved" } };
    case "delete_comment": return { method: "DELETE", url: `/api/comments/${input.id}` };
  }
}
type Kind = NonNullable<z.infer<typeof Input>["kind"]>;

/** A record's title for a preview, deleted ones included (restore), or null when it is not in this space. */
async function recordTitle(ctx: ToolContext, kind: Kind | "plot" | "dataset", id: string): Promise<string | null> {
  const where = { id, userId: ctx.userId };
  const db = ctx.prisma;
  switch (kind) {
    case "task": return (await db.task.findFirst({ where, select: { title: true } }))?.title ?? null;
    case "project": return (await db.project.findFirst({ where, select: { name: true } }))?.name ?? null;
    case "person": return (await db.person.findFirst({ where, select: { name: true } }))?.name ?? null;
    case "skill": return (await db.skill.findFirst({ where, select: { name: true } }))?.name ?? null;
    case "document": return (await db.document.findFirst({ where, select: { filename: true } }))?.filename ?? null;
    case "repo": return (await db.repo.findFirst({ where, select: { fullName: true } }))?.fullName ?? null;
    case "deliverable": return (await db.deliverable.findFirst({ where, select: { title: true } }))?.title ?? null;
    case "reminder": return (await db.reminder.findFirst({ where, select: { title: true } }))?.title ?? null;
    case "meeting": return (await db.meetingSession.findFirst({ where, select: { title: true } }))?.title ?? null;
    case "diagram": return (await db.blockDiagram.findFirst({ where, select: { title: true } }))?.title ?? null;
    case "page": return (await db.taskPage.findFirst({ where, select: { title: true } }))?.title || (await db.taskPage.findFirst({ where, select: { id: true } }) ? "Untitled page" : null);
    case "plot": return (await db.plot.findFirst({ where, select: { title: true } }))?.title ?? null;
    case "dataset": return (await db.plotDataset.findFirst({ where, select: { name: true } }))?.name ?? null;
    case "comment": {
      const row = await db.pageDiscussion.findFirst({ where, select: { body: true } });
      if (!row) return null;
      const text = row.body && typeof row.body === "object" && !Array.isArray(row.body) ? String((row.body as Record<string, unknown>).text ?? "") : "";
      return text ? `comment “${text.replace(/\s+/g, " ").slice(0, 60)}”` : "a comment";
    }
  }
}

const VERB: Record<z.infer<typeof Input>["action"], string> = {
  restore: "Restore",
  convert_page: "Convert",
  delete_plot: "Delete",
  duplicate_plot: "Duplicate",
  delete_dataset: "Delete",
  rename_dataset: "Rename",
  delete_diagram: "Delete",
  duplicate_diagram: "Duplicate",
  restore_diagram_revision: "Restore",
  tag_file: "Set the tags of",
  add_comment: "Comment on",
  edit_comment: "Edit",
  resolve_comment: "Resolve",
  delete_comment: "Delete",
};

const targetKind = (input: z.infer<typeof Input>): Kind | "plot" | "dataset" =>
  input.action.includes("plot") ? "plot" : input.action.includes("dataset") ? "dataset" : input.action.includes("diagram") ? "diagram" : input.action === "tag_file" ? "document" : input.action.endsWith("_comment") && input.action !== "add_comment" ? "comment" : (input.kind ?? "page");

/** Tag names for a file, by list: “Launch” (project), “Mira Chen” (person). */
async function tagNames(ctx: ToolContext, input: z.infer<typeof Input>): Promise<string> {
  const lists: Array<[Kind, string[] | undefined]> = [["project", input.projectIds], ["person", input.personIds], ["repo", input.repoIds], ["task", input.taskIds]];
  const parts: string[] = [];
  for (const [kind, ids] of lists) {
    for (const id of ids ?? []) parts.push(`“${(await recordTitle(ctx, kind, id)) ?? `a ${kind}`}”`);
  }
  return parts.length ? parts.join(", ") : "no tags";
}

export const recordActionTools = [defineTool({
  name: "hub_read_record_details", area: "context", description: "Read internal comments on a page/task/project/deliverable, or a diagram's saved version list, before editing/restoring. Uses the existing scoped read route.",
  input: z.object({ view: z.enum(["comments", "diagram_versions"]), id: z.string().uuid(), kind: z.enum(["page", "task", "project", "deliverable"]).default("page") }), isWrite: false, risk: "low",
  async run(ctx, input) { const url = input.view === "comments" ? `/api/pages/${input.kind}/${input.id}/comments` : `/api/diagrams/${input.id}/revisions`; return toolOk("Read record details.", await assistantRequest(ctx, "GET", url)); }
}), defineTool({ name: "hub_manage_record", area: "context", description: "Restore one trashed record; convert page/task; duplicate/delete plots or diagrams; rename/delete a dataset; restore a diagram revision; replace a file's tags; or add/edit/resolve/delete an internal Ensemble comment. Use real IDs and read the target first. tag_file replaces all four tag lists. Deleting a dataset may remove dependent plots; preview this with the person.", input: Input, isWrite: true, risk: "medium", outsideTransaction: true,
  async preview(ctx, input) {
    route(ctx, input);
    const kind = targetKind(input);
    const title = await recordTitle(ctx, kind, input.id);
    if (!title) throw new Error(`That ${kind} is not in this space. Read it again and use the id it returns.`);
    const named = kind === "comment" ? title : `${kind === "document" ? "file" : kind} “${title}”`;
    const detail =
      input.action === "rename_dataset" ? ` to “${input.title ?? ""}”`
      : input.action === "restore_diagram_revision" ? ` to version ${input.revision ?? "?"}`
      : input.action === "delete_dataset" ? "; plots using this dataset may also be removed"
      : input.action === "tag_file" ? `; tags become ${await tagNames(ctx, input)}`
      : `${input.title ? `: ${input.title}` : ""}${input.text ? `: ${input.text}` : ""}`;
    return `${VERB[input.action]} ${named}${detail}.`;
  },
  async run(ctx, input) {
    const call = route(ctx, input);
    if (input.action === "rename_dataset") { const row = await ctx.prisma.plotDataset.findFirst({ where: { id: input.id, userId: ctx.userId, deletedAt: null }, select: { columns: true } }); if (!row) throw new Error("Dataset not found."); call.body = { ...call.body, columns: row.columns }; }
    const kind = targetKind(input);
    const title = await recordTitle(ctx, kind, input.id);
    const result = await assistantRequest(ctx, call.method, call.url, call.body);
    const done = `Completed ${input.action.replaceAll("_", " ")}${title && kind !== "comment" ? ` for “${title}”` : ""}.`;
    return toolOk(done, result, { invalidate: ["tasks", "projects", "pages", "plots", "datasets", "diagrams", "documents", "comments", "trash", "context"] });
  }
})];
