import type { GraphEdge, GraphNode } from "./api";

/**
 * Production stub for `@/lib/graph-fixture`. The seed sample and the scale
 * expander stay in `graph-fixture.ts`, which production builds do not resolve.
 */
export function seedGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  return { nodes: [], edges: [] };
}

export function expandGraph<N extends { id: string; label: string; kind: string }>(
  nodes: readonly N[],
  edges: readonly { source: string; target: string; kind: string }[],
  _scale: number,
): { nodes: N[]; edges: Array<{ source: string; target: string; kind: string }> } {
  return {
    nodes: nodes.map((node) => ({ ...node })),
    edges: edges.map((edge) => ({ ...edge })),
  };
}

export function presentDevGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  scale: number,
  _forceSeed = false,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  return expandGraph(nodes, edges, scale);
}

export function readGraphDevQuery(_search: string): { scale: number; forceSeed: boolean } {
  return { scale: 1, forceSeed: false };
}
