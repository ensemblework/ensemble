/**
 * Pure helpers for the context graph: label size, collision spacing,
 * level-of-detail, neighbour focus, and type filters. The canvas viewer
 * calls these; it does not re-implement the rules.
 */

export type Box = { x: number; y: number; width: number; height: number };

export type Footprint = { left: number; right: number; top: number; bottom: number };

export type LabelCandidate = {
  id: string;
  kind: string;
  degree: number;
  selected?: boolean;
  hovered?: boolean;
  neighbor?: boolean;
};

const KIND_WEIGHT: Record<string, number> = {
  project: 5,
  people: 5,
  repo: 4,
  deliverable: 3,
  task: 2,
  skill: 2,
  diagram: 2,
  plot: 2,
  note: 1,
  artifact: 1,
};

export type NodeShape = "circle" | "round" | "square" | "diamond" | "triangle" | "hex";

const SHAPES: Record<string, NodeShape> = {
  people: "circle",
  project: "round",
  repo: "square",
  task: "diamond",
  deliverable: "hex",
  skill: "triangle",
  note: "round",
  diagram: "hex",
  plot: "diamond",
  artifact: "square",
};

export function shapeFor(kind: string): NodeShape {
  return SHAPES[kind] ?? "circle";
}

export function graphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment);
  }
  return [...text];
}

/** Truncate on grapheme boundaries so Hindi, Japanese, and emoji stay intact. */
export function truncateLabel(label: string, maxChars: number): string {
  const parts = graphemes(label);
  if (parts.length <= maxChars) return label;
  if (maxChars <= 1) return "…";
  return `${parts.slice(0, maxChars - 1).join("")}…`;
}

function charUnits(grapheme: string): number {
  if (grapheme === "…") return 0.7;
  if (/\p{Extended_Pictographic}/u.test(grapheme)) return 1.15;
  const code = grapheme.codePointAt(0) ?? 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xff00 && code <= 0xff60)
  ) {
    return 1;
  }
  if (/\p{Script=Devanagari}|\p{Script=Bengali}|\p{Script=Tamil}|\p{Script=Telugu}|\p{Script=Arabic}/u.test(grapheme)) return 0.72;
  return 0.56;
}

/** Approximate label chip size in CSS pixels. Wider and taller labels take more space. */
export function measureLabelBox(
  label: string,
  options?: { fontSize?: number; maxChars?: number; padX?: number; padY?: number },
): { width: number; height: number } {
  const fontSize = options?.fontSize ?? 12;
  const maxChars = options?.maxChars ?? 28;
  const shown = truncateLabel(label, maxChars);
  let units = 0;
  for (const part of graphemes(shown)) units += charUnits(part);
  return {
    width: Math.max(fontSize, units * fontSize + (options?.padX ?? 10)),
    height: fontSize + (options?.padY ?? 6),
  };
}

/**
 * Exclusive zone around a node center. The label sits to the right of the
 * marker, so the right side grows with the label width and the vertical
 * side grows with the label height.
 */
export function footprintFor(labelBox: { width: number; height: number }, nodeRadius: number, gap = 0): Footprint {
  const halfH = Math.max(nodeRadius, labelBox.height / 2);
  return {
    left: nodeRadius + gap,
    right: 14 + labelBox.width + gap,
    top: halfH + gap,
    bottom: halfH + gap,
  };
}

/** How far another node center must stay, using the label box, not the marker radius alone. */
export function collisionRadius(labelBox: { width: number; height: number }, nodeRadius: number, gap = 4): number {
  const foot = footprintFor(labelBox, nodeRadius, gap);
  return Math.hypot(Math.max(foot.left, foot.right), Math.max(foot.top, foot.bottom));
}

export function footprintsOverlap(a: { x: number; y: number }, fa: Footprint, b: { x: number; y: number }, fb: Footprint): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const needX = dx >= 0 ? fa.right + fb.left : fa.left + fb.right;
  const needY = dy >= 0 ? fa.bottom + fb.top : fa.top + fb.bottom;
  return needX - Math.abs(dx) > 0.5 && needY - Math.abs(dy) > 0.5;
}

export type RelaxPoint = { id: string; x: number; y: number; pinned?: boolean; foot: Footprint };

