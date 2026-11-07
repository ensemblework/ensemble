/**
 * The order of the sidebar's tabs (Board through Weekly recap), as the person dragged them. Kept as groups
 * so the gaps between groups stay; a tab can move into any group. Today, Pages, Files, Shared with you and
 * Settings keep their places.
 */
export const SIDEBAR_ORDER_KEY = "ensemble.sidebar.order";

export const DEFAULT_SIDEBAR_ORDER: string[][] = [
  ["/board", "/needs-me", "/marketplace"],
  ["/context", "/meetings", "/routines"],
  ["/code", "/runs", "/skills"],
  ["/metrics", "/diagrams", "/plots", "/recap"],
];

const KNOWN = new Map(DEFAULT_SIDEBAR_ORDER.flatMap((group, index) => group.map((href) => [href, index] as const)));

/** A stored order made safe: unknown tabs dropped, each tab once, a tab added later goes to its usual group. */
export function arrangeSidebar(stored: unknown): string[][] {
  if (!Array.isArray(stored)) return DEFAULT_SIDEBAR_ORDER.map((group) => [...group]);
  const seen = new Set<string>();
  const groups = stored
    .filter(Array.isArray)
    .map((group) => (group as unknown[]).filter((href): href is string => typeof href === "string" && KNOWN.has(href) && !seen.has(href) && Boolean(seen.add(href))));
  while (groups.length < DEFAULT_SIDEBAR_ORDER.length) groups.push([]);
  for (const [href, index] of KNOWN) if (!seen.has(href)) groups[index]!.push(href);
  return groups;
}

/** Moves `href` to `index` in group `group` (an index past the end appends). */
export function moveSidebarTab(order: string[][], href: string, group: number, index: number): string[][] {
  const next = order.map((items) => items.filter((item) => item !== href));
  const from = order.findIndex((items) => items.includes(href));
  const at = from === group ? Math.min(index - (order[from]!.indexOf(href) < index ? 1 : 0), next[group]!.length) : Math.min(index, next[group]?.length ?? 0);
  if (!next[group]) return order;
  next[group]!.splice(Math.max(0, at), 0, href);
  return next;
}

/** One step up or down among the visible tabs, across a group's edge into the next group. */
export function stepSidebarTab(order: string[][], href: string, delta: -1 | 1, shown: (href: string) => boolean): string[][] {
  const flat = order.flatMap((items, group) => items.filter(shown).map((item) => ({ item, group })));
  const at = flat.findIndex((row) => row.item === href);
  const target = flat[at + delta];
  if (at < 0 || !target) return order;
  const group = order[target.group]!;
  // Within a group it swaps with its neighbour; across a group's edge it becomes that group's last (up) or first (down).
  const across = target.group !== flat[at]!.group;
  const after = across ? delta < 0 : delta > 0;
  return moveSidebarTab(order, href, target.group, group.indexOf(target.item) + (after ? 1 : 0));
}

export const isDefaultSidebar = (order: string[][]) => JSON.stringify(order) === JSON.stringify(DEFAULT_SIDEBAR_ORDER);
