import type { GraphEdge } from "./graph-path.js";

export interface GraphFactNode {
  id: string;
  kind: string;
  label: string;
}

/** task.people stores a person id, and older rows store a display name. */
export function personNodeId(value: string, ids: ReadonlySet<string>, byName: ReadonlyMap<string, string>): string | undefined {
  if (ids.has(value)) return value;
  return byName.get(value.toLowerCase());
}

const DETAIL_CAP = 48;

/**
 * Rank the whole graph by how connected each node is.
 * The text lists neighbours, so a repo past a naive first-page cut still names its tasks.
 */
export function describeGraph(nodes: GraphFactNode[], edges: readonly GraphEdge[], requested: readonly string[] = []): {
  ranked: GraphFactNode[];
  text: string;
} {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const degree = new Map<string, number>();
  for (const node of nodes) degree.set(node.id, 0);
  for (const edge of edges) {
    if (byId.has(edge.source)) degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    if (byId.has(edge.target)) degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const wanted = new Set(requested);
  const ranked = [...nodes].sort((a, b) => {
    const pick = Number(wanted.has(b.id)) - Number(wanted.has(a.id));
    if (pick) return pick;
    const linked = (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0);
    if (linked) return linked;
    return a.label.localeCompare(b.label);
  });
  const shown = ranked.slice(0, DETAIL_CAP);
  const rest = ranked.slice(DETAIL_CAP);
  const line = (node: GraphFactNode) => {
    const linked = edges
      .filter((edge) => edge.source === node.id || edge.target === node.id)
      .map((edge) => {
        const other = byId.get(edge.source === node.id ? edge.target : edge.source);
        return other ? `${edge.kind} ${other.kind} “${other.label}” (${other.id})` : null;
      })
      .filter((item): item is string => Boolean(item));
    return `${node.kind} ${node.id} “${node.label}”${linked.length ? ` — ${linked.join("; ")}` : ""}`;
  };
  const counts = new Map<string, number>();
  for (const node of rest) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
  const summary = rest.length
    ? `Also in the graph (${rest.length} more): ${[...counts.entries()].map(([kind, count]) => `${count} ${kind}`).join(", ")}. ${rest
        .slice(0, 24)
        .map((node) => `${node.kind} “${node.label}” (${node.id})`)
        .join("; ")}.`
    : "";
  return {
    ranked: shown,
    text: [
      "Context graph. Cite only ids you actually use in the answer.",
      "Connections, most linked first. These match the edges drawn on the graph.",
      ...shown.map(line),
      summary,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/** Keep the path and the cited nodes, then as much of the rest as fits. */
export function fitBudget(parts: readonly string[], max = 7000): string {
  const kept: string[] = [];
  let used = 0;
  for (const part of parts) {
    if (!part) continue;
    const sep = kept.length ? 1 : 0;
    if (kept.length === 0 || used + sep + part.length <= max) {
      kept.push(part);
      used += sep + part.length;
      continue;
    }
    const room = max - used - sep;
    if (room > 24) kept.push(`${part.slice(0, room - 1)}…`);
    break;
  }
  return kept.join("\n");
}
