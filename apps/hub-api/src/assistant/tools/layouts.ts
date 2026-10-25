import { nativeLayout, nativeDocument, editNativeLayout } from "./native-layouts.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { hasModule } from "@ensemble/shared-types";
import { WIDGET_REGISTRY, placementKey, type LayoutDocument, type WidgetId } from "@ensemble/shared-types/widgets";
import { LayoutBody, SurfaceName, parseLayout } from "../../layouts/document.js";
import { readLayout } from "../../routes/layouts.js";
import { recordUndoInTransaction, withUndoGroup } from "../../lib/undo.js";
import { defineTool, inTransaction, toolOk, type ToolContext } from "../types.js";

const version = (doc: unknown) => createHash("sha256").update(JSON.stringify(doc)).digest("hex").slice(0, 16);
const Edit = z.object({
  action: z.enum(["add", "update", "remove", "move"]),
  type: z.string().max(60).describe("A type from hub_read_layout.available."),
  slot: z.union([z.literal(0), z.literal(1)]).optional(),
  size: z.enum(["s", "m", "l", "xl"]).optional(),
  c: z.number().int().min(3).max(12).optional(),
  r: z.number().int().min(2).max(8).optional(),
  index: z.number().int().min(0).max(11).optional().describe("Zero-based destination; omit to append."),
  config: LayoutBody.shape.placements.element.shape.config,
}).strict();
const Input = z.object({ surface: SurfaceName, view: z.enum(["current", "widgets"]).optional(), tab: z.string().max(40).optional(), version: z.string().min(1), edits: z.array(Edit).max(12).default([]), collapsed: z.boolean().optional(), wipCap: z.number().int().min(1).max(50).optional() });

async function plan(ctx: ToolContext, input: z.infer<typeof Input>) {
  const current = await readLayout(ctx.tx ?? ctx.prisma, ctx.userId, input.surface);
  if (version(current.document) !== input.version) throw new Error("The tiles changed. Read the layout again before editing.");
  const doc = structuredClone(current.document) as LayoutDocument;
  for (const edit of input.edits) {
    const spec = WIDGET_REGISTRY[edit.type as WidgetId];
    if (!spec || !spec.surfaces.includes(input.surface) || (spec.requires && ctx.modules !== undefined && !hasModule(ctx.modules, spec.requires))) throw new Error("That tile is not available on this surface. Use hub_read_layout.available.");
    const key = placementKey(edit);
    const at = doc.placements.findIndex(row => placementKey(row) === key);
    if (edit.action === "add") {
      if (at !== -1) throw new Error("That tile is already here. Use update or move.");
      doc.placements.splice(edit.index ?? doc.placements.length, 0, { type: edit.type as WidgetId, size: edit.size ?? spec.defaultSize, slot: edit.slot, config: edit.config });
    } else {
      if (at === -1) throw new Error("That tile is not in this layout. Read it again.");
      const row = doc.placements[at]!;
      if (edit.action === "remove") doc.placements.splice(at, 1);
      if (edit.action === "update") doc.placements[at] = { ...row, ...(edit.size ? { size: edit.size } : {}), ...(edit.config ? { config: { ...row.config, ...edit.config } } : {}) };
      if (edit.action === "move") { doc.placements.splice(at, 1); doc.placements.splice(edit.index ?? doc.placements.length, 0, row); }
    }
  }
  const document = parseLayout(input.surface, doc);
  const ids = [...new Set(document.placements.flatMap(row => row.config?.projectId ? [row.config.projectId] : []))];
  if (ids.length && await (ctx.tx ?? ctx.prisma).project.count({ where: { userId: ctx.userId, deletedAt: null, id: { in: ids } } }) !== ids.length) throw new Error("A tile refers to a project outside this space.");
  return { before: current.document, document };
}

