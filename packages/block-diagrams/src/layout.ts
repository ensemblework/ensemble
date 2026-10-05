import type { DiagramModel, LayoutBox } from "./model.js";
import { nodeSize, textSize } from "./shapes.js";

/**
 * elkjs is EPL-2.0 OR GPL-3.0-or-later. Ensemble uses it unmodified under EPL-2.0.
 * The layered algorithm with LAYER_SWEEP is what "Reorganize" runs.
 */
type ElkNode = {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  layoutOptions?: Record<string, string>;
  children?: ElkNode[];
  edges?: Array<{ id: string; sources: string[]; targets: string[] }>;
};

type ElkInstance = { layout: (graph: ElkNode) => Promise<ElkNode> };

const DIRECTION = { down: "DOWN", up: "UP", left: "LEFT", right: "RIGHT" } as const;

/** Fit vertically is a compact top-down pass. Fit horizontally is a compact left-to-right pass. */
export type LayoutFit = "vertical" | "horizontal";

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

function itemLocked(model: DiagramModel, id: string): boolean {
  const node = model.nodes[id];
  if (node) return node.locked || groupLocked(model, node.group);
  const text = model.texts[id];
  if (text) return text.locked || groupLocked(model, text.group);
  return false;
}

function fallbackSize(model: DiagramModel, id: string): { w: number; h: number } {
  const node = model.nodes[id];
  if (node) return nodeSize(node.shape, node.label);
  const text = model.texts[id];
  if (text) return textSize(text.text);
  return { w: 180, h: 80 };
}

function overlaps(a: LayoutBox, b: LayoutBox, gap: number): boolean {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
}

/** Nudge unlocked blocks off anything they cover. Locked blocks stay put. */
function separateOverlaps(model: DiagramModel, layout: Record<string, LayoutBox>): void {
  const ids = [...Object.keys(model.nodes), ...Object.keys(model.texts)].filter((id) => layout[id]);
  const gap = 8;
  for (let pass = 0; pass < 16; pass += 1) {
    let moved = false;
    for (const id of ids) {
      if (itemLocked(model, id)) continue;
      const box = layout[id]!;
      for (const otherId of ids) {
        if (otherId === id) continue;
        const other = layout[otherId]!;
        if (!overlaps(box, other, gap)) continue;
        const right = other.x + other.w + gap - box.x;
        const down = other.y + other.h + gap - box.y;
        if (right <= down) box.x += right;
        else box.y += down;
        moved = true;
      }
    }
    if (!moved) return;
  }
}

/** Pull group frames around their members. Member positions stay where they are. */
export function refitGroups(model: DiagramModel): DiagramModel {
  const layout: Record<string, LayoutBox> = {};
  for (const [id, box] of Object.entries(model.layout)) layout[id] = { ...box };
  separateOverlaps(model, layout);
  const visit = (id: string) => {
    for (const [childId, child] of Object.entries(model.groups)) {
      if (child.parent === id) visit(childId);
    }
    const boxes: LayoutBox[] = [];
    for (const [nodeId, node] of Object.entries(model.nodes)) {
      if (node.group === id && layout[nodeId]) boxes.push(layout[nodeId]!);
    }
    for (const [textId, text] of Object.entries(model.texts)) {
      if (text.group === id && layout[textId]) boxes.push(layout[textId]!);
    }
    for (const [childId, child] of Object.entries(model.groups)) {
      if (child.parent === id && layout[childId]) boxes.push(layout[childId]!);
    }
    if (!boxes.length) return;
    const padX = 8;
    const padTop = 32;
    const padBottom = 14;
    const minX = Math.min(...boxes.map((box) => box.x)) - padX;
    const minY = Math.min(...boxes.map((box) => box.y)) - padTop;
    const maxX = Math.max(...boxes.map((box) => box.x + box.w)) + padX;
    const maxY = Math.max(...boxes.map((box) => box.y + box.h)) + padBottom;
    layout[id] = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  };
  for (const [id, group] of Object.entries(model.groups)) {
    if (!group.parent) visit(id);
  }
  return { ...model, layout };
}

function gridFallback(model: DiagramModel): DiagramModel {
  const layout: Record<string, LayoutBox> = { ...model.layout };
  const ids = [...Object.keys(model.nodes), ...Object.keys(model.texts)];
  let col = 0;
  let rowHeight = 0;
  let x = 24;
  let y = 24;
  for (const id of ids) {
    const size = layout[id] ?? { ...fallbackSize(model, id), x: 0, y: 0 };
    if (itemLocked(model, id) && model.layout[id]) {
      layout[id] = { ...model.layout[id]! };
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
  return refitGroups({ ...model, layout });
}

/**
 * Lay the diagram out with ELK's layered algorithm and crossing minimisation.
 * Locked blocks, and members of a locked group, keep the position they already have.
 * A fit preset also sets `meta.direction` so the printed `direction` line stays in sync.
 */
export async function layoutDiagram(model: DiagramModel, fit?: LayoutFit): Promise<DiagramModel> {
  const working: DiagramModel = fit
    ? { ...model, meta: { ...model.meta, direction: fit === "horizontal" ? "right" : "down" } }
    : model;
  const ids = [...Object.keys(working.nodes), ...Object.keys(working.texts)];
  if (!ids.length) return refitGroups(working);
  const held = new Map<string, { x: number; y: number }>();
  const children: ElkNode[] = ids.map((id) => {
    const previous = working.layout[id];
    const size = previous ? { w: previous.w, h: previous.h } : fallbackSize(working, id);
    const locked = itemLocked(working, id) && previous;
    if (locked && previous) held.set(id, { x: previous.x, y: previous.y });
    return {
      id,
      width: size.w,
      height: size.h,
      ...(locked && previous ? { x: previous.x, y: previous.y } : {}),
      layoutOptions: locked ? { "org.eclipse.elk.position": "FIXED" } : undefined,
    };
  });
  const edges = Object.entries(working.edges)
    .filter(([, edge]) => working.nodes[edge.from.node] && working.nodes[edge.to.node])
    .map(([id, edge]) => ({ id, sources: [edge.from.node], targets: [edge.to.node] }));
  const elbow = working.meta.curve === "elbow" || Object.values(working.edges).some((edge) => edge.curve === "elbow");
  const spacing = fit === "vertical"
    ? { node: "16", layer: "18" }
    : fit === "horizontal"
      ? { node: "14", layer: "22" }
      : { node: "24", layer: elbow ? "28" : "16" };
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": DIRECTION[working.meta.direction],
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.spacing.nodeNode": spacing.node,
      "elk.layered.spacing.nodeNodeBetweenLayers": spacing.layer,
      "elk.padding": "[top=10,left=10,bottom=10,right=10]",
      "elk.separateConnectedComponents": "true",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      ...(elbow ? { "elk.edgeRouting": "ORTHOGONAL" } : {}),
    },
    children,
    edges,
  };
  try {
    const engine = await elk();
    const laid = await engine.layout(graph);
    const layout: Record<string, LayoutBox> = { ...working.layout };
    for (const child of laid.children ?? []) {
      const keep = held.get(child.id);
      const width = child.width ?? layout[child.id]?.w ?? fallbackSize(working, child.id).w;
      const height = child.height ?? layout[child.id]?.h ?? fallbackSize(working, child.id).h;
      layout[child.id] = {
        x: keep?.x ?? child.x ?? 0,
        y: keep?.y ?? child.y ?? 0,
        w: width,
        h: height,
      };
    }
    return refitGroups({ ...working, layout });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Block diagram layout failed: ${message}`);
    return gridFallback(working);
  }
}
