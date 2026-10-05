/**
 * Manual Context board order. Preference `hub.context.board`.
 * Not an undo entry: it is display order, like a layout.
 */
export const ORDER_KEY = "hub.context.board";
export const LANES = ["people", "projects", "repos", "meetings", "artifacts"] as const;
export const LANE_CAP = 80;
export const CARD_CAP = 24;
export const GROUP_CAP = 12;
export const ORDER_BYTES = 8_000;

export type LaneId = (typeof LANES)[number];
export type ContextView = "board" | "grid" | "list" | "graph";
export type ContextGroup = "kind" | "project";

export type OrderDocument = {
  view: ContextView;
  group: ContextGroup;
  lanes: Record<LaneId, string[]>;
  groups: Record<string, string[]>;
  /** When set, the board shows only these kinds. Lane order is left alone. */
  kinds?: LaneId[];
};

export class OrderError extends Error {
  statusCode = 400;
}

const VIEWS = new Set<ContextView>(["board", "grid", "list", "graph"]);
const GROUPS = new Set<ContextGroup>(["kind", "project"]);

export function emptyOrder(): OrderDocument {
  return {
    view: "board",
    group: "kind",
    lanes: { people: [], projects: [], repos: [], meetings: [], artifacts: [] },
    groups: {},
  };
}

function idList(value: unknown, allowed: Set<string> | null): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.length < 8 || item.length > 80) continue;
    if (seen.has(item)) continue;
    if (allowed && !allowed.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= LANE_CAP) break;
  }
  return out;
}

/**
 * Keep only ids this user owns. Extra ids are dropped. A huge body is rejected.
 */
export function sanitizeOrder(input: unknown, owned: Record<LaneId, Set<string>>, extraIds?: Set<string>): OrderDocument {
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const encoded = JSON.stringify(raw);
  if (encoded.length > ORDER_BYTES) throw new OrderError("That order is too large.");
  const view = VIEWS.has(raw.view as ContextView) ? (raw.view as ContextView) : "board";
  const group = GROUPS.has(raw.group as ContextGroup) ? (raw.group as ContextGroup) : "kind";
  const lanesIn = raw.lanes && typeof raw.lanes === "object" ? (raw.lanes as Record<string, unknown>) : {};
  const lanes = {} as Record<LaneId, string[]>;
  for (const lane of LANES) lanes[lane] = idList(lanesIn[lane], owned[lane]);
  const groupsIn = raw.groups && typeof raw.groups === "object" ? (raw.groups as Record<string, unknown>) : {};
  const groups: Record<string, string[]> = {};
  const anyOwned =
    owned.people === allowAny ? null : new Set<string>([...LANES.flatMap((lane) => [...owned[lane]]), ...(extraIds ?? [])]);
  for (const [key, value] of Object.entries(groupsIn)) {
    if (Object.keys(groups).length >= GROUP_CAP) break;
    if (!/^project:[0-9a-f-]{36}$/i.test(key) && key !== "unlinked") continue;
    groups[key] = idList(value, anyOwned);
  }
  const kindsIn = Array.isArray(raw.kinds) ? raw.kinds : null;
  const kinds = kindsIn
    ? LANES.filter((lane) => kindsIn.includes(lane))
    : undefined;
  return { view, group, lanes, groups, ...(kinds && kinds.length ? { kinds } : {}) };
}

const allowAny = { has: () => true } as unknown as Set<string>;

/** Read a stored document. Unknown ids fall out later, when cards are arranged. */
export function readOrder(value: unknown): OrderDocument {
  try {
    return sanitizeOrder(value, {
      people: allowAny,
      projects: allowAny,
      repos: allowAny,
      meetings: allowAny,
      artifacts: allowAny,
    });
  } catch {
    return emptyOrder();
  }
}

/** Saved ids first, then anything new, in the natural order. */
export function arrange<T extends { id: string }>(cards: readonly T[], saved: readonly string[]): T[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const next: T[] = [];
  const seen = new Set<string>();
  for (const id of saved) {
    const card = byId.get(id);
    if (!card || seen.has(id)) continue;
    seen.add(id);
    next.push(card);
  }
  for (const card of cards) {
    if (seen.has(card.id)) continue;
    next.push(card);
  }
  return next;
}