export const layoutTools = [
  defineTool({ name: "hub_read_layout", area: "context", description: "Read the actual Today, Board or Context tiles, their order and sizes. Uses the active profile or widgets view. Board overview tiles have fixed sizes and a four-tile limit. Returns version for hub_edit_layout.", input: z.object({ surface: SurfaceName, view: z.enum(["current", "widgets"]).optional(), tab: z.string().max(40).optional() }), isWrite: false, risk: "low", async run(ctx, input) {
    const native = await nativeLayout(ctx, input.surface, input.view, input.tab);
    if (native) return toolOk(`${input.surface} ${native.kind} tiles.`, { kind: native.kind, document: nativeDocument(native), version: native.version, available: native.available.map(row => ({ type: row.key, label: row.title, ...(row.description ? { about: row.description } : {}), ...(native.kind === "board" ? { fixedSize: true } : { c: row.c, r: row.r }) })), limits: native.kind === "board" ? { maxTiles: 4, fixedSize: true } : { columns: 12, maxRows: 8 } });
    const layout = await readLayout(ctx.prisma, ctx.userId, input.surface);
    const available = Object.entries(WIDGET_REGISTRY).filter(([, spec]) => spec.surfaces.includes(input.surface) && (!spec.requires || ctx.modules === undefined || hasModule(ctx.modules, spec.requires))).map(([type, spec]) => ({ type, label: spec.label, min: spec.min, max: spec.max, size: spec.defaultSize, repeatable: spec.repeatable ?? false }));
    return toolOk(`${input.surface} tiles.`, { document: layout.document, version: version(layout.document), available });
  } }),
  defineTool({ name: "hub_edit_layout", area: "context", description: "Add, configure, resize, move or remove tiles on Today, Board or Context. Read hub_read_layout first; use its actual tile types/version. Desk sizes use c (3–12 columns) and r (2–8 rows). Board tiles only add/remove/move. Use view widgets only for that alternate view; tab selects a Context panel. Keeps other tiles.", input: Input, isWrite: true, risk: "low", undoable: true,
    async preview(ctx, input) { const native = await nativeLayout(ctx, input.surface, input.view, input.tab); if (native) { await editNativeLayout(ctx, native, input, true); return `Change ${input.surface} tiles: ${input.edits.map(edit => `${edit.action} ${native.available.find(tile => tile.key === edit.type)?.title ?? edit.type}${edit.c || edit.r ? ` (${edit.c ?? "current"} columns × ${edit.r ?? "current"} rows)` : ""}`).join("; ")}${input.collapsed !== undefined ? `; overview collapsed ${input.collapsed}` : ""}${input.wipCap ? `; WIP cap ${input.wipCap}` : ""}`; } await plan(ctx, input); return `Change ${input.surface} tiles: ${input.edits.map(edit => `${edit.action} ${WIDGET_REGISTRY[edit.type as WidgetId]?.label ?? edit.type}${edit.size ? ` (${edit.size})` : ""}${edit.config ? ` (${Object.entries(edit.config).map(([key, value]) => `${key} ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(", ")})` : ""}`).join("; ")}`; },
    async run(ctx, input) {
      const result = await inTransaction(ctx, async tx => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${ctx.userId} FOR UPDATE`;
        const native = await nativeLayout({ ...ctx, tx }, input.surface, input.view, input.tab);
        if (native) {
          await withUndoGroup(tx, { userId: ctx.userId, actor: "agent", subject: "layout" }, () => editNativeLayout({ ...ctx, tx }, native, input));
          const next = await nativeLayout({ ...ctx, tx }, input.surface, input.view, input.tab);
          return { document: nativeDocument(next!), version: next!.version };
        }
        const { before, document } = await plan({ ...ctx, tx }, input);
        const row = await tx.widgetLayout.upsert({ where: { userId_surface: { userId: ctx.userId, surface: input.surface } }, create: { userId: ctx.userId, surface: input.surface, document: before as object }, update: {} });
        const saved = await tx.widgetLayout.update({ where: { id: row.id }, data: { document: document as object } });
        const op = { op: "update" as const, model: "widgetLayout" as const, id: row.id, before: { document: before, updatedAt: row.updatedAt }, after: { document, updatedAt: saved.updatedAt } };
        await recordUndoInTransaction(tx, { userId: ctx.userId, actor: "agent", label: `Changed ${input.surface} tiles`, kind: "update", subject: "layout", inverse: op, forward: op });
        return { document, version: version(document) };
      });
      return toolOk(`Updated ${input.surface} tiles.`, result, { href: `/${input.surface}`, invalidate: ["preferences", "layouts", "layout", `layout-${input.surface}`] });
    }
  }),
];
