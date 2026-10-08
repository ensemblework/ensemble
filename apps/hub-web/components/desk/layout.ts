export const GRID_COLUMNS = 12;
export const MAX_ROWS = 8;
export const LAYOUT_PREFIX = "desk.layout.";

export type TileSize = { c: number; r: number };
export type TileLimits = { minC: number; minR: number; maxC: number; maxR: number };
export type LayoutTile = { key: string } & TileSize;
/**
 * `hidden` is what the person took off. Desk tiles in neither list are new and get appended.
 * `exact` comes from a signup template: draw only `tiles`. The first edit writes the hidden list out instead.
 */
export type DeskLayout = { v: 1; tiles: LayoutTile[]; hidden: string[]; exact?: true };
type SpecLike = { key: string; c: number; r: number; hero?: boolean };
export type Arranged = { shown: SpecLike[]; hidden: string[] };

/** Tiles that draw a week, a band, or a timeline stop being readable below this. */
const WIDE = new Set(["limitation", "week", "countdown", "pipeline", "periods", "load", "reviews", "plan", "syllabus", "build", "day", "objectives", "now"]);

export function layoutKey(deskId: string) {
  return `${LAYOUT_PREFIX}${deskId}`;
}

export function tileLimits(spec: SpecLike): TileLimits {
  if (spec.hero) return { minC: 6, minR: 3, maxC: GRID_COLUMNS, maxR: MAX_ROWS };
  if (WIDE.has(spec.key)) return { minC: 4, minR: 3, maxC: GRID_COLUMNS, maxR: MAX_ROWS };
  return { minC: 3, minR: 2, maxC: GRID_COLUMNS, maxR: MAX_ROWS };
}

export function clampSize(size: TileSize, limits: TileLimits): TileSize {
  const round = (value: number) => (Number.isFinite(value) ? Math.round(value) : 0);
  return {
    c: Math.min(limits.maxC, Math.max(limits.minC, round(size.c))),
    r: Math.min(limits.maxR, Math.max(limits.minR, round(size.r))),
  };
}

export function readLayout(value: unknown): DeskLayout | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { tiles?: unknown; hidden?: unknown; exact?: unknown };
  if (!Array.isArray(raw.tiles)) return null;
  const seen = new Set<string>();
  const tiles: LayoutTile[] = [];
  for (const item of raw.tiles) {
    if (!item || typeof item !== "object") continue;
    const { key, c, r } = item as Partial<LayoutTile>;
    if (typeof key !== "string" || !key || seen.has(key) || typeof c !== "number" || typeof r !== "number") continue;
    seen.add(key);
    tiles.push({ key, c, r });
  }
  const hidden = Array.isArray(raw.hidden) ? raw.hidden.filter((key): key is string => typeof key === "string" && !seen.has(key)) : [];
  return { v: 1, tiles, hidden: [...new Set(hidden)], ...(raw.exact === true ? { exact: true as const } : {}) };
}

/**
 * The tiles to draw, in order, at their saved size. Saved keys that no longer exist are dropped.
 * `pool` lets a layout borrow a tile from another desk.
 */
export function arrange<S extends SpecLike>(
  defaults: S[],
  pool: ReadonlyMap<string, S>,
  layout: DeskLayout | null,
  gates: { blocked?: ReadonlySet<string>; extras?: ReadonlySet<string> } = {},
): S[] {
  if (!layout) return defaults;
  const byKey = new Map(defaults.map((spec) => [spec.key, spec]));
  const placed = new Set<string>();
  const out: S[] = [];
  for (const tile of layout.tiles) {
    // A desk extra that is switched off is not borrowed back from the pool.
    const spec = byKey.get(tile.key) ?? (gates.blocked?.has(tile.key) ? undefined : pool.get(tile.key));
    if (!spec) continue;
    placed.add(tile.key);
    out.push({ ...spec, ...clampSize(tile, tileLimits(spec)) });
  }
  const hidden = new Set(layout.hidden);
  // An exact template layout still shows a desk extra the person switched on.
  for (const spec of defaults) {
    if (placed.has(spec.key) || hidden.has(spec.key)) continue;
    if (layout.exact && !gates.extras?.has(spec.key)) continue;
    out.push(spec);
  }
  return out;
}

function save(shown: SpecLike[], hidden: string[]): DeskLayout {
  const on = new Set(shown.map((spec) => spec.key));
  return { v: 1, tiles: shown.map((spec) => ({ key: spec.key, c: spec.c, r: spec.r })), hidden: [...new Set(hidden)].filter((key) => !on.has(key)) };
}

export function resizeTile({ shown, hidden }: Arranged, key: string, size: TileSize): DeskLayout {
  return save(
    shown.map((spec) => (spec.key === key ? { ...spec, ...clampSize(size, tileLimits(spec)) } : spec)),
    hidden,
  );
}

export function hideTile({ shown, hidden }: Arranged, key: string): DeskLayout {
  return save(
    shown.filter((spec) => spec.key !== key),
    [...hidden, key],
  );
}

export function showTile({ shown, hidden }: Arranged, spec: SpecLike): DeskLayout {
  const rest = hidden.filter((key) => key !== spec.key);
  if (shown.some((item) => item.key === spec.key)) return save(shown, rest);
  return save([...shown, { ...spec, ...clampSize(spec, tileLimits(spec)) }], rest);
}

/** Moves `key` to sit before `before`. A null `before` sends it to the end. */
export function moveTile({ shown, hidden }: Arranged, key: string, before: string | null): DeskLayout {
  const moving = shown.find((spec) => spec.key === key);
  if (!moving || key === before) return save(shown, hidden);
  const rest = shown.filter((spec) => spec.key !== key);
  const at = before ? rest.findIndex((spec) => spec.key === before) : -1;
  if (at < 0) rest.push(moving);
  else rest.splice(at, 0, moving);
  return save(rest, hidden);
}

export function stepTile({ shown, hidden }: Arranged, key: string, delta: -1 | 1): DeskLayout {
  const index = shown.findIndex((spec) => spec.key === key);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= shown.length) return save(shown, hidden);
  const next = [...shown];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return save(next, hidden);
}

/** Grid cells covered when a tile that started at `start` is dragged by (dx, dy) pixels. */
export function sizeFromDrag(
  start: TileSize,
  delta: { dx: number; dy: number },
  grid: { column: number; row: number; gap: number },
  limits: TileLimits,
): TileSize {
  const width = start.c * grid.column + (start.c - 1) * grid.gap + delta.dx;
  const height = start.r * grid.row + (start.r - 1) * grid.gap + delta.dy;
  return clampSize(
    {
      c: (width + grid.gap) / (grid.column + grid.gap),
      r: (height + grid.gap) / (grid.row + grid.gap),
    },
    limits,
  );
}

export function isDefaultLayout(layout: DeskLayout | null, shown: SpecLike[], defaults: SpecLike[]): boolean {
  if (!layout) return true;
  return (
    shown.length === defaults.length &&
    defaults.every((spec, index) => spec.key === shown[index]!.key && spec.c === shown[index]!.c && spec.r === shown[index]!.r)
  );
}

export function hiddenTilesFor<S extends SpecLike>(defaults: S[], shown: SpecLike[]): S[] {
  const on = new Set(shown.map((spec) => spec.key));
  return defaults.filter((spec) => !on.has(spec.key));
}
