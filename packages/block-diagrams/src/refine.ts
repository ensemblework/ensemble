import { errorCount, parseDiagram } from "./parse.js";
import { printDiagram } from "./print.js";
import {
  COLORS,
  CURVES,
  SHAPE_IDS,
  lookupId,
  nextEdgeId,
  uniqueId,
  type Curve,
  type DiagramModel,
  type ShapeId,
} from "./model.js";

export type DiagramOp =
  | { op: "add_node"; id?: string; label: string; shape?: ShapeId; color?: string | null; group?: string | null }
  | { op: "remove_node"; id: string }
  | { op: "rename_node"; id: string; label: string }
  | { op: "add_edge"; from: string; to: string; label?: string; curve?: Curve }
  | { op: "remove_edge"; id?: string; from?: string; to?: string }
  | { op: "move_to_group"; id: string; group: string | null }
  | { op: "set_node"; id: string; shape?: ShapeId; color?: string | null }
  | { op: "set_curve"; curve: Curve; edge?: string }
  | { op: "patch"; find: string; replace: string };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function requireNode(model: DiagramModel, ref: string): string {
  const found = lookupId(model, ref);
  if (!found || !model.nodes[found.id]) throw new Error(`No block named “${ref}”.`);
  if (found.ambiguous) throw new Error(`“${ref}” matches more than one block. Use the id.`);
  return found.id;
}

function colorOk(color: string): boolean {
  return (COLORS as readonly string[]).includes(color) || /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color);
}

/** Locks and positions survive a text patch. A locked block stays locked. */
function restoreGuards(previous: DiagramModel, next: DiagramModel): DiagramModel {
  const model = clone(next);
  for (const [id, node] of Object.entries(model.nodes)) {
    if (previous.nodes[id]?.locked) node.locked = true;
    if (previous.layout[id] && !model.layout[id]) model.layout[id] = previous.layout[id]!;
  }
  for (const [id, group] of Object.entries(model.groups)) {
    if (previous.groups[id]?.locked) group.locked = true;
    if (previous.layout[id] && !model.layout[id]) model.layout[id] = previous.layout[id]!;
  }
  for (const [id, text] of Object.entries(model.texts)) {
    if (previous.texts[id]?.locked) text.locked = true;
    if (previous.layout[id] && !model.layout[id]) model.layout[id] = previous.layout[id]!;
  }
  return model;
}

function applyOp(model: DiagramModel, op: Exclude<DiagramOp, { op: "patch" }>): DiagramModel {
  const next = clone(model);
  if (op.op === "add_node") {
    const label = op.label.trim();
    if (!label) throw new Error("A block needs a label.");
    const shape = op.shape ?? "rectangle";
    if (!(SHAPE_IDS as readonly string[]).includes(shape)) throw new Error(`Unknown shape “${shape}”.`);
    if (op.color && !colorOk(op.color)) throw new Error(`Unknown colour “${op.color}”.`);
    const id = op.id?.trim()
      ? uniqueId([...Object.keys(next.nodes), ...Object.keys(next.groups), ...Object.keys(next.texts)], op.id)
      : uniqueId([...Object.keys(next.nodes), ...Object.keys(next.groups), ...Object.keys(next.texts)], label);
    if (op.group && !next.groups[op.group]) throw new Error(`No group “${op.group}”.`);
    next.nodes[id] = { label, shape, color: op.color ?? null, group: op.group ?? null, locked: false };
    return next;
  }
  if (op.op === "remove_node") {
    const id = requireNode(next, op.id);
    if (next.nodes[id]?.locked) throw new Error(`“${next.nodes[id]!.label}” is locked.`);
    delete next.nodes[id];
    delete next.layout[id];
    for (const [edgeId, edge] of Object.entries(next.edges)) {
      if (edge.from.node === id || edge.to.node === id) delete next.edges[edgeId];
    }
    return next;
  }
  if (op.op === "rename_node") {
    const id = requireNode(next, op.id);
    const label = op.label.trim();
    if (!label) throw new Error("A block needs a label.");
    next.nodes[id]!.label = label;
    return next;
  }
  if (op.op === "add_edge") {
    const from = requireNode(next, op.from);
    const to = requireNode(next, op.to);
    if (op.curve && !(CURVES as readonly string[]).includes(op.curve)) throw new Error(`Unknown curve “${op.curve}”.`);
    const id = nextEdgeId(next);
    next.edges[id] = {
      from: { node: from, port: null },
      to: { node: to, port: null },
      label: op.label?.trim() ?? "",
      line: "solid",
      arrow: { start: "none", end: "arrow" },
      curve: op.curve ?? next.meta.curve,
    };
    return next;
  }
  if (op.op === "remove_edge") {
    if (op.id && next.edges[op.id]) {
      delete next.edges[op.id];
      return next;
    }
    const from = op.from ? requireNode(next, op.from) : null;
    const to = op.to ? requireNode(next, op.to) : null;
    const hits = Object.entries(next.edges).filter(([, edge]) => (!from || edge.from.node === from) && (!to || edge.to.node === to));
    if (hits.length !== 1) throw new Error(hits.length ? "That arrow is not unique. Pass its id." : "No arrow matches.");
    delete next.edges[hits[0]![0]];
    return next;
  }
  if (op.op === "move_to_group") {
    const id = requireNode(next, op.id);
    if (next.nodes[id]?.locked) throw new Error(`“${next.nodes[id]!.label}” is locked.`);
    if (op.group && !next.groups[op.group]) throw new Error(`No group “${op.group}”.`);
    next.nodes[id]!.group = op.group;
    return next;
  }
  if (op.op === "set_node") {
    const id = requireNode(next, op.id);
    if (op.shape) {
      if (!(SHAPE_IDS as readonly string[]).includes(op.shape)) throw new Error(`Unknown shape “${op.shape}”.`);
      next.nodes[id]!.shape = op.shape;
    }
    if (op.color !== undefined) {
      if (op.color && !colorOk(op.color)) throw new Error(`Unknown colour “${op.color}”.`);
      next.nodes[id]!.color = op.color;
    }
    return next;
  }
  next.meta.curve = op.curve;
  if (op.edge) {
    if (!next.edges[op.edge]) throw new Error(`No arrow “${op.edge}”.`);
    next.edges[op.edge]!.curve = op.curve;
  }
  return next;
}

