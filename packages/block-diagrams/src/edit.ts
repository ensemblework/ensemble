import {
  nextEdgeId,
  uniqueId,
  type DiagramModel,
  type PortName,
  type ShapeId,
} from "./model.js";
import { refitGroups } from "./layout.js";
import { nodeSize, textSize } from "./shapes.js";

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

export function renameItem(model: DiagramModel, id: string, label: string): DiagramModel {
  const next = clone(model);
  const trimmed = label.trim();
  if (!trimmed) return model;
  if (next.nodes[id]) {
    const node = { ...next.nodes[id], label: trimmed };
    next.nodes[id] = node;
    const size = nodeSize(node.shape, trimmed);
    const box = next.layout[id];
    if (box) next.layout[id] = { ...box, w: size.w, h: size.h };
  } else if (next.texts[id]) {
    next.texts[id] = { ...next.texts[id], text: trimmed };
    const size = textSize(trimmed);
    const box = next.layout[id];
    if (box) next.layout[id] = { ...box, w: size.w, h: size.h };
  } else if (next.groups[id]) next.groups[id] = { ...next.groups[id], label: trimmed };
  else return model;
  return refitGroups(next);
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
