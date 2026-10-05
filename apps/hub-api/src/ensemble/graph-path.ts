export interface GraphEdge {
  source: string;
  target: string;
  kind: string;
}

/**
 * Shortest path over the edges the user can already see.
 * Returns null when either id is outside that graph.
 */
export function shortestPath(nodeIds: ReadonlySet<string>, edges: readonly GraphEdge[], from: string, to: string): string[] | null {
  if (!nodeIds.has(from) || !nodeIds.has(to)) return null;
  if (from === to) return [from];
  const next = new Map<string, string[]>();
  const link = (source: string, target: string) => {
    if (!nodeIds.has(source) || !nodeIds.has(target)) return;
    const list = next.get(source) ?? [];
    list.push(target);
    next.set(source, list);
  };
  for (const edge of edges) {
    link(edge.source, edge.target);
    link(edge.target, edge.source);
  }
  const prev = new Map<string, string>();
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length) {
    const current = queue.shift();
    if (!current) break;
    for (const neighbor of next.get(current) ?? []) {
      if (seen.has(neighbor)) continue;
      seen.add(neighbor);
      prev.set(neighbor, current);
      if (neighbor === to) {
        const path = [to];
        let cursor = to;
        while (cursor !== from) {
          const before = prev.get(cursor);
          if (!before) return null;
          cursor = before;
          path.push(cursor);
        }
        return path.reverse();
      }
      queue.push(neighbor);
    }
  }
  return null;
}
