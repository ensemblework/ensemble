import type { DiagramModel, LayoutBox, TextStyle } from "./model.js";
import { edgeEnds, edgeRoute } from "./route.js";
import { LABEL_SIZE, labelMetrics, nodeSize, textSize } from "./shapes.js";

/**
 * elkjs is EPL-2.0 OR GPL-3.0-or-later. Ensemble uses it unmodified under EPL-2.0.
 * The layered algorithm with LAYER_SWEEP is what "Reorganize" runs. Groups are compound nodes
 * (`INCLUDE_CHILDREN`), so a group's members are laid out inside its frame and sibling frames
 * never cross.
 */
type ElkLabel = { text: string; width: number; height: number; x?: number; y?: number };
type ElkEdge = { id: string; sources: string[]; targets: string[]; labels?: ElkLabel[] };
type ElkNode = {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  layoutOptions?: Record<string, string>;
  children?: ElkNode[];
  edges?: ElkEdge[];
};

type ElkInstance = { layout: (graph: ElkNode) => Promise<ElkNode> };

const DIRECTION = { down: "DOWN", up: "UP", left: "LEFT", right: "RIGHT" } as const;

/** Fit vertically is a compact top-down pass. Fit horizontally is a compact left-to-right pass. */
export type LayoutFit = "vertical" | "horizontal";

/** Room between a group's frame and its members. The title tab sits in `top`. */
export const GROUP_PAD = { x: 16, top: 40, bottom: 16 } as const;

/** A frame is at least as wide as its title tab: 11 px semibold text in a pill, 10 px in from each side. */
export function groupMinWidth(label: string): number {
  return Math.round(Math.max(44, label.trim().length * 6.6 + 18) + 20);
}

/** The pill a line's label is drawn in: one row, 7 px padding each side, a 1 px border. Layout reserves this much room. */
export function edgeLabelSize(label: string, font?: Partial<TextStyle> | null): { w: number; h: number } {
  const metrics = labelMetrics(font, LABEL_SIZE.edge);
  const text = label.replace(/\s+/g, " ").trim();
  return { w: Math.round(Math.max(1, text.length) * metrics.char + 16), h: Math.round(metrics.line + 5) };
}

/** Two boxes closer than this count as touching when layout separates them. */
const TOUCH = 6;
/** The gap layout leaves between two things it had to push apart. */
const GAP = 18;

let elkPromise: Promise<ElkInstance> | null = null;

async function elk(): Promise<ElkInstance> {
  if (!elkPromise) {
    elkPromise = import("elkjs/lib/elk.bundled.js").then((mod) => {
      const exported = mod as unknown as { default?: new () => ElkInstance };
      const Ctor = exported.default ?? (mod as unknown as new () => ElkInstance);
      return new Ctor();
    });
  }
  return elkPromise;
}

function groupLocked(model: DiagramModel, groupId: string | null): boolean {
  const seen = new Set<string>();
  let current = groupId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const group = model.groups[current];
    if (!group) return false;
    if (group.locked) return true;
    current = group.parent;
  }
  return false;
}

/** Locked itself, or inside a locked group (at any depth). Works for blocks, text boxes and groups. */
export function isLocked(model: DiagramModel, id: string): boolean {
  const node = model.nodes[id];
  if (node) return node.locked || groupLocked(model, node.group);
  const text = model.texts[id];
  if (text) return text.locked || groupLocked(model, text.group);
  if (model.groups[id]) return groupLocked(model, id);
  return false;
}

function fallbackSize(model: DiagramModel, id: string): { w: number; h: number } {
  const node = model.nodes[id];
  if (node) return nodeSize(node.shape, node.label, node.font);
  const text = model.texts[id];
  if (text) return textSize(text.text, text.font);
  return { w: 180, h: 80 };
}

/** Which group holds what. Unknown groups and parent cycles count as top level. */
interface Tree {
  items: Map<string | null, string[]>;
  groups: Map<string | null, string[]>;
}

function groupParent(model: DiagramModel, id: string): string | null {
  const parent = model.groups[id]?.parent ?? null;
  if (!parent || !model.groups[parent]) return null;
  const seen = new Set([id]);
  let current: string | null = parent;
  while (current) {
    if (seen.has(current)) return null;
    seen.add(current);
    const next: string | null = model.groups[current]?.parent ?? null;
    current = next && model.groups[next] ? next : null;
  }
  return parent;
}

