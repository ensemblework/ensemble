import { footprintFor, measureLabelBox, resolveOverlaps, type Footprint } from "./graph-readability";

export type GraphPoint = { x: number; y: number };
export type GraphLink = { source: string; target: string };

export type LayoutOptions = {
  fontSize?: number;
  maxLabelChars?: number;
  nodeRadius?: number;
  /** Per-node marker radius. Falls back to `nodeRadius`. */
  radii?: ReadonlyMap<string, number>;
  /** Precomputed exclusive zones. When omitted, zones come from each node's label. */
  footprints?: ReadonlyMap<string, Footprint>;
};

/** Nodes that share an edge with another visible node, and the ones that do not. */
export function partitionGraph<T extends { id: string }>(nodes: readonly T[], edges: readonly GraphLink[]): { linked: T[]; isolated: T[] } {
  const ids = new Set(nodes.map((node) => node.id));
  const degree = new Map<string, number>();
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target) continue;
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const linked: T[] = [];
  const isolated: T[] = [];
  for (const node of nodes) (degree.has(node.id) ? linked : isolated).push(node);
  return { linked, isolated };
}

function hash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

function cluster(nodes: readonly { id: string; foot: Footprint }[], pins: Record<string, GraphPoint>): Map<string, GraphPoint> {
  const pos = new Map<string, GraphPoint>();
  const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(Math.max(nodes.length, 1)))));
  const rows: Array<typeof nodes> = [];
  for (let index = 0; index < nodes.length; index += cols) rows.push(nodes.slice(index, index + cols));
  let y = 48;
  for (const row of rows) {
    let x = 48;
    let rowH = 36;
    for (const node of row) {
      const pin = pins[node.id];
      const width = node.foot.left + node.foot.right;
      const height = node.foot.top + node.foot.bottom;
      rowH = Math.max(rowH, height + 12);
      pos.set(node.id, pin ?? { x: x + node.foot.left, y: y + node.foot.top });
      x += width + 16;
    }
    y += rowH;
  }
  return pos;
}

function translateFree(pos: Map<string, GraphPoint>, pins: Record<string, GraphPoint>): Map<string, GraphPoint> {
  let minX = Infinity;
  let minY = Infinity;
  let count = 0;
  for (const [id, point] of pos) {
    if (pins[id]) continue;
    count += 1;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
  }
  if (!count || !Number.isFinite(minX)) return pos;
  const dx = 48 - minX;
  const dy = 48 - minY;
  const next = new Map<string, GraphPoint>();
  for (const [id, point] of pos) {
    const pin = pins[id];
    next.set(id, pin ?? { x: point.x + dx, y: point.y + dy });
  }
  return next;
}

function zoneFor(node: { id: string; label?: string }, options?: LayoutOptions): Footprint {
  const given = options?.footprints?.get(node.id);
  if (given) return given;
  const radius = options?.radii?.get(node.id) ?? options?.nodeRadius ?? 8;
  const box = measureLabelBox(node.label ?? node.id, {
    fontSize: options?.fontSize ?? 12,
    maxChars: options?.maxLabelChars ?? 28,
  });
  return footprintFor(box, radius, 8);
}

/**
 * Force layout for a connected graph. Spacing follows each node's label box,
 * then a collision pass separates any pair that still overlaps. A set with
 * no edges becomes a labeled cluster. Nothing is parked on a fixed ring, and
 * the result is not squashed into a fixed frame — the camera fits the view.
 */
export function layoutGraph(
  nodes: readonly { id: string; label?: string }[],
  edges: readonly GraphLink[],
  pins: Record<string, GraphPoint> = {},
  options?: LayoutOptions,
): Map<string, GraphPoint> {
  const feet = nodes.map((node) => zoneFor(node, options));
  const ids = new Set(nodes.map((node) => node.id));
  const liveEdges = edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target) && edge.source !== edge.target);
  if (nodes.length <= 1 || liveEdges.length === 0) {
    return cluster(
      nodes.map((node, index) => ({ id: node.id, foot: feet[index]! })),
      pins,
    );
  }

  const reach = feet.map((foot) => Math.hypot(Math.max(foot.left, foot.right), Math.max(foot.top, foot.bottom)));
  const ideal = Math.max(96, reach.reduce((sum, value) => sum + value, 0) / Math.max(1, reach.length));
  const index = new Map(nodes.map((node, order) => [node.id, order]));
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const cell = ideal * 0.85;
  const pos = nodes.map((node, order) => {
    const jitter = ((hash(node.id) % 17) - 8) * 0.8;
    return { x: (order % cols) * cell + jitter, y: Math.floor(order / cols) * cell - jitter };
  });
  const disp = nodes.map(() => ({ x: 0, y: 0 }));
  let temperature = Math.max(48, ideal * 0.55);
  const iterations = Math.min(72, 24 + Math.ceil(nodes.length * 0.35));

  for (let iter = 0; iter < iterations; iter += 1) {
    for (const row of disp) {
      row.x = 0;
      row.y = 0;
    }
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        let dx = pos[i]!.x - pos[j]!.x;
        let dy = pos[i]!.y - pos[j]!.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.1) {
          dx = ((hash(nodes[i]!.id) % 5) - 2) || 1;
          dy = ((hash(nodes[j]!.id) % 5) - 2) || 1;
          dist = Math.hypot(dx, dy);
        }
        const minDist = (reach[i] ?? ideal) + (reach[j] ?? ideal);
        const force = dist < minDist ? (minDist * minDist) / dist : (ideal * ideal) / dist;
        const ux = dx / dist;
        const uy = dy / dist;
        disp[i]!.x += ux * force;
        disp[i]!.y += uy * force;
        disp[j]!.x -= ux * force;
        disp[j]!.y -= uy * force;
      }
    }
    for (const edge of liveEdges) {
      const i = index.get(edge.source);
      const j = index.get(edge.target);
      if (i === undefined || j === undefined) continue;
      const dx = pos[i]!.x - pos[j]!.x;
      const dy = pos[i]!.y - pos[j]!.y;
      const dist = Math.hypot(dx, dy) || 0.1;
      const force = (dist * dist) / ideal;
      const ux = dx / dist;
      const uy = dy / dist;
      disp[i]!.x -= ux * force;
      disp[i]!.y -= uy * force;
      disp[j]!.x += ux * force;
      disp[j]!.y += uy * force;
    }
    let cx = 0;
    let cy = 0;
    for (const point of pos) {
      cx += point.x;
      cy += point.y;
    }
    cx /= nodes.length;
    cy /= nodes.length;
    for (let i = 0; i < nodes.length; i += 1) {
      if (pins[nodes[i]!.id]) continue;
      disp[i]!.x += (cx - pos[i]!.x) * 0.04;
      disp[i]!.y += (cy - pos[i]!.y) * 0.04;
      const length = Math.hypot(disp[i]!.x, disp[i]!.y) || 1;
      const step = Math.min(length, temperature);
      pos[i]!.x += (disp[i]!.x / length) * step;
      pos[i]!.y += (disp[i]!.y / length) * step;
    }
    temperature *= 0.92;
  }

  const relaxed = resolveOverlaps(
    nodes.map((node, order) => ({
      id: node.id,
      x: pos[order]!.x,
      y: pos[order]!.y,
      pinned: Boolean(pins[node.id]),
      foot: feet[order]!,
    })),
    Math.min(56, 12 + nodes.length),
  );
  const mapped = new Map<string, GraphPoint>();
  for (const point of relaxed) mapped.set(point.id, { x: point.x, y: point.y });
  return translateFree(mapped, pins);
}
