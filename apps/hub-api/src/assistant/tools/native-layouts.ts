import { createHash } from "node:crypto";
import { WORKSPACE_TILES } from "@ensemble/shared-types/workspace-tiles";
import { arrange, readLayout, tileLimits, clampSize, type DeskLayout } from "@ensemble/shared-types/desk-layout";
import { DESK_MARKET_ID, templateCard } from "@ensemble/shared-types/manifest";
import { sanitizeLayout } from "@ensemble/shared-types/widgets";
import { recordUndoInTransaction } from "../../lib/undo.js";
import { isGuestIn } from "../../sharing/context.js";
import type { ToolContext } from "../types.js";

type Tile = { key: string; title: string; c: number; r: number; hero?: boolean; description?: string };
type Board = { v: 1; tiles: string[]; collapsed: boolean; wipCap?: number };
export type NativeLayout = { key: string; kind: "board" | "desk" | "context"; version: string; value: unknown; shown: Tile[]; available: Tile[]; hidden: string[]; raw: DeskLayout | Board; extras: string[] };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

export async function nativeLayout(ctx: ToolContext, surface: string, view?: "widgets" | "current", tabInput?: string): Promise<NativeLayout | null> {
  const onSurface = new URL(ctx.page?.path ?? "/", "https://ensemble.invalid").pathname === `/${surface}`;
  if (surface === "board" && view === "widgets") throw new Error("The Board uses its overview tiles. It has no alternate widgets view.");
  if (view === "widgets" || (onSurface && (ctx.page?.surface?.kind === "widgets" || new URL(ctx.page!.path, "https://ensemble.invalid").searchParams.get("view") === "widgets"))) return null;
  const db = ctx.tx ?? ctx.prisma;
  const user = await db.user.findUnique({ where: { id: ctx.userId }, select: { activeTemplateId: true, onboardingTemplateId: true } });
  const desk = Object.entries(DESK_MARKET_ID).find(([, id]) => id === user?.activeTemplateId)?.[0] ?? (user?.activeTemplateId === "default" ? "default" : ["mkt.exam-sprint", "mkt.prelims-season"].includes(user?.activeTemplateId ?? "") ? "exam" : null);
  if (surface !== "board" && !desk) return null;
  const catalog = WORKSPACE_TILES as unknown as { desks: Record<string, { role: string; base: Tile[]; defaults: Tile[]; available: Tile[] }>; roles: Record<string, Tile[]>; contexts: Record<string, Record<string, Tile[]>>; extras: Array<{ id: string; tile: string }>; board: { key: string; max: number; defaults: Record<string, string[]>; available: Array<{ key: string; title: string; description: string }> } };
  const role = templateCard(user?.onboardingTemplateId ?? "")?.role ?? catalog.desks[desk ?? "default"]!.role;
  const tab = tabInput ?? (onSurface ? ctx.page?.surface?.tab ?? new URL(ctx.page!.path, "https://ensemble.invalid").searchParams.get("tab") : null) ?? "overview";
  if (!/^[a-z-]{1,40}$/.test(tab)) throw new Error("Choose a Context tab by its name.");
  const key = surface === "board" ? catalog.board.key : surface === "today" ? `desk.layout.${desk}` : `desk.context.${desk}.${tab}`;
  const pref = await db.preference.findFirst({ where: { userId: ctx.userId, key, deletedAt: null }, select: { value: true } });
  const version = hash({ key, value: pref?.value ?? null, template: user?.activeTemplateId, onboarding: user?.onboardingTemplateId });
  const snapshot = onSurface ? ctx.page?.surface?.tiles : undefined;
  if (surface === "board") {
    const available = catalog.board.available.map(row => ({ ...row, c: 4, r: 3 }));
    const valid = new Set(available.map(row => row.key));
    const value = pref?.value as Partial<Board> | undefined;
    let fallback = catalog.board.defaults[role] ?? catalog.board.defaults.engineer!;
    if (!pref) {
      const legacy = await db.widgetLayout.findUnique({ where: { userId_surface: { userId: ctx.userId, surface: "board" } } });
      if (legacy) { const aliases: Record<string, string> = { "column-summary": "flow", wip: "capacity", blocked: "attention", "week-done": "done" }; fallback = sanitizeLayout("board", legacy.document).document.placements.flatMap(tile => aliases[tile.type] ? [aliases[tile.type]!] : []); }
    }
    if (!pref && snapshot) fallback = snapshot.map(row => row.key).filter(id => valid.has(id));
    const raw: Board = { v: 1, tiles: value?.v === 1 && Array.isArray(value.tiles) ? [...new Set(value.tiles)].filter(id => valid.has(id)).slice(0, catalog.board.max) : fallback.slice(0, catalog.board.max), collapsed: value?.collapsed === true, ...(typeof value?.wipCap === "number" ? { wipCap: value.wipCap } : {}) };
    return { key, kind: "board", version, value: pref?.value ?? null, raw, shown: raw.tiles.map(id => available.find(row => row.key === id)!), available, hidden: [], extras: [] };
  }
  const definition = catalog.desks[desk!]!;
  const extraPref = await db.preference.findFirst({ where: { userId: ctx.userId, key: "desk.extras", deletedAt: null }, select: { value: true } });
  const extras = Array.isArray(extraPref?.value) ? extraPref!.value.filter((item): item is string => typeof item === "string") : desk === "exam" ? ["deadlines"] : desk === "classes" ? ["learning"] : desk === "bench" ? ["bench"] : [];
  const defaults = surface === "context" ? catalog.contexts[desk!]?.[tab] ?? [] : [...definition.base, ...catalog.extras.filter(extra => extras.includes(extra.id)).flatMap(extra => (catalog.roles[role] ?? definition.available).filter(tile => tile.key === extra.tile && !definition.base.some(row => row.key === tile.key)))];
  const available = surface === "context" ? defaults : [...new Map([...(catalog.roles[role] ?? definition.available), ...defaults].map(tile => [tile.key, tile])).values()];
  const raw = readLayout(pref?.value) ?? { v: 1 as const, tiles: defaults.map(({ key, c, r }) => ({ key, c, r })), hidden: [] };
  const nativeKeys = new Set(Object.values(catalog.desks).flatMap(row => row.base.map(tile => tile.key)));
  const blocked = new Set(catalog.extras.filter(extra => !extras.includes(extra.id) && !nativeKeys.has(extra.tile)).map(extra => extra.tile));
  const shown = arrange(defaults, new Map(available.map(row => [row.key, row])), raw, { blocked, extras: new Set(catalog.extras.filter(extra => extras.includes(extra.id)).map(extra => extra.tile)) });
  if (snapshot && !pref) for (const tile of shown) { const live = snapshot.find(row => row.key === tile.key); if (live) Object.assign(tile, clampSize(live, tileLimits(tile))); }
  return { key, kind: surface === "context" ? "context" : "desk", version, value: pref?.value ?? null, raw, shown, available, hidden: [...new Set([...raw.hidden, ...defaults.filter(row => !shown.some(tile => tile.key === row.key)).map(row => row.key)])], extras };
}