function treeOf(model: DiagramModel): Tree {
  const items = new Map<string | null, string[]>();
  const groups = new Map<string | null, string[]>();
  const push = (map: Map<string | null, string[]>, key: string | null, id: string) => {
    const list = map.get(key);
    if (list) list.push(id);
    else map.set(key, [id]);
  };
  for (const id of Object.keys(model.groups)) push(groups, groupParent(model, id), id);
  const container = (group: string | null) => (group && model.groups[group] ? group : null);
  for (const [id, node] of Object.entries(model.nodes)) push(items, container(node.group), id);
  for (const [id, text] of Object.entries(model.texts)) push(items, container(text.group), id);
  return { items, groups };
}

function childrenOf(tree: Tree, container: string | null): string[] {
  return [...(tree.items.get(container) ?? []), ...(tree.groups.get(container) ?? [])];
}

/** Every block, text box and group inside a group, at any depth. */
function descendants(tree: Tree, id: string): string[] {
  const out: string[] = [];
  const walk = (group: string) => {
    for (const item of tree.items.get(group) ?? []) out.push(item);
    for (const child of tree.groups.get(group) ?? []) {
      out.push(child);
      walk(child);
    }
  };
  walk(id);
  return out;
}

/** The blocks, text boxes and groups inside a group, at any depth. */
export function groupContents(model: DiagramModel, id: string): string[] {
  return model.groups[id] ? descendants(treeOf(model), id) : [];
}

function fitFrame(model: DiagramModel, layout: Record<string, LayoutBox>, tree: Tree, id: string): void {
  const boxes = childrenOf(tree, id).flatMap((child) => (layout[child] ? [layout[child]!] : []));
  if (!boxes.length) return;
  const minX = Math.min(...boxes.map((box) => box.x)) - GROUP_PAD.x;
  const minY = Math.min(...boxes.map((box) => box.y)) - GROUP_PAD.top;
  const maxX = Math.max(...boxes.map((box) => box.x + box.w)) + GROUP_PAD.x;
  const maxY = Math.max(...boxes.map((box) => box.y + box.h)) + GROUP_PAD.bottom;
  layout[id] = { x: minX, y: minY, w: Math.max(maxX - minX, groupMinWidth(model.groups[id]?.label ?? id)), h: maxY - minY };
}

function fitAll(model: DiagramModel, layout: Record<string, LayoutBox>, tree: Tree): void {
  const visit = (id: string) => {
    for (const child of tree.groups.get(id) ?? []) visit(child);
    fitFrame(model, layout, tree, id);
  };
  for (const id of tree.groups.get(null) ?? []) visit(id);
}

function overlaps(a: LayoutBox, b: LayoutBox, gap: number): boolean {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
}

/**
 * Push apart anything that covers something else at the same level: blocks and text boxes in
 * the same group, and sibling group frames (a frame moves with everything inside it). Deepest
 * groups first, so a frame is final before its parent's level is checked. `pinned` items, and
 * groups that hold one, never move.
 */
function separate(model: DiagramModel, layout: Record<string, LayoutBox>, tree: Tree, pinned: Set<string>): void {
  const flow = model.meta.direction;
  const held = (id: string) => (model.groups[id] ? descendants(tree, id).some((child) => pinned.has(child)) : pinned.has(id));
  const shift = (id: string, dx: number, dy: number) => {
    const ids = model.groups[id] ? [id, ...descendants(tree, id)] : [id];
    for (const each of ids) {
      const box = layout[each];
      if (box) layout[each] = { ...box, x: box.x + dx, y: box.y + dy };
    }
  };
  const along = (box: LayoutBox) =>
    flow === "down" ? [box.y, box.x] : flow === "up" ? [-box.y - box.h, box.x] : flow === "right" ? [box.x, box.y] : [-box.x - box.w, box.y];
  const resolve = (units: string[]) => {
    const order = [...units].sort((a, b) => {
      const [a1, a2] = along(layout[a]!);
      const [b1, b2] = along(layout[b]!);
      return a1! - b1! || a2! - b2!;
    });
    for (let pass = 0; pass < 48; pass += 1) {
      let moved = false;
      for (let i = 0; i < order.length; i += 1) {
        for (let j = i + 1; j < order.length; j += 1) {
          const a = order[i]!;
          const b = order[j]!;
          if (!overlaps(layout[a]!, layout[b]!, TOUCH)) continue;
          const heldA = held(a);
          const heldB = held(b);
          if (heldA && heldB) continue;
          const mover = heldB ? a : b;
          const box = layout[mover]!;
          const other = layout[mover === a ? b : a]!;
          let dx: number;
          let dy: number;
          if (pass < 24) {
            // The shortest way out, away from the other box's centre.
            dx = box.x + box.w / 2 >= other.x + other.w / 2 ? other.x + other.w + GAP - box.x : other.x - GAP - (box.x + box.w);
            dy = box.y + box.h / 2 >= other.y + other.h / 2 ? other.y + other.h + GAP - box.y : other.y - GAP - (box.y + box.h);
          } else {
            // Still stuck: only push right or down, which always ends.
            dx = other.x + other.w + GAP - box.x;
            dy = other.y + other.h + GAP - box.y;
          }
          if (Math.abs(dx) <= Math.abs(dy)) shift(mover, dx, 0);
          else shift(mover, 0, dy);
          moved = true;
        }
      }
      if (!moved) return;
    }
  };
  const visit = (container: string | null) => {
    for (const group of tree.groups.get(container) ?? []) visit(group);
    for (const group of tree.groups.get(container) ?? []) fitFrame(model, layout, tree, group);
    resolve(childrenOf(tree, container).filter((id) => layout[id]));
  };
  visit(null);
  fitAll(model, layout, tree);
}

