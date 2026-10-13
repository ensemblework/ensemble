import { z } from "zod";

/** CSS pixels. The editor refuses to open below this window size. */
export const MIN_VIEWPORT = { width: 1024, height: 640 } as const;

export const DIAGRAM_VERSION = 1 as const;

export const PORTS = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;
export type PortName = (typeof PORTS)[number];

export const SHAPE_IDS = [
  "rectangle",
  "rounded",
  "diamond",
  "circle",
  "ellipse",
  "cylinder",
  "server",
  "triangle",
  "parallelogram",
  "document",
  "cloud",
  "actor",
  "hexagon",
  "note",
  "trapezoid",
  "queue",
  "subroutine",
  "browser",
  "delay",
] as const;
export type ShapeId = (typeof SHAPE_IDS)[number];

export const DIRECTIONS = ["down", "up", "left", "right"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** How a connector is drawn. `elbow` is an orthogonal (right-angle) path. */
export const CURVES = ["straight", "curved", "elbow"] as const;
export type Curve = (typeof CURVES)[number];

export const COLORS = [
  "slate",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "indigo",
  "purple",
  "pink",
] as const;
export type PaletteColor = (typeof COLORS)[number];

/**
 * Size and emphasis of a label: a block's, a text box's or a line's. `size` null is the default
 * for that kind of text (13 px in blocks, 12.5 in text boxes, 11 on lines).
 */
export interface TextStyle {
  size: number | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

export const PLAIN_TEXT: TextStyle = { size: null, bold: false, italic: false, underline: false };
export const FONT_LIMITS = { min: 8, max: 48 } as const;
/** Line stroke width and arrowhead length, in px. */
export const LINE_WIDTH = { min: 0.5, max: 8, default: 1.5 } as const;
export const ARROW_HEAD = { min: 6, max: 40, default: 10 } as const;

export function textStyle(style: Partial<TextStyle> | null | undefined): TextStyle {
  return { ...PLAIN_TEXT, ...(style ?? {}) };
}

export function isPlainText(style: Partial<TextStyle> | null | undefined): boolean {
  const full = textStyle(style);
  return full.size == null && !full.bold && !full.italic && !full.underline;
}

/** A one-click edit that addresses a diagnostic. Offsets are into the source text. */
export interface DiagnosticFix {
  title: string;
  from: number;
  to: number;
  insert: string;
}

export interface Diagnostic {
  /** 1-based line number in the source text. */
  line: number;
  severity: "error" | "warning" | "info";
  message: string;
  /** 0-based start offset. Underline this range in the editor. */
  from?: number;
  /** 0-based end offset, exclusive. */
  to?: number;
  /** Block, group, or text id this problem is about. */
  target?: string;
  fixes?: DiagnosticFix[];
}

/** A block. The id is the key in `DiagramModel.nodes`, not a field, so the map can become a Y.Map later. */
export interface DiagramNode {
  label: string;
  shape: ShapeId;
  /** Palette name or a `#rgb` / `#rrggbb` color. Null uses the shape's default colour. */
  color: string | null;
  group: string | null;
  locked: boolean;
  /** Label size and emphasis. Absent is plain. */
  font?: TextStyle;
}

export interface DiagramGroup {
  label: string;
  parent: string | null;
  locked: boolean;
}

export interface DiagramEndpoint {
  node: string;
  port: PortName | null;
}

export interface DiagramEdge {
  from: DiagramEndpoint;
  to: DiagramEndpoint;
  label: string;
  line: "solid" | "dashed";
  arrow: { start: "none" | "arrow"; end: "none" | "arrow" };
  /** Resolved curve. An edge inherits the diagram default unless it names its own. */
  curve: Curve;
  /** Stroke width in px. Absent is LINE_WIDTH.default. */
  width?: number | null;
  /** Arrowhead length in px. Absent is ARROW_HEAD.default. */
  head?: number | null;
  /**
   * How far the line's middle is pulled sideways, in px: perpendicular to a straight or curved
   * line, or the middle run of an elbow. It moves with the blocks. 0 or absent is not bent.
   */
  bend?: number;
  font?: TextStyle;
}

/** A floating text box, not a shaped block. */
export interface DiagramText {
  text: string;
  group: string | null;
  locked: boolean;
  font?: TextStyle;
}

export interface LayoutBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Versioned diagram document.
 * Nodes, groups, edges, texts, and layout are maps keyed by stable ids.
 */
export interface DiagramModel {
  version: typeof DIAGRAM_VERSION;
  meta: { title: string; direction: Direction; curve: Curve };
  nodes: Record<string, DiagramNode>;
  groups: Record<string, DiagramGroup>;
  edges: Record<string, DiagramEdge>;
  texts: Record<string, DiagramText>;
  layout: Record<string, LayoutBox>;
}

export interface ParseResult {
  model: DiagramModel;
  diagnostics: Diagnostic[];
}

const PortSchema = z.enum(PORTS);
const ShapeSchema = z.enum(SHAPE_IDS);
const TextStyleSchema = z.object({ size: z.number().nullable(), bold: z.boolean(), italic: z.boolean(), underline: z.boolean() });

export const diagramModelSchema = z.object({
  version: z.literal(1),
  meta: z.object({
    title: z.string(),
    direction: z.enum(DIRECTIONS),
    curve: z.enum(CURVES).default("straight"),
  }),
  nodes: z.record(
    z.string(),
    z.object({
      label: z.string(),
      shape: ShapeSchema,
      color: z.string().nullable(),
      group: z.string().nullable(),
      locked: z.boolean(),
      font: TextStyleSchema.optional(),
    }),
  ),
  groups: z.record(
    z.string(),
    z.object({
      label: z.string(),
      parent: z.string().nullable(),
      locked: z.boolean(),
    }),
  ),
  edges: z.record(
    z.string(),
    z.object({
      from: z.object({ node: z.string(), port: PortSchema.nullable() }),
      to: z.object({ node: z.string(), port: PortSchema.nullable() }),
      label: z.string(),
      line: z.enum(["solid", "dashed"]),
      arrow: z.object({ start: z.enum(["none", "arrow"]), end: z.enum(["none", "arrow"]) }),
      curve: z.enum(CURVES).default("straight"),
      width: z.number().nullable().optional(),
      head: z.number().nullable().optional(),
      bend: z.number().optional(),
      font: TextStyleSchema.optional(),
    }),
  ),
  texts: z.record(
    z.string(),
    z.object({
      text: z.string(),
      group: z.string().nullable(),
      locked: z.boolean(),
      font: TextStyleSchema.optional(),
    }),
  ),
  layout: z.record(
    z.string(),
    z.object({
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
    }),
  ),
});

export function emptyModel(): DiagramModel {
  return {
    version: 1,
    meta: { title: "", direction: "down", curve: "straight" },
    nodes: {},
    groups: {},
    edges: {},
    texts: {},
    layout: {},
  };
}

export const STARTER_SOURCE = `title Untitled diagram
direction down

node start "Start" shape circle
node next "Next step" shape rectangle

edge start > next
`;

export function slugId(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return "block";
  return /^[0-9]/.test(slug) ? `n${slug}` : slug;
}

export function uniqueId(used: Iterable<string>, base: string): string {
  const taken = new Set(Array.from(used, (id) => id.toLowerCase()));
  const root = slugId(base);
  if (!taken.has(root)) return root;
  let n = 2;
  while (taken.has(`${root}-${n}`)) n += 1;
  return `${root}-${n}`;
}

export function allIds(model: DiagramModel): string[] {
  return [...Object.keys(model.nodes), ...Object.keys(model.groups), ...Object.keys(model.texts)];
}

export function nextEdgeId(model: DiagramModel): string {
  let n = 1;
  while (model.edges[`e${n}`]) n += 1;
  return `e${n}`;
}

/** The line already joining two blocks, in either direction. There is at most one per pair. */
export function edgeBetween(model: DiagramModel, a: string, b: string): string | null {
  for (const [id, edge] of Object.entries(model.edges)) {
    if ((edge.from.node === a && edge.to.node === b) || (edge.from.node === b && edge.to.node === a)) return id;
  }
  return null;
}

/**
 * Folds a second line between the same two blocks into the first: one connection per pair.
 * A line the other way round adds the arrowhead it points with, so `a > b` and `b > a` become
 * one two-way arrow. Different labels are kept, joined with " / ".
 */
export function mergeEdgeInto(kept: DiagramEdge, extra: DiagramEdge): void {
  const reversed = kept.from.node === extra.to.node && kept.to.node === extra.from.node && kept.from.node !== kept.to.node;
  const atFrom = reversed ? extra.arrow.end : extra.arrow.start;
  const atTo = reversed ? extra.arrow.start : extra.arrow.end;
  if (atFrom === "arrow") kept.arrow.start = "arrow";
  if (atTo === "arrow") kept.arrow.end = "arrow";
  if (extra.label && extra.label !== kept.label) kept.label = kept.label ? `${kept.label} / ${extra.label}` : extra.label;
}

/** Case-insensitive id match, then case-insensitive label match. First label win. */
export function lookupId(model: DiagramModel, ref: string): { id: string; ambiguous: boolean } | null {
  const needle = ref.trim().toLowerCase();
  if (!needle) return null;
  for (const id of allIds(model)) {
    if (id.toLowerCase() === needle) return { id, ambiguous: false };
  }
  const labelHits: string[] = [];
  for (const [id, node] of Object.entries(model.nodes)) {
    if (node.label.toLowerCase() === needle) labelHits.push(id);
  }
  for (const [id, text] of Object.entries(model.texts)) {
    if (text.text.toLowerCase() === needle) labelHits.push(id);
  }
  for (const [id, group] of Object.entries(model.groups)) {
    if (group.label.toLowerCase() === needle) labelHits.push(id);
  }
  if (!labelHits.length) return null;
  return { id: labelHits[0]!, ambiguous: labelHits.length > 1 };
}
