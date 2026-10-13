import {
  ARROW_HEAD,
  FONT_LIMITS,
  LINE_WIDTH,
  edgeBetween,
  isPlainText,
  nextEdgeId,
  textStyle,
  uniqueId,
  type Curve,
  type DiagramModel,
  type LayoutBox,
  type PortName,
  type ShapeId,
  type TextStyle,
} from "./model.js";
import { refitGroups } from "./layout.js";
import { minNodeSize, minTextSize, nodeSize, textSize } from "./shapes.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function setTitle(model: DiagramModel, title: string): DiagramModel {
  const next = clone(model);
  next.meta.title = title;
  return next;
}

export function addBlock(model: DiagramModel, shape: ShapeId, at: { x: number; y: number }, label?: string): DiagramModel {
  const next = clone(model);
  const name = label?.trim() || "New block";
  const id = uniqueId([...Object.keys(next.nodes), ...Object.keys(next.groups), ...Object.keys(next.texts)], shape === "rectangle" ? "block" : shape);
  const size = nodeSize(shape, name);
  next.nodes[id] = { label: name, shape, color: null, group: null, locked: false };
  next.layout[id] = { x: at.x, y: at.y, w: size.w, h: size.h };
  return refitGroups(next);
}

export function addTextBox(model: DiagramModel, at: { x: number; y: number }, text = "Note"): DiagramModel {
  const next = clone(model);
  const id = uniqueId([...Object.keys(next.nodes), ...Object.keys(next.groups), ...Object.keys(next.texts)], "note");
  const size = textSize(text);
  next.texts[id] = { text, group: null, locked: false };
  next.layout[id] = { x: at.x, y: at.y, w: size.w, h: size.h };
  return refitGroups(next);
}

export function connectBlocks(
  model: DiagramModel,
  from: { node: string; port: PortName | null },
  to: { node: string; port: PortName | null },
): DiagramModel | null {
  if (!model.nodes[from.node] || !model.nodes[to.node] || from.node === to.node) return null;
  // Two blocks have one line between them. Change that line instead of drawing another.
  if (edgeBetween(model, from.node, to.node)) return null;
  const next = clone(model);
  const id = nextEdgeId(next);
  next.edges[id] = {
    from: { node: from.node, port: from.port },
    to: { node: to.node, port: to.port },
    label: "",
    line: "solid",
    arrow: { start: "none", end: "arrow" },
    curve: model.meta.curve,
  };
  return next;
}

export function moveItem(model: DiagramModel, id: string, x: number, y: number): DiagramModel {
  if (model.nodes[id]?.locked || model.texts[id]?.locked) return model;
  const next = clone(model);
  const current = next.layout[id];
  if (!current) return model;
  next.layout[id] = { ...current, x, y };
  return refitGroups(next);
}

/** Several items dragged together. Locked ones stay. */
export function moveItems(model: DiagramModel, moves: Array<{ id: string; x: number; y: number }>): DiagramModel {
  const next = clone(model);
  let moved = false;
  for (const { id, x, y } of moves) {
    if (next.nodes[id]?.locked || next.texts[id]?.locked) continue;
    const current = next.layout[id];
    if (!current || (current.x === x && current.y === y)) continue;
    next.layout[id] = { ...current, x, y };
    moved = true;
  }
  return moved ? refitGroups(next) : model;
}

/** The smallest box an item may have: its text must still fit (shapes.ts `minNodeSize`). */
export function minItemSize(model: DiagramModel, id: string, width?: number): { w: number; h: number } {
  const node = model.nodes[id];
  if (node) return minNodeSize(node.shape, node.label, node.font);
  const text = model.texts[id];
  if (text) return minTextSize(text.text, text.font, width);
  return { w: 24, h: 24 };
}

/**
 * Keeps a box the person sized unless its text no longer fits, then grows it to the size a new
 * block with that text would get.
 */
function fitText(model: DiagramModel, id: string): void {
  const box = model.layout[id];
  if (!box) return;
  const min = minItemSize(model, id, box.w);
  if (box.w >= min.w && box.h >= min.h) return;
  const node = model.nodes[id];
  const text = model.texts[id];
  const natural = node ? nodeSize(node.shape, node.label, node.font) : text ? textSize(text.text, text.font) : min;
  model.layout[id] = { ...box, w: Math.max(box.w, natural.w, min.w), h: Math.max(box.h, natural.h, min.h) };
}