/**
 * Pairs of things that cover each other: two blocks or text boxes in the same group, or two
 * sibling group frames (a frame covering a block that is not in it shows up as its frame
 * covering the block's own frame, or the block). Frames are measured around their members.
 */
export function layoutOverlaps(model: DiagramModel): Array<[string, string]> {
  const tree = treeOf(model);
  const layout: Record<string, LayoutBox> = { ...model.layout };
  fitAll(model, layout, tree);
  const found: Array<[string, string]> = [];
  const visit = (container: string | null) => {
    const units = childrenOf(tree, container).filter((id) => layout[id]);
    for (let i = 0; i < units.length; i += 1) {
      for (let j = i + 1; j < units.length; j += 1) {
        if (overlaps(layout[units[i]!]!, layout[units[j]!]!, -1)) found.push([units[i]!, units[j]!]);
      }
    }
    for (const group of tree.groups.get(container) ?? []) visit(group);
  };
  visit(null);
  return found;
}

/**
 * A `layout` section that puts blocks or group frames on top of each other is dropped, except the
 * positions of locked items, so the editor lays the diagram out when it opens. A layout with no
 * overlaps comes back unchanged.
 */
export function withoutOverlappingLayout(model: DiagramModel): DiagramModel {
  if (!layoutOverlaps(model).length) return model;
  const layout: Record<string, LayoutBox> = {};
  for (const [id, box] of Object.entries(model.layout)) {
    if ((model.nodes[id] || model.texts[id]) && isLocked(model, id)) layout[id] = { ...box };
  }
  return { ...model, layout };
}

/** Pull group frames around their members. Member positions stay exactly where they are. */
export function refitGroups(model: DiagramModel): DiagramModel {
  const layout: Record<string, LayoutBox> = {};
  for (const [id, box] of Object.entries(model.layout)) layout[id] = { ...box };
  fitAll(model, layout, treeOf(model));
  return { ...model, layout };
}

/**
 * Somewhere near `box` where it covers nothing: no block, text box, or frame it is not in.
 * Used for a block or text box the person adds, so it never lands on top of another.
 */
export function freeSpot(model: DiagramModel, id: string, box: LayoutBox): { x: number; y: number } {
  const tree = treeOf(model);
  const layout: Record<string, LayoutBox> = { ...model.layout };
  fitAll(model, layout, tree);
  const own = new Set<string>();
  let group = model.nodes[id]?.group ?? model.texts[id]?.group ?? null;
  while (group && model.groups[group] && !own.has(group)) {
    own.add(group);
    group = model.groups[group]!.parent;
  }
  const others = Object.entries(layout)
    .filter(([other]) => other !== id && !own.has(other) && (model.nodes[other] || model.texts[other] || model.groups[other]))
    .map(([, other]) => other);
  const clear = (x: number, y: number) => !others.some((other) => overlaps({ ...box, x, y }, other, TOUCH));
  for (let ring = 0; ring < 40; ring += 1) {
    for (let step = 0; step <= ring; step += 1) {
      const x = box.x + step * 48;
      const y = box.y + (ring - step) * 32;
      if (clear(x, y)) return { x, y };
    }
  }
  return { x: box.x, y: box.y };
}

/**
 * A line's label sits at the middle of its route. When that covers a block, a text box, a group's
 * title, or a label already placed, bend the line (the smallest amount that works) so the label
 * lands in a gap. A line with no label, or whose label is already clear, keeps its bend.
 */
