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
}

/** A floating text box, not a shaped block. */
export interface DiagramText {
  text: string;
  group: string | null;
  locked: boolean;
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
    }),
  ),
  texts: z.record(
    z.string(),
    z.object({
      text: z.string(),
      group: z.string().nullable(),
      locked: z.boolean(),
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