/** A block or text box resized on the canvas. It never goes below the size its text needs. */
export function resizeItem(model: DiagramModel, id: string, box: LayoutBox): DiagramModel {
  if (model.nodes[id]?.locked || model.texts[id]?.locked || !model.layout[id]) return model;
  const min = minItemSize(model, id, box.w);
  let w = Math.max(min.w, Math.round(box.w));
  let h = Math.max(min.h, Math.round(box.h));
  if (model.nodes[id]?.shape === "circle") w = h = Math.max(w, h);
  const next = clone(model);
  next.layout[id] = { x: Math.round(box.x), y: Math.round(box.y), w, h };
  return refitGroups(next);
}

export function renameItem(model: DiagramModel, id: string, label: string): DiagramModel {
  const next = clone(model);
  const trimmed = label.trim();
  if (!trimmed) return model;
  if (next.nodes[id]) {
    next.nodes[id] = { ...next.nodes[id], label: trimmed };
    fitText(next, id);
  } else if (next.texts[id]) {
    next.texts[id] = { ...next.texts[id], text: trimmed };
    fitText(next, id);
  } else if (next.groups[id]) next.groups[id] = { ...next.groups[id], label: trimmed };
  else return model;
  return refitGroups(next);
}

/** Size, bold, italic or underline for the text of blocks, text boxes and lines. Blocks grow if the text no longer fits. */
export function setTextStyle(model: DiagramModel, ids: string[], edgeIds: string[], patch: Partial<TextStyle>): DiagramModel {
  const next = clone(model);
  const apply = (current: TextStyle | undefined): TextStyle | undefined => {
    const style = textStyle({ ...current, ...patch });
    if (style.size != null) style.size = Math.min(FONT_LIMITS.max, Math.max(FONT_LIMITS.min, Math.round(style.size * 2) / 2));
    return isPlainText(style) ? undefined : style;
  };
  let changed = false;
  for (const id of ids) {
    const item = next.nodes[id] ?? next.texts[id];
    if (!item) continue;
    const font = apply(item.font);
    if (font) item.font = font;
    else delete item.font;
    fitText(next, id);
    changed = true;
  }
  for (const id of edgeIds) {
    const edge = next.edges[id];
    if (!edge) continue;
    const font = apply(edge.font);
    if (font) edge.font = font;
    else delete edge.font;
    changed = true;
  }
  return changed ? refitGroups(next) : model;
}

/** A palette name, a hex colour, or null for the shape's own colour. */
export function setColor(model: DiagramModel, ids: string[], color: string | null): DiagramModel {
  const next = clone(model);
  let changed = false;
  for (const id of ids) {
    const node = next.nodes[id];
    if (!node || node.color === color) continue;
    node.color = color;
    changed = true;
  }
  return changed ? next : model;
}

export interface EdgeLook {
  label?: string;
  curve?: Curve;
  line?: "solid" | "dashed";
  arrow?: { start: "none" | "arrow"; end: "none" | "arrow" };
  width?: number | null;
  head?: number | null;
  bend?: number;
}

/** Change lines: label, curve, dash, arrowheads, width, head size, bend. Null width or head is the default. */
export function setEdgeLook(model: DiagramModel, edgeIds: string[], look: EdgeLook): DiagramModel {
  const next = clone(model);
  let changed = false;
  for (const id of edgeIds) {
    const edge = next.edges[id];
    if (!edge) continue;
    if (look.label !== undefined) edge.label = look.label.trim();
    if (look.curve) {
      if (edge.curve !== look.curve) edge.bend = 0;
      edge.curve = look.curve;
    }
    if (look.line) edge.line = look.line;
    if (look.arrow) edge.arrow = { ...look.arrow };
    if (look.width !== undefined) {
      if (look.width == null || Math.abs(look.width - LINE_WIDTH.default) < 0.01) delete edge.width;
      else edge.width = Math.min(LINE_WIDTH.max, Math.max(LINE_WIDTH.min, Math.round(look.width * 4) / 4));
    }
    if (look.head !== undefined) {
      if (look.head == null || look.head === ARROW_HEAD.default) delete edge.head;
      else edge.head = Math.min(ARROW_HEAD.max, Math.max(ARROW_HEAD.min, Math.round(look.head)));
    }
    if (look.bend !== undefined) {
      if (look.bend) edge.bend = Math.round(look.bend);
      else delete edge.bend;
    }
    if (!edge.bend) delete edge.bend;
    changed = true;
  }
  return changed ? next : model;
}