function placeEdgeLabels(model: DiagramModel): DiagramModel {
  const obstacles: LayoutBox[] = [];
  for (const id of [...Object.keys(model.nodes), ...Object.keys(model.texts)]) {
    const box = model.layout[id];
    if (box) obstacles.push({ x: box.x - 3, y: box.y - 3, w: box.w + 6, h: box.h + 6 });
  }
  for (const [id, group] of Object.entries(model.groups)) {
    const box = model.layout[id];
    if (!box) continue;
    obstacles.push({ x: box.x + 8, y: box.y + 6, w: Math.min(box.w - 16, groupMinWidth(group.label) - 16), h: 24 });
    // A label on a frame's border reads as part of the frame.
    obstacles.push({ x: box.x, y: box.y - 3, w: box.w, h: 6 }, { x: box.x, y: box.y + box.h - 3, w: box.w, h: 6 });
    obstacles.push({ x: box.x - 3, y: box.y, w: 6, h: box.h }, { x: box.x + box.w - 3, y: box.y, w: 6, h: box.h });
  }
  const placed: LayoutBox[] = [];
  const edges = { ...model.edges };
  let changed = false;
  const steps = [0];
  for (let k = 12; k <= 168; k += 12) steps.push(k, -k);
  for (const [id, edge] of Object.entries(model.edges)) {
    if (!edge.label) continue;
    const from = model.nodes[edge.from.node];
    const to = model.nodes[edge.to.node];
    const fromBox = model.layout[edge.from.node];
    const toBox = model.layout[edge.to.node];
    if (!from || !to || !fromBox || !toBox || edge.from.node === edge.to.node) continue;
    const ends = edgeEnds({ shape: from.shape, box: fromBox, port: edge.from.port }, { shape: to.shape, box: toBox, port: edge.to.port });
    const size = edgeLabelSize(edge.label, edge.font);
    const labelAt = (bend: number) => {
      const route = edgeRoute({ ...ends, curve: edge.curve, bend, width: edge.width, head: edge.head, arrows: edge.arrow });
      return { box: { x: route.label.x - size.w / 2, y: route.label.y - size.h / 2, w: size.w, h: size.h }, bendable: route.bendable };
    };
    const clear = (box: LayoutBox) => !obstacles.some((other) => overlaps(box, other, 0)) && !placed.some((other) => overlaps(box, other, 2));
    const current = edge.bend ?? 0;
    const start = labelAt(current);
    let pick = current;
    if (!clear(start.box) && start.bendable) {
      for (const step of steps) {
        if (step === current) continue;
        if (clear(labelAt(step).box)) {
          pick = step;
          break;
        }
      }
    }
    placed.push(labelAt(pick).box);
    if (pick !== current) {
      const next = { ...edge };
      if (pick) next.bend = pick;
      else delete next.bend;
      edges[id] = next;
      changed = true;
    }
  }
  return changed ? { ...model, edges } : model;
}

function gridFallback(model: DiagramModel): DiagramModel {
  const layout: Record<string, LayoutBox> = { ...model.layout };
  const pinned = new Set<string>();
  const ids = [...Object.keys(model.nodes), ...Object.keys(model.texts)];
  let col = 0;
  let rowHeight = 0;
  let x = 24;
  let y = 24;
  for (const id of ids) {
    const size = layout[id] ?? { ...fallbackSize(model, id), x: 0, y: 0 };
    if (isLocked(model, id) && model.layout[id]) {
      layout[id] = { ...model.layout[id]! };
      pinned.add(id);
      continue;
    }
    const box = { x, y, w: size.w, h: size.h };
    layout[id] = box;
    rowHeight = Math.max(rowHeight, box.h);
    x += box.w + 56;
    col += 1;
    if (col >= 3) {
      col = 0;
      y += rowHeight + 48;
      x = 24;
      rowHeight = 0;
    }
  }
  separate(model, layout, treeOf(model), pinned);
  return { ...model, layout };
}

/**
 * Lay the diagram out with ELK's layered algorithm and crossing minimisation. Groups are laid out
 * as frames around their members, nested groups inside their parent, and line labels get room
 * between layers. Locked blocks, and members of a locked group, keep the position they already
 * have: the rest of the layout is shifted so the first of them stays put, then anything that
 * still covers something is pushed apart. A fit preset also sets `meta.direction` so the printed
 * `direction` line stays in sync.
 */