/** Push overlapping footprints apart. Pinned nodes stay where they were dropped. */
export function resolveOverlaps(points: readonly RelaxPoint[], iterations = 48): Array<{ id: string; x: number; y: number }> {
  const pos = points.map((point) => ({ ...point }));
  for (let iter = 0; iter < iterations; iter += 1) {
    let moved = false;
    for (let i = 0; i < pos.length; i += 1) {
      for (let j = i + 1; j < pos.length; j += 1) {
        const a = pos[i]!;
        const b = pos[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) {
          dx = 1;
          dy = (i + j) % 2 === 0 ? 1 : -1;
        }
        const needX = dx >= 0 ? a.foot.right + b.foot.left : a.foot.left + b.foot.right;
        const needY = dy >= 0 ? a.foot.bottom + b.foot.top : a.foot.top + b.foot.bottom;
        const overlapX = needX - Math.abs(dx);
        const overlapY = needY - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;
        if (a.pinned && b.pinned) continue;
        const alongX = overlapX <= overlapY;
        const sign = alongX ? Math.sign(dx) || 1 : Math.sign(dy) || 1;
        const amount = (alongX ? overlapX : overlapY) + 1;
        const move = (point: RelaxPoint, dir: number) => {
          if (alongX) point.x += dir * sign * amount;
          else point.y += dir * sign * amount;
        };
        if (a.pinned) move(b, 1);
        else if (b.pinned) move(a, -1);
        else {
          if (alongX) {
            a.x -= sign * amount * 0.5;
            b.x += sign * amount * 0.5;
          } else {
            a.y -= sign * amount * 0.5;
            b.y += sign * amount * 0.5;
          }
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
  return pos.map(({ id, x, y }) => ({ id, x, y }));
}

/** Lower scores are drawn first and win a collision. */
export function labelPriority(node: Omit<LabelCandidate, "id">): number {
  if (node.selected) return 0;
  if (node.hovered) return 1;
  if (node.neighbor) return 2;
  const kind = KIND_WEIGHT[node.kind] ?? 1;
  const degree = Math.min(12, Math.max(0, node.degree));
  return 30 - kind * 3 - degree;
}

/** Highest priority score still eligible at this zoom. Selected, hovered, and neighbours bypass it. */
export function labelZoomLimit(zoom: number): number {
  if (zoom >= 1.45) return 100;
  if (zoom >= 1.15) return 28;
  if (zoom >= 0.85) return 22;
  if (zoom >= 0.6) return 16;
  return 12;
}

/** Ids allowed to try for a label, best priority first. */
export function eligibleLabelIds(nodes: readonly LabelCandidate[], zoom: number): string[] {
  const limit = labelZoomLimit(zoom);
  return nodes
    .map((node) => ({
      id: node.id,
      score: labelPriority(node),
      forced: Boolean(node.selected || node.hovered || node.neighbor),
    }))
    .filter((row) => row.forced || row.score <= limit)
    .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))
    .map((row) => row.id);
}

export function boxesIntersect(a: Box, b: Box, pad = 0): boolean {
  return a.x - pad < b.x + b.width && a.x + a.width + pad > b.x && a.y - pad < b.y + b.height && a.y + a.height + pad > b.y;
}

/** Keep the earlier (higher priority) label when two chips would paint on top of each other. */
export function visibleLabelIds(orderedIds: readonly string[], boxes: ReadonlyMap<string, Box>, pad = 3): Set<string> {
  const placed: Box[] = [];
  const keep = new Set<string>();
  for (const id of orderedIds) {
    const box = boxes.get(id);
    if (!box) continue;
    if (placed.some((other) => boxesIntersect(other, box, pad))) continue;
    placed.push(box);
    keep.add(id);
  }
  return keep;
}

export function countBoxOverlaps(boxes: readonly Box[]): number {
  let count = 0;
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (boxesIntersect(boxes[i]!, boxes[j]!)) count += 1;
    }
  }
  return count;
}

/** The focused node plus the nodes that share an edge with it. */
export function directNeighbourIds(focusId: string, edges: readonly { source: string; target: string }[]): Set<string> {
  const keep = new Set<string>([focusId]);
  for (const edge of edges) {
    if (edge.source === focusId) keep.add(edge.target);
    else if (edge.target === focusId) keep.add(edge.source);
  }
  return keep;
}

export function filterByNodeType<T extends { kind: string }>(nodes: readonly T[], hiddenTypes: readonly string[]): T[] {
  if (hiddenTypes.length === 0) return [...nodes];
  const hidden = new Set(hiddenTypes);
  return nodes.filter((node) => !hidden.has(node.kind));
}

export function nodeDegree(ids: readonly string[], edges: readonly { source: string; target: string }[]): Map<string, number> {
  const known = new Set(ids);
  const degree = new Map<string, number>();
  for (const id of ids) degree.set(id, 0);
  for (const edge of edges) {
    if (!known.has(edge.source) || !known.has(edge.target) || edge.source === edge.target) continue;
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  return degree;
}

/**
 * Camera that shows every box. Zoom is capped so a single node does not fill
 * the stage; it is allowed to go small so a large graph still fits.
 */
export function fitGraphView(
  boxes: readonly { x: number; y: number; width: number; height: number }[],
  viewport: { width: number; height: number },
  options?: { maxZoom?: number; minZoom?: number; pad?: number },
): { x: number; y: number; zoom: number } {
  const maxZoom = options?.maxZoom ?? 1.2;
  const minZoom = options?.minZoom ?? 0.04;
  const pad = options?.pad ?? 28;
  if (!boxes.length || viewport.width < 40 || viewport.height < 40) return { x: 24, y: 24, zoom: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  const spanX = Math.max(32, maxX - minX);
  const spanY = Math.max(32, maxY - minY);
  const raw = Math.min((viewport.width - pad * 2) / spanX, (viewport.height - pad * 2) / spanY);
  const zoom = Math.min(maxZoom, Math.max(minZoom, raw));
  return {
    zoom,
    x: (viewport.width - spanX * zoom) / 2 - minX * zoom,
    y: (viewport.height - spanY * zoom) / 2 - minY * zoom,
  };
}

export type GraphDebugNode = { id: string; x: number; y: number; width: number; height: number };
export type GraphDebugLabel = GraphDebugNode & { text: string; visible: boolean };
export type GraphDebug = { nodes: GraphDebugNode[]; labels: GraphDebugLabel[]; settled: boolean };

declare global {
  interface Window {
    /** Dev-only settled graph boxes. Assigned only when NODE_ENV !== "production". */
    __ensembleGraphDebug?: GraphDebug;
  }
}