export type AlignMode = "left" | "center" | "right" | "top" | "middle" | "bottom";

/** Line the boxes up on one edge or centre, like the align buttons in drawing tools. Locked items stay. */
export function alignItems(model: DiagramModel, ids: string[], mode: AlignMode): DiagramModel {
  const boxes = ids.filter((id) => model.layout[id] && (model.nodes[id] || model.texts[id]));
  if (boxes.length < 2) return model;
  const all = boxes.map((id) => model.layout[id]!);
  const left = Math.min(...all.map((box) => box.x));
  const right = Math.max(...all.map((box) => box.x + box.w));
  const top = Math.min(...all.map((box) => box.y));
  const bottom = Math.max(...all.map((box) => box.y + box.h));
  const moves = boxes.map((id) => {
    const box = model.layout[id]!;
    const x = mode === "left" ? left : mode === "right" ? right - box.w : mode === "center" ? (left + right) / 2 - box.w / 2 : box.x;
    const y = mode === "top" ? top : mode === "bottom" ? bottom - box.h : mode === "middle" ? (top + bottom) / 2 - box.h / 2 : box.y;
    return { id, x: Math.round(x), y: Math.round(y) };
  });
  return moveItems(model, moves);
}

/** Even gaps between three or more boxes, keeping the first and last where they are. */
export function distributeItems(model: DiagramModel, ids: string[], axis: "horizontal" | "vertical"): DiagramModel {
  const boxes = ids
    .filter((id) => model.layout[id] && (model.nodes[id] || model.texts[id]))
    .map((id) => ({ id, box: model.layout[id]! }))
    .sort((a, b) => (axis === "horizontal" ? a.box.x - b.box.x : a.box.y - b.box.y));
  if (boxes.length < 3) return model;
  const size = (box: LayoutBox) => (axis === "horizontal" ? box.w : box.h);
  const startOf = (box: LayoutBox) => (axis === "horizontal" ? box.x : box.y);
  const first = boxes[0]!.box;
  const last = boxes[boxes.length - 1]!.box;
  const span = startOf(last) + size(last) - startOf(first);
  const gap = (span - boxes.reduce((sum, item) => sum + size(item.box), 0)) / (boxes.length - 1);
  let cursor = startOf(first);
  const moves = boxes.map(({ id, box }) => {
    const at = Math.round(cursor);
    cursor += size(box) + gap;
    return axis === "horizontal" ? { id, x: at, y: box.y } : { id, x: box.x, y: at };
  });
  return moveItems(model, moves);
}

/** Lock every id that is not locked. If they are all locked, unlock them. */
export function toggleLock(model: DiagramModel, ids: string[]): DiagramModel {
  const next = clone(model);
  const owners = ids.filter((id) => next.nodes[id] || next.texts[id] || next.groups[id]);
  if (!owners.length) return model;
  const allLocked = owners.every((id) => next.nodes[id]?.locked || next.texts[id]?.locked || next.groups[id]?.locked);
  for (const id of owners) {
    if (next.nodes[id]) next.nodes[id] = { ...next.nodes[id], locked: !allLocked };
    if (next.texts[id]) next.texts[id] = { ...next.texts[id], locked: !allLocked };
    if (next.groups[id]) next.groups[id] = { ...next.groups[id], locked: !allLocked };
  }
  return next;
}

export function removeItems(model: DiagramModel, ids: string[]): DiagramModel {
  const next = clone(model);
  const drop = new Set(ids);
  for (const id of ids) {
    const group = next.groups[id];
    if (!group) continue;
    for (const node of Object.values(next.nodes)) {
      if (node.group === id) node.group = group.parent;
    }
    for (const text of Object.values(next.texts)) {
      if (text.group === id) text.group = group.parent;
    }
    for (const child of Object.values(next.groups)) {
      if (child.parent === id) child.parent = group.parent;
    }
  }
  for (const id of drop) {
    delete next.nodes[id];
    delete next.texts[id];
    delete next.groups[id];
    delete next.layout[id];
  }
  for (const [edgeId, edge] of Object.entries(next.edges)) {
    if (drop.has(edge.from.node) || drop.has(edge.to.node)) delete next.edges[edgeId];
  }
  return refitGroups(next);
}
