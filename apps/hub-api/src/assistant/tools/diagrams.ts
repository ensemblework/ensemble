import { z } from "zod";
import { applyDiagramEdits, explainDiagram, parseDiagram, printDiagram, type DiagramOp } from "@ensemble/block-diagrams";
import { rememberRevision } from "../../diagrams/history.js";
import { defineTool, inTransaction, toolOk, type ToolContext } from "../types.js";

const LINK_KINDS = ["page", "task", "deliverable", "project", "repo"] as const;

const linkSchema = z.object({
  kind: z.enum(LINK_KINDS),
  id: z.string().min(1).max(80),
});

function missing(id: string): Error {
  return Object.assign(new Error("That diagram is not on your account."), { statusCode: 404 });
}

function diagnosticsOf(text: string) {
  const parsed = parseDiagram(text);
  const diagnostics = parsed.diagnostics.map((item) => ({
    line: item.line,
    severity: item.severity,
    message: item.message,
  }));
  const errors = diagnostics.filter((item) => item.severity === "error").length;
  const warnings = diagnostics.filter((item) => item.severity === "warning").length;
  return { parsed, diagnostics, errors, warnings, ok: errors === 0 && warnings === 0 };
}

async function ownedDiagram(ctx: ToolContext, id: string) {
  const row = await ctx.prisma.blockDiagram.findFirst({ where: { id, userId: ctx.userId, deletedAt: null } });
  if (!row) throw missing(id);
  return row;
}

async function assertLinkTarget(ctx: ToolContext, kind: (typeof LINK_KINDS)[number], id: string) {
  const db = ctx.tx ?? ctx.prisma;
  if (kind === "page") {
    const page = await db.taskPage.findFirst({ where: { id, userId: ctx.userId, taskId: null, deletedAt: null }, select: { id: true } });
    if (page) return;
  }
  if (kind === "task" || kind === "page") {
    const row = await db.task.findFirst({ where: { id, userId: ctx.userId, deletedAt: null }, select: { id: true } });
    if (!row) throw Object.assign(new Error("That task is not on your account."), { statusCode: 404 });
    return;
  }
  if (kind === "project") {
    const row = await db.project.findFirst({ where: { id, userId: ctx.userId, deletedAt: null }, select: { id: true } });
    if (!row) throw Object.assign(new Error("That project is not on your account."), { statusCode: 404 });
    return;
  }
  if (kind === "repo") {
    const row = await db.repo.findFirst({ where: { id, userId: ctx.userId, deletedAt: null }, select: { id: true } });
    if (!row) throw Object.assign(new Error("That repo is not on your account."), { statusCode: 404 });
    return;
  }
  const row = await db.deliverable.findFirst({ where: { id, userId: ctx.userId, deletedAt: null }, select: { id: true } });
  if (!row) throw Object.assign(new Error("That deliverable is not on your account."), { statusCode: 404 });
}