export function nativeDocument(layout: NativeLayout) { return { v: 1, placements: layout.shown.map(tile => ({ type: tile.key, size: "m", c: tile.c, r: tile.r })), ...(layout.kind === "board" ? { collapsed: (layout.raw as Board).collapsed, wipCap: (layout.raw as Board).wipCap ?? 3 } : {}) }; }

export async function editNativeLayout(ctx: ToolContext, layout: NativeLayout, input: { version: string; edits: Array<{ action: string; type: string; size?: string; c?: number; r?: number; index?: number; config?: object }>; collapsed?: boolean; wipCap?: number }, preview = false) {
  if (isGuestIn(ctx.userId)) throw new Error("Only the space owner can change its layout.");
  if (layout.version !== input.version) throw new Error("The tiles changed. Read the layout again.");
  const shown = structuredClone(layout.shown);
  for (const edit of input.edits) {
    const spec = layout.available.find(row => row.key === edit.type);
    if (!spec) throw new Error("Choose a type from this layout's available tiles.");
    if (edit.config && Object.keys(edit.config).length) throw new Error("This view has no per-tile filters. Use the board's filters or the widgets view for configurable tiles.");
    const at = shown.findIndex(row => row.key === edit.type);
    if (edit.action === "add") { if (at >= 0) throw new Error("That tile is already here."); shown.splice(edit.index ?? shown.length, 0, { ...spec }); }
    else { if (at < 0) throw new Error("That tile is not here."); if (edit.action === "remove") shown.splice(at, 1); if (edit.action === "move") { const [row] = shown.splice(at, 1); shown.splice(edit.index ?? shown.length, 0, row!); } }
    if (edit.size || edit.c || edit.r) {
      if (layout.kind === "board") throw new Error("Board overview tiles have a fixed size. They can be added, removed and reordered.");
      const tile = shown.find(row => row.key === edit.type); if (tile) { const size = ({ s: [3, 2], m: [6, 3], l: [8, 4], xl: [12, 6] } as Record<string, number[]>)[edit.size ?? ""] ?? [tile.c, tile.r]; Object.assign(tile, clampSize({ c: edit.c ?? size[0]!, r: edit.r ?? size[1]! }, tileLimits(tile))); }
    }
  }
  if (layout.kind === "board" && shown.length > 4) throw new Error("The Board overview holds four tiles. Choose one to remove first.");
  const value = layout.kind === "board" ? { ...layout.raw, tiles: shown.map(row => row.key), ...(input.collapsed !== undefined ? { collapsed: input.collapsed } : {}), ...(input.wipCap !== undefined ? { wipCap: input.wipCap } : {}) } : { v: 1, tiles: shown.map(({ key, c, r }) => ({ key, c, r })), hidden: [...new Set([...layout.hidden, ...layout.shown.filter(tile => !shown.some(row => row.key === tile.key)).map(row => row.key)])].filter(id => !shown.some(row => row.key === id)) };
  if (preview) return { key: layout.key, value };
  const db = ctx.tx!;
  const before = await db.preference.findFirst({ where: { userId: ctx.userId, key: layout.key }, select: { id: true, value: true, updatedAt: true } });
  const priorValue = before?.value ?? layout.raw;
  const row = await db.preference.upsert({ where: { userId_key: { userId: ctx.userId, key: layout.key } }, create: { userId: ctx.userId, key: layout.key, value: priorValue as object, source: "agent" }, update: {} });
  const saved = await db.preference.update({ where: { id: row.id }, data: { value: value as object, deletedAt: null } });
  const op = { op: "update" as const, model: "preference" as const, id: row.id, before: { value: priorValue, updatedAt: row.updatedAt }, after: { value, updatedAt: saved.updatedAt } };
  await recordUndoInTransaction(db, { userId: ctx.userId, actor: "agent", label: `Changed ${layout.kind} tiles`, kind: "update", subject: "layout", inverse: op, forward: op });
  if (layout.kind === "desk") {
    const added = (WORKSPACE_TILES.extras as readonly { id: string; tile: string }[]).filter(extra => shown.some(tile => tile.key === extra.tile) && !layout.extras.includes(extra.id));
    if (added.length) {
      const previous = await db.preference.upsert({ where: { userId_key: { userId: ctx.userId, key: "desk.extras" } }, create: { userId: ctx.userId, key: "desk.extras", value: layout.extras, source: "agent" }, update: {} });
      const updated = await db.preference.update({ where: { id: previous.id }, data: { value: [...layout.extras, ...added.map(extra => extra.id)], deletedAt: null } });
      const extraOp = { op: "update" as const, model: "preference" as const, id: previous.id, before: { value: previous.value, updatedAt: previous.updatedAt }, after: { value: updated.value, updatedAt: updated.updatedAt } };
      await recordUndoInTransaction(db, { userId: ctx.userId, actor: "agent", label: "Enabled the tile's desk extra", kind: "update", subject: "layout", inverse: extraOp, forward: extraOp });
    }
  }
  return { key: layout.key, value };
}
