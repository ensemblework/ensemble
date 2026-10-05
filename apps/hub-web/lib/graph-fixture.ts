import type { GraphEdge, GraphNode } from "./api";
import { nodeDegree } from "./graph-readability";
import seed from "./graph-seed.json";

/**
 * Dev-only stand-in for the seeded context graph, plus the `?graphScale=`
 * expander (capped at 6). Production builds alias `@/lib/graph-fixture` to
 * `graph-fixture.prod.ts`. The graph viewer loads this with a dynamic import
 * behind `NODE_ENV !== "production"`.
 */
export function seedGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  return {
    nodes: seed.nodes.map((node) => ({ ...node })),
    edges: seed.edges.map((edge) => ({ ...edge })),
  };
}

const COPY_MARK = ["", " · north", " · south", " · east", " · west", " · extra"];

/**
 * Repeat a graph `scale` times and add a few long / non-English labels.
 * `scale` is capped at 6. A scale of 3 is about three copies plus those stress nodes.
 */
export function expandGraph<N extends { id: string; label: string; kind: string }>(
  nodes: readonly N[],
  edges: readonly { source: string; target: string; kind: string }[],
  scale: number,
): { nodes: N[]; edges: Array<{ source: string; target: string; kind: string }> } {
  const copies = Math.max(1, Math.min(6, Math.round(scale)));
  if (copies <= 1 || nodes.length === 0) {
    return { nodes: nodes.map((node) => ({ ...node })), edges: edges.map((edge) => ({ ...edge })) };
  }
  const outNodes: N[] = [];
  const outEdges: Array<{ source: string; target: string; kind: string }> = [];
  for (let copy = 0; copy < copies; copy += 1) {
    const suffix = copy === 0 ? "" : `#${copy + 1}`;
    const mark = COPY_MARK[copy] ?? ` · ${copy + 1}`;
    const mapId = (id: string) => (copy === 0 ? id : `${id}${suffix}`);
    for (const node of nodes) {
      outNodes.push({ ...node, id: mapId(node.id), label: copy === 0 ? node.label : `${node.label}${mark}` });
    }
    for (const edge of edges) outEdges.push({ source: mapId(edge.source), target: mapId(edge.target), kind: edge.kind });
  }
  const degree = nodeDegree(nodes.map((node) => node.id), edges);
  const hub = [...nodes].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id))[0];
  if (hub) {
    for (let copy = 1; copy < copies; copy += 1) {
      outEdges.push({ source: hub.id, target: `${hub.id}#${copy + 1}`, kind: "member" });
    }
    const stress: Array<{ id: string; kind: string; label: string }> = [
      {
        id: "stress-long",
        kind: "task",
        label: "Reply to Priya with the full latency write-up, the dashboard link, the before-and-after p95, and the note that leadership asked for it before the end of the day",
      },
      { id: "stress-hi", kind: "note", label: "प्रिया नायर के साथ विलंबता की समीक्षा" },
      { id: "stress-ja", kind: "note", label: "レイテンシのレビューと公開準備" },
      { id: "stress-emoji", kind: "artifact", label: "Ship the ranker 🚀✨🎯" },
    ];
    for (const row of stress) {
      outNodes.push({ ...hub, ...row, sub: row.kind } as N);
      outEdges.push({ source: hub.id, target: row.id, kind: "note" });
    }
  }
  return { nodes: outNodes, edges: outEdges };
}

export function presentDevGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  scale: number,
  forceSeed = false,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const base = forceSeed || nodes.length === 0 ? seedGraph() : { nodes: nodes.map((node) => ({ ...node })), edges: edges.map((edge) => ({ ...edge })) };
  if (!(scale > 1)) return base;
  return expandGraph(base.nodes, base.edges, scale);
}

/** `?graphScale=3` repeats the current graph (capped at 6). `?graphFixture=seed` forces the seed sample. */
export function readGraphDevQuery(search: string): { scale: number; forceSeed: boolean } {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const raw = Number(params.get("graphScale"));
  const scale = Number.isFinite(raw) && raw > 1 ? Math.min(6, Math.round(raw)) : 1;
  return { scale, forceSeed: params.get("graphFixture") === "seed" };
}