export const diagramTools = [
  defineTool({
    name: "hub_list_diagrams",
    area: "context",
    description: "List this person's block diagrams. Optional query matches the title. Read-only.",
    input: z.object({ query: z.string().optional() }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const rows = await ctx.prisma.blockDiagram.findMany({
        where: {
          userId: ctx.userId,
          deletedAt: null,
          ...(input.query ? { title: { contains: input.query, mode: "insensitive" } } : {}),
        },
        orderBy: { updatedAt: "desc" },
        take: 30,
        select: { id: true, title: true, updatedAt: true },
      });
      return toolOk(
        rows.length ? `${rows.length} diagram${rows.length === 1 ? "" : "s"}.` : "No diagrams yet.",
        { diagrams: rows.map((row) => ({ id: row.id, title: row.title, updatedAt: row.updatedAt.toISOString() })) },
      );
    },
  }),
  defineTool({
    name: "hub_get_diagram",
    area: "context",
    description: "Read one diagram's source text. Use this before editing. The diagram must belong to the signed-in person.",
    input: z.object({ diagramId: z.string().uuid() }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const row = await ownedDiagram(ctx, input.diagramId);
      return toolOk(`Diagram “${row.title}”.`, {
        id: row.id,
        title: row.title,
        version: row.version,
        source: row.source,
        updatedAt: row.updatedAt.toISOString(),
      });
    },
  }),
  defineTool({
    name: "hub_validate_diagram",
    area: "context",
    description:
      "Parse Ensemble diagram text and return diagnostics. Does not save. Call this, fix every error and warning, and call it again until ok is true. Then create or update.",
    input: z.object({ text: z.string().min(1).max(200_000) }),
    isWrite: false,
    risk: "low",
    async run(_ctx, input) {
      const report = diagnosticsOf(input.text);
      return toolOk(report.ok ? "The diagram text is valid." : `${report.errors} error(s), ${report.warnings} warning(s).`, {
        ok: report.ok,
        errors: report.errors,
        warnings: report.warnings,
        diagnostics: report.diagnostics,
      });
    },
  }),
  defineTool({
    name: "hub_create_diagram",
    area: "context",
    description:
      "Create a block diagram from Ensemble diagram text. Call hub_validate_diagram first and only send text with ok true. links attach it to a task, deliverable, project, repo, or standalone page. Use ids you already read. For diagrams of workspace records, use only their facts. For a conceptual diagram the person explicitly requested, explain that concept. A write normally waits for Apply; inline page requests can authorize creation immediately.",
    input: z.object({
      title: z.string().min(1).max(200),
      text: z.string().min(1).max(200_000),
      links: z.array(linkSchema).max(12).optional(),
    }),
    isWrite: true,
    risk: "low",
    undoable: true,
    preview(_ctx, input) {
      const links = input.links?.length ? ` linked to ${input.links.length} item${input.links.length === 1 ? "" : "s"}` : "";
      return `Create diagram “${input.title}”${links}`;
    },
    async run(ctx, input) {
      const report = diagnosticsOf(input.text);
      if (!report.ok) {
        throw Object.assign(new Error("That diagram text still has problems. Call hub_validate_diagram and fix them first."), { statusCode: 400 });
      }
      const source = printDiagram(report.parsed.model);
      const row = await inTransaction(ctx, async (tx) => {
        const created = await tx.blockDiagram.create({
          data: {
            userId: ctx.userId,
            title: input.title.trim().slice(0, 200),
            source,
            document: report.parsed.model as object,
          },
        });
        for (const link of input.links ?? []) {
          await assertLinkTarget({ ...ctx, tx }, link.kind, link.id);
          await tx.diagramLink.create({
            data: { userId: ctx.userId, diagramId: created.id, targetKind: link.kind, targetId: link.id },
          });
        }
        return created;
      });
      return toolOk(`Created diagram “${row.title}”.`, { id: row.id, title: row.title }, { invalidate: ["diagrams"], href: `/diagrams/${row.id}` });
    },
  }),
  defineTool({
    name: "hub_update_diagram",
    area: "context",
    description:
      "Edit a diagram that belongs to this person. Pass text to replace the whole source, or find and replace for one unique span. Keep ids, locks, and layout unless the person asked to drop them. Validate first. A write waits for Apply.",
    input: z.object({
      diagramId: z.string().uuid(),
      text: z.string().min(1).max(200_000).optional(),
      find: z.string().min(1).max(20_000).optional(),
      replace: z.string().max(20_000).optional(),
    }),
    isWrite: true,
    risk: "low",
    undoable: true,
    async preview(ctx, input) {
      const row = await ctx.prisma.blockDiagram.findFirst({ where: { id: input.diagramId, userId: ctx.userId, deletedAt: null }, select: { title: true } });
      return `Update diagram “${row?.title ?? input.diagramId}”`;
    },
    async run(ctx, input) {
      const current = await ownedDiagram(ctx, input.diagramId);
      const hasText = input.text !== undefined;
      const hasPatch = input.find !== undefined || input.replace !== undefined;
      if (hasText === hasPatch) {
        throw Object.assign(new Error("Pass either text, or both find and replace, not both and not neither."), { statusCode: 400 });
      }
      let next = input.text ?? "";
      if (!hasText) {
        if (input.find === undefined || input.replace === undefined) {
          throw Object.assign(new Error("A patch needs both find and replace."), { statusCode: 400 });
        }
        const at = current.source.indexOf(input.find);
        if (at < 0 || current.source.indexOf(input.find, at + 1) >= 0) {
          throw Object.assign(new Error("find must match exactly one place in the diagram text."), { statusCode: 400 });
        }
        next = `${current.source.slice(0, at)}${input.replace}${current.source.slice(at + input.find.length)}`;
      }
      const report = diagnosticsOf(next);
      if (!report.ok) {
        throw Object.assign(new Error("That diagram text still has problems. Call hub_validate_diagram and fix them first."), { statusCode: 400 });
      }
      const source = printDiagram(report.parsed.model);
      await rememberRevision(ctx.prisma, {
        id: current.id,
        userId: current.userId,
        version: current.version,
        title: current.title,
        source: current.source,
        document: current.document as object,
      });
      const updated = await inTransaction(ctx, (tx) =>
        tx.blockDiagram.update({
          where: { id: current.id },
          data: {
            title: report.parsed.model.meta.title.trim().slice(0, 200) || current.title,
            source,
            document: report.parsed.model as object,
            version: { increment: 1 },
          },
        }),
      );
      return toolOk(`Updated “${updated.title}”.`, { id: updated.id, version: updated.version }, { invalidate: ["diagrams"], href: `/diagrams/${updated.id}` });
    },
  }),
  defineTool({
    name: "hub_edit_diagram",
    area: "context",
    description:
      "Refine a diagram with a few semantic edits: add_node, remove_node, rename_node, add_edge, remove_edge, move_to_group, set_node (shape and colour), set_curve, or patch (one unique find/replace). Keeps ids, locks, and layout. Re-validates. A locked block cannot be removed or moved. A write waits for Apply.",
    input: z.object({
      diagramId: z.string().uuid(),
      ops: z
        .array(
          z.object({
            op: z.enum(["add_node", "remove_node", "rename_node", "add_edge", "remove_edge", "move_to_group", "set_node", "set_curve", "patch"]),
            id: z.string().min(1).max(80).optional(),
            label: z.string().min(1).max(200).optional(),
            shape: z.string().min(1).max(40).optional(),
            color: z.string().max(40).nullable().optional(),
            group: z.string().max(80).nullable().optional(),
            from: z.string().min(1).max(80).optional(),
            to: z.string().min(1).max(80).optional(),
            curve: z.enum(["straight", "curved", "elbow"]).optional(),
            edge: z.string().min(1).max(80).optional(),
            find: z.string().min(1).max(20_000).optional(),
            replace: z.string().max(20_000).optional(),
          }),
        )
        .min(1)
        .max(40),
    }),
    isWrite: true,
    risk: "low",
    undoable: true,
    async preview(ctx, input) {
      const row = await ctx.prisma.blockDiagram.findFirst({ where: { id: input.diagramId, userId: ctx.userId, deletedAt: null } });
      if (!row) return "Update a diagram";
      const edited = applyDiagramEdits(row.source, input.ops as DiagramOp[]);
      const lines = edited.changes.slice(0, 12);
      return [`Update diagram “${row.title}”`, ...lines, edited.changes.length > lines.length ? `…and ${edited.changes.length - lines.length} more` : ""]
        .filter(Boolean)
        .join("\n");
    },
    async run(ctx, input) {
      const current = await ownedDiagram(ctx, input.diagramId);
      const edited = applyDiagramEdits(current.source, input.ops as DiagramOp[]);
      await rememberRevision(ctx.prisma, {
        id: current.id,
        userId: current.userId,
        version: current.version,
        title: current.title,
        source: current.source,
        document: current.document as object,
      });
      const updated = await inTransaction(ctx, (tx) =>
        tx.blockDiagram.update({
          where: { id: current.id },
          data: {
            title: edited.model.meta.title.trim().slice(0, 200) || current.title,
            source: edited.source,
            document: edited.model as object,
            version: { increment: 1 },
          },
        }),
      );
      return toolOk(`Updated “${updated.title}”.`, { id: updated.id, version: updated.version, changes: edited.changes }, {
        invalidate: ["diagrams"],
        href: `/diagrams/${updated.id}`,
      });
    },
  }),
  defineTool({
    name: "hub_explain_diagram",
    area: "context",
    description: "Explain one diagram in plain language for someone who does not write software. Read-only. Does not change the diagram.",
    input: z.object({ diagramId: z.string().uuid() }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const row = await ownedDiagram(ctx, input.diagramId);
      const parsed = parseDiagram(row.source);
      return toolOk(explainDiagram(parsed.model), { id: row.id, title: row.title, explanation: explainDiagram(parsed.model) });
    },
  }),
];
