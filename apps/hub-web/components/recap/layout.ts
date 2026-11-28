import { arrange, readLayout, type DeskLayout } from "@/components/desk/layout";

/** The weekly recap's arrangement: order, widths and removed tiles, in the same shape as a Today layout. */
export const RECAP_LAYOUT_KEY = "desk.recap.layout";

/** `md`: half a row on a tablet until the person arranges the recap (then any tile of 6 columns or fewer is). */
export type RecapTileSpec = { key: RecapTileKey; title: string; c: number; r: number; hero?: boolean; md?: 6 };
export type RecapTileKey = "rhythm" | "highlights" | "when" | "time" | "projects" | "agents" | "ahead" | "record";

/** Recap tiles take the height of their content; `r` is kept only because layouts share Today's shape. */
export const RECAP_TILES: RecapTileSpec[] = [
  { key: "rhythm", title: "Daily rhythm", c: 8, r: 3, hero: true },
  { key: "highlights", title: "Highlights", c: 4, r: 3 },
  { key: "when", title: "When you worked", c: 7, r: 3, md: 6 },
  { key: "time", title: "Where time went", c: 5, r: 3, md: 6 },
  { key: "projects", title: "Projects moved", c: 6, r: 3, md: 6 },
  { key: "agents", title: "Agent work", c: 6, r: 3, md: 6 },
  { key: "ahead", title: "Looking ahead", c: 12, r: 3 },
  { key: "record", title: "The week, item by item", c: 12, r: 3 },
];

const NONE: ReadonlyMap<string, RecapTileSpec> = new Map();

/** The recap tiles to draw, in the person's order and widths, and the ones they removed. */
export function recapArrangement(value: unknown): { layout: DeskLayout | null; shown: RecapTileSpec[]; hidden: RecapTileSpec[] } {
  const layout = readLayout(value);
  const shown = arrange(RECAP_TILES, NONE, layout);
  const on = new Set(shown.map((spec) => spec.key));
  return { layout, shown, hidden: RECAP_TILES.filter((spec) => !on.has(spec.key)) };
}

/**
 * Where one tile goes this week: its columns on a wide screen, half a row on a tablet or not, and whether
 * its width corner shows. With no active time Where time went is not drawn, so When you worked takes its
 * columns too, and its corner is left out because that width is not its own.
 */
export function recapPlace(spec: RecapTileSpec, shown: RecapTileSpec[], week: { customized: boolean; active: boolean }): { c: number; md?: 6; corner: boolean } {
  const half = (c: number) => (week.customized ? (c <= 6 ? (6 as const) : undefined) : spec.md);
  const time = shown.find((tile) => tile.key === "time");
  if (spec.key !== "when" || week.active || !time) return { c: spec.c, md: half(spec.c), corner: true };
  return { c: Math.min(12, spec.c + time.c), md: undefined, corner: false };
}