function edgeKey(model: DiagramModel, from: string, to: string, label: string): string {
  const left = model.nodes[from]?.label ?? from;
  const right = model.nodes[to]?.label ?? to;
  return label ? `${left} → ${right} (${label})` : `${left} → ${right}`;
}

/** Added, removed, and changed blocks and arrows, for the Apply card. */
export function diagramChanges(before: DiagramModel, after: DiagramModel): string[] {
  const lines: string[] = [];
  const beforeIds = new Set(Object.keys(before.nodes));
  const afterIds = new Set(Object.keys(after.nodes));
  for (const id of afterIds) {
    if (!beforeIds.has(id)) lines.push(`Added block “${after.nodes[id]!.label}”`);
  }
  for (const id of beforeIds) {
    if (!afterIds.has(id)) lines.push(`Removed block “${before.nodes[id]!.label}”`);
  }
  for (const id of afterIds) {
    if (!beforeIds.has(id)) continue;
    const prev = before.nodes[id]!;
    const next = after.nodes[id]!;
    const bits: string[] = [];
    if (prev.label !== next.label) bits.push(`label “${prev.label}” → “${next.label}”`);
    if (prev.shape !== next.shape) bits.push(`shape ${prev.shape} → ${next.shape}`);
    if (prev.color !== next.color) bits.push(`colour ${prev.color ?? "default"} → ${next.color ?? "default"}`);
    if (prev.group !== next.group) bits.push(`group ${prev.group ?? "none"} → ${next.group ?? "none"}`);
    if (bits.length) lines.push(`Changed “${next.label}” (${bits.join(", ")})`);
  }
  const beforeEdges = new Set(Object.values(before.edges).map((edge) => edgeKey(before, edge.from.node, edge.to.node, edge.label)));
  const afterEdges = new Set(Object.values(after.edges).map((edge) => edgeKey(after, edge.from.node, edge.to.node, edge.label)));
  for (const edge of afterEdges) if (!beforeEdges.has(edge)) lines.push(`Added arrow ${edge}`);
  for (const edge of beforeEdges) if (!afterEdges.has(edge)) lines.push(`Removed arrow ${edge}`);
  if (before.meta.curve !== after.meta.curve) lines.push(`Curve ${before.meta.curve} → ${after.meta.curve}`);
  return lines;
}

/**
 * Apply semantic edits, then re-validate. Ids, locks, and layout of blocks
 * that remain are kept. A locked block cannot be removed or moved.
 */
export function applyDiagramEdits(source: string, ops: DiagramOp[]): { source: string; model: DiagramModel; changes: string[] } {
  if (!ops.length) throw new Error("Pass at least one edit.");
  let model = parseDiagram(source).model;
  const before = clone(model);
  let text = source;
  for (const op of ops) {
    if (op.op === "patch") {
      const at = text.indexOf(op.find);
      if (at < 0 || text.indexOf(op.find, at + 1) >= 0) throw new Error("find must match exactly one place in the diagram text.");
      text = `${text.slice(0, at)}${op.replace}${text.slice(at + op.find.length)}`;
      const parsed = parseDiagram(text);
      const problems = parsed.diagnostics.filter((item) => item.severity === "error" || item.severity === "warning");
      if (errorCount(parsed.diagnostics) || problems.some((item) => item.severity === "warning")) {
        throw new Error(problems.map((item) => item.message).join("; ") || "That edit is not valid.");
      }
      model = restoreGuards(model, parsed.model);
      text = printDiagram(model);
      continue;
    }
    model = applyOp(model, op);
  }
  text = printDiagram(model);
  const parsed = parseDiagram(text);
  const problems = parsed.diagnostics.filter((item) => item.severity === "error" || item.severity === "warning");
  if (problems.length) throw new Error(problems.map((item) => item.message).join("; ") || "That edit is not valid.");
  model = restoreGuards(model, parsed.model);
  text = printDiagram(model);
  return { source: text, model, changes: diagramChanges(before, model) };
}