export async function layoutDiagram(model: DiagramModel, fit?: LayoutFit): Promise<DiagramModel> {
  const working: DiagramModel = fit
    ? { ...model, meta: { ...model.meta, direction: fit === "horizontal" ? "right" : "down" } }
    : model;
  const ids = [...Object.keys(working.nodes), ...Object.keys(working.texts)];
  if (!ids.length) return refitGroups(working);
  const tree = treeOf(working);
  const held = new Map<string, LayoutBox>();
  for (const id of ids) {
    const previous = working.layout[id];
    if (previous && isLocked(working, id)) held.set(id, { ...previous });
  }
  const sizeOf = (id: string) => {
    const previous = working.layout[id];
    return previous ? { w: previous.w, h: previous.h } : fallbackSize(working, id);
  };
  const elbow = working.meta.curve === "elbow" || Object.values(working.edges).some((edge) => edge.curve === "elbow");
  const spacing = fit === "vertical"
    ? { node: 24, layer: 32 }
    : fit === "horizontal"
      ? { node: 22, layer: 36 }
      : { node: 32, layer: elbow ? 44 : 40 };
  const shared: Record<string, string> = {
    "elk.direction": DIRECTION[working.meta.direction],
    "elk.spacing.nodeNode": String(spacing.node),
    "elk.layered.spacing.nodeNodeBetweenLayers": String(spacing.layer),
    "elk.spacing.edgeNode": "14",
    "elk.spacing.edgeEdge": "10",
    "elk.layered.spacing.edgeNodeBetweenLayers": "14",
    "elk.spacing.edgeLabel": "4",
    "elk.edgeLabels.placement": "CENTER",
    "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
    // A loop is broken at its edge back to a block already on the path from the start.
    "elk.layered.cycleBreaking.strategy": "DEPTH_FIRST",
  };
  const leaf = (id: string): ElkNode => {
    const size = sizeOf(id);
    return { id, width: size.w, height: size.h };
  };
  const compound = (id: string): ElkNode | null => {
    const children = [
      ...(tree.groups.get(id) ?? []).map(compound).filter((child): child is ElkNode => child !== null),
      ...(tree.items.get(id) ?? []).map(leaf),
    ];
    if (!children.length) return null;
    return {
      id,
      layoutOptions: {
        ...shared,
        "elk.padding": `[top=${GROUP_PAD.top},left=${GROUP_PAD.x},bottom=${GROUP_PAD.bottom},right=${GROUP_PAD.x}]`,
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": `(${groupMinWidth(working.groups[id]?.label ?? id)}, 40)`,
      },
      children,
    };
  };
  const edges: ElkEdge[] = Object.entries(working.edges)
    .filter(([, edge]) => working.nodes[edge.from.node] && working.nodes[edge.to.node] && edge.from.node !== edge.to.node)
    .map(([id, edge]) => {
      const label = edge.label.trim();
      const size = label ? edgeLabelSize(label, edge.font) : null;
      return {
        id: `edge:${id}`,
        sources: [edge.from.node],
        targets: [edge.to.node],
        ...(size ? { labels: [{ text: label, width: size.w, height: size.h }] } : {}),
      };
    });
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      ...shared,
      "elk.algorithm": "layered",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      // Only on the root: ELK fails when a compound node carries it.
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.json.shapeCoords": "ROOT",
      "elk.json.edgeCoords": "ROOT",
      "elk.padding": "[top=24,left=24,bottom=24,right=24]",
      ...(elbow ? { "elk.edgeRouting": "ORTHOGONAL" } : {}),
    },
    children: [
      ...(tree.groups.get(null) ?? []).map(compound).filter((child): child is ElkNode => child !== null),
      ...(tree.items.get(null) ?? []).map(leaf),
    ],
    edges,
  };
  try {
    const engine = await elk();
    const laid = await engine.layout(graph);
    const placed: Record<string, LayoutBox> = {};
    const collect = (node: ElkNode) => {
      for (const child of node.children ?? []) {
        if (working.nodes[child.id] || working.texts[child.id]) {
          const size = sizeOf(child.id);
          placed[child.id] = { x: Math.round(child.x ?? 0), y: Math.round(child.y ?? 0), w: size.w, h: size.h };
        }
        collect(child);
      }
    };
    collect(laid);
    const anchor = [...held.keys()].find((id) => placed[id]);
    const dx = anchor ? held.get(anchor)!.x - placed[anchor]!.x : 0;
    const dy = anchor ? held.get(anchor)!.y - placed[anchor]!.y : 0;
    const layout: Record<string, LayoutBox> = { ...working.layout };
    for (const [id, box] of Object.entries(placed)) layout[id] = held.get(id) ?? { ...box, x: box.x + dx, y: box.y + dy };
    separate(working, layout, tree, new Set(held.keys()));
    return placeEdgeLabels({ ...working, layout });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Block diagram layout failed: ${message}`);
    return gridFallback(working);
  }
}
