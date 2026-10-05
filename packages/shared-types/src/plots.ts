import { z } from "zod";

/** Okabe–Ito, then the palettes analysts already reach for. */
export const OKABE_ITO = ["#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2", "#D55E00", "#CC79A7", "#000000"] as const;
export const TABLEAU_10 = ["#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F", "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC"] as const;
export const SET2 = ["#66c2a5", "#fc8d62", "#8da0cb", "#e78ac3", "#a6d854", "#ffd92f", "#e5c494", "#b3b3b3"] as const;
export const VIRIDIS = ["#440154", "#482878", "#3e4989", "#31688e", "#26828e", "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725"] as const;
export const RDBU = ["#67001f", "#b2182b", "#d6604d", "#f4a582", "#f7f7f7", "#92c5de", "#4393c3", "#2166ac", "#053061"] as const;

export const PALETTE_IDS = ["okabe-ito", "tableau10", "set2", "viridis", "rdbu", "accent"] as const;
export type PaletteId = (typeof PALETTE_IDS)[number];

export const CHART_TYPES = [
  "line",
  "area",
  "stacked-area",
  "bar",
  "stacked-bar",
  "stacked-bar-100",
  "bar-horizontal",
  "stacked-bar-horizontal",
  "pie",
  "donut",
  "scatter",
  "bubble",
  "histogram",
  "box",
  "violin",
  "heatmap",
  "step",
  "waterfall",
  "combo",
] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const COLUMN_TYPES = ["number", "date", "category", "text"] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export const AGGREGATIONS = ["none", "sum", "mean", "count", "median"] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

export const LINE_STYLES = ["solid", "dashed", "dotted", "dashdot"] as const;
export type LineStyleName = (typeof LINE_STYLES)[number];

export const MARKERS = ["auto", "none", "circle", "rect", "triangle", "diamond"] as const;
export type MarkerName = (typeof MARKERS)[number];

export const LEGEND_POSITIONS = ["top", "bottom", "left", "right", "none"] as const;
export type LegendPosition = (typeof LEGEND_POSITIONS)[number];

export const FIGURE_PRESETS = ["icml", "neurips", "iclr", "ensemble"] as const;
export type FigurePreset = (typeof FIGURE_PRESETS)[number];

export const FIGURE_SIZES = ["single", "double", "half", "custom"] as const;
export type FigureSize = (typeof FIGURE_SIZES)[number];

export const MAX_STORED_ROWS = 200_000;
export const PREVIEW_ROWS = 80;
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

export const columnSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(COLUMN_TYPES),
});
export type PlotColumn = z.infer<typeof columnSchema>;

export const seriesSchema = z.object({
  y: z.string().min(1).max(200),
  axis: z.enum(["left", "right"]).default("left"),
  agg: z.enum(AGGREGATIONS).optional(),
  color: z.string().max(32).optional(),
  lineStyle: z.enum(LINE_STYLES).optional(),
  width: z.number().min(0.25).max(8).optional(),
  marker: z.enum(MARKERS).optional(),
  opacity: z.number().min(0.05).max(1).optional(),
  /** Combo charts pick bar or line per series. Other charts ignore this. */
  mark: z.enum(["line", "bar", "area", "scatter"]).optional(),
  error: z.string().max(200).optional(),
  errorKind: z.enum(["bar", "band"]).optional(),
});
export type SeriesEncoding = z.infer<typeof seriesSchema>;

export const filterSchema = z.object({
  column: z.string().min(1).max(200),
  op: z.enum(["eq", "contains", "gt", "lt"]),
  value: z.string().max(500),
});
export type PlotFilter = z.infer<typeof filterSchema>;

export const annotationSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1).max(40),
    kind: z.literal("hline"),
    y: z.number(),
    axis: z.enum(["left", "right"]).default("left"),
    label: z.string().max(200).default(""),
    color: z.string().max(32).default("#D55E00"),
    style: z.enum(LINE_STYLES).default("dashed"),
  }),
  z.object({
    id: z.string().min(1).max(40),
    kind: z.literal("vline"),
    x: z.union([z.number(), z.string().max(200)]),
    label: z.string().max(200).default(""),
    color: z.string().max(32).default("#0072B2"),
    style: z.enum(LINE_STYLES).default("dashed"),
  }),
  z.object({
    id: z.string().min(1).max(40),
    kind: z.literal("linear"),
    m: z.number(),
    c: z.number(),
    axis: z.enum(["left", "right"]).default("left"),
    label: z.string().max(200).default(""),
    color: z.string().max(32).default("#009E73"),
    style: z.enum(LINE_STYLES).default("solid"),
  }),
  z.object({
    id: z.string().min(1).max(40),
    kind: z.literal("band"),
    orientation: z.enum(["horizontal", "vertical"]),
    from: z.number(),
    to: z.number(),
    axis: z.enum(["left", "right"]).default("left"),
    label: z.string().max(200).default(""),
    color: z.string().max(32).default("#56B4E9"),
  }),
]);
export type PlotAnnotation = z.infer<typeof annotationSchema>;

export const plotConfigSchema = z.object({
  chart: z.enum(CHART_TYPES).default("line"),
  x: z.string().nullable().default(null),
  series: z.array(seriesSchema).max(12).default([]),
  colorBy: z.string().nullable().default(null),
  agg: z.enum(AGGREGATIONS).default("none"),
  sort: z.enum(["none", "x-asc", "x-desc", "y-asc", "y-desc"]).default("none"),
  filter: filterSchema.nullable().default(null),
  xLog: z.boolean().default(false),
  yLogLeft: z.boolean().default(false),
  yLogRight: z.boolean().default(false),
  /** Null leaves the axis to the chart. Bar and area still include zero unless a min is set. */
  yMinLeft: z.number().nullable().default(null),
  yMaxLeft: z.number().nullable().default(null),
  yMinRight: z.number().nullable().default(null),
  yMaxRight: z.number().nullable().default(null),
  pieLabels: z.enum(["name", "percent", "both"]).default("name"),
  binCount: z.number().int().min(4).max(80).default(20),
  title: z.string().max(200).default(""),
  subtitle: z.string().max(300).default(""),
  xTitle: z.string().max(200).default(""),
  yTitleLeft: z.string().max(200).default(""),
  yTitleRight: z.string().max(200).default(""),
  legend: z.enum(LEGEND_POSITIONS).default("bottom"),
  grid: z.boolean().default(true),
  /** Major grid per axis. When omitted, both follow `grid`. */
  gridX: z.boolean().optional(),
  gridY: z.boolean().optional(),
  gridXMinor: z.boolean().default(false),
  gridYMinor: z.boolean().default(false),
  /** How many minor intervals AutoMinorLocator draws between major ticks. */
  minorDivisions: z.number().int().min(2).max(20).default(5),
  gridStyle: z.enum(LINE_STYLES).default("solid"),
  gridWidth: z.number().min(0.02).max(4).default(1),
  gridAlpha: z.number().min(0).max(1).default(0.5),
  minorGridStyle: z.enum(LINE_STYLES).default("dotted"),
  minorGridWidth: z.number().min(0.02).max(2).default(0.65),
  minorGridAlpha: z.number().min(0).max(1).default(0.4),
  xTicks: z.enum(["auto", "step", "max"]).default("auto"),
  xTickStep: z.number().positive().nullable().default(null),
  xTickMax: z.number().int().min(2).max(40).default(6),
  yTicks: z.enum(["auto", "step", "max"]).default("auto"),
  yTickStep: z.number().positive().nullable().default(null),
  yTickMax: z.number().int().min(2).max(40).default(5),
  xMinorTicks: z.boolean().default(false),
  yMinorTicks: z.boolean().default(false),
  xTickFormat: z.enum(["auto", "number", "compact", "percent"]).optional(),
  yTickFormat: z.enum(["auto", "number", "compact", "percent"]).optional(),
  xTickRotate: z.number().min(-90).max(90).default(0),
  yTickRotate: z.number().min(-90).max(90).default(0),
  boxNotch: z.boolean().default(false),
  boxOutliers: z.boolean().default(true),
  /** IQR multiple for the whiskers. Points outside are outliers. */
  boxWhisker: z.number().min(0).max(5).default(1.5),
  boxJitter: z.boolean().default(false),
  fontSize: z.number().min(8).max(18).default(11),
  tickFormat: z.enum(["auto", "number", "compact", "percent"]).default("auto"),
  palette: z.enum(PALETTE_IDS).default("okabe-ito"),
  despine: z.boolean().default(true),
  /** Category or series-name overrides from a click. */
  colors: z.record(z.string().max(32)).default({}),
  annotations: z.array(annotationSchema).max(24).default([]),
  preset: z.enum(FIGURE_PRESETS).default("icml"),
  figure: z.enum(FIGURE_SIZES).default("single"),
  widthIn: z.number().min(1).max(12).default(3.25),
  heightIn: z.number().min(1).max(12).default(2.4),
  fontFamily: z.enum(["serif", "sans"]).default("serif"),
});
export type PlotConfig = z.infer<typeof plotConfigSchema>;

export function defaultPlotConfig(): PlotConfig {
  return plotConfigSchema.parse({});
}

/**
 * Inches for a size token. Custom keeps the stored inches.
 * Conference names used to change this; a figure is just inches now.
 */
export function figureInches(_preset: FigurePreset, size: FigureSize, custom: { widthIn: number; heightIn: number }): { widthIn: number; heightIn: number } {
  if (size === "custom") return { widthIn: custom.widthIn, heightIn: custom.heightIn };
  if (size === "double") return { widthIn: 7, heightIn: 3.5 };
  if (size === "half") return { widthIn: 3.5, heightIn: 2.2 };
  return { widthIn: custom.widthIn > 0 ? custom.widthIn : 3.5, heightIn: custom.heightIn > 0 ? custom.heightIn : 2.6 };
}

/**
 * Major and minor grid stroke shared by the canvas and the matplotlib export.
 * When that axis draws a minor grid, the major line is at least as wide and
 * at least as opaque, so it cannot disappear behind the minor line.
 */
export function gridStroke(
  config: Pick<PlotConfig, "gridWidth" | "gridAlpha" | "minorGridWidth" | "minorGridAlpha" | "gridXMinor" | "gridYMinor">,
  axis: "x" | "y",
  minor: boolean,
): { width: number; alpha: number } {
  if (minor) return { width: config.minorGridWidth, alpha: config.minorGridAlpha };
  const minorOn = axis === "x" ? config.gridXMinor : config.gridYMinor;
  return {
    width: minorOn ? Math.max(config.gridWidth, config.minorGridWidth) : config.gridWidth,
    alpha: minorOn ? Math.max(config.gridAlpha, config.minorGridAlpha) : config.gridAlpha,
  };
}

/** Same dash the canvas and the matplotlib export draw. Dotted is wide enough to see. */
export const GRID_DASH: Record<(typeof LINE_STYLES)[number], number[] | null> = {
  solid: null,
  dashed: [6, 4],
  dotted: [2, 2],
  dashdot: [8, 3, 2, 3],
};

const LIGHT_INK = [28, 25, 21] as const;
const DARK_INK = [243, 238, 230] as const;
/** Extra opacity on a dark panel so the same width still clears the background. */
const DARK_GRID_BOOST = 0.15;

/**
 * Grid stroke the canvas and the matplotlib export both draw.
 * Dark panels add the same opacity boost on every line, so a minor grid that
 * is visible in the preview is visible in the export, and the major line stays
 * at least as strong.
 */
export function paintedGrid(
  config: Pick<PlotConfig, "gridWidth" | "gridAlpha" | "minorGridWidth" | "minorGridAlpha" | "gridXMinor" | "gridYMinor" | "gridStyle" | "minorGridStyle">,
  axis: "x" | "y",
  minor: boolean,
  dark: boolean,
): { width: number; alpha: number; red: number; green: number; blue: number; dash: number[] | null } {
  const stroke = gridStroke(config, axis, minor);
  const alpha = dark ? Math.min(0.92, Math.round((stroke.alpha + DARK_GRID_BOOST) * 100) / 100) : stroke.alpha;
  const [red, green, blue] = dark ? DARK_INK : LIGHT_INK;
  const style = minor ? config.minorGridStyle : config.gridStyle;
  return { width: stroke.width, alpha, red, green, blue, dash: GRID_DASH[style] ?? null };
}

/** Opacity of a ±std band. The canvas and the matplotlib export both use this. */
export const BAND_ALPHA = 0.22;

const SERIES_HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * The colour a series draws. An explicit colour wins. Otherwise the accent
 * palette, and a chart with one series, use the theme accent. Paper export
 * maps the dark-theme stand-in for black back to black.
 */
export function seriesColor(args: {
  palette: PaletteId;
  accent?: string;
  dark?: boolean;
  count: number;
  index: number;
  explicit?: string | null;
}): string {
  const explicit = args.explicit?.trim();
  if (explicit) return explicit;
  const dark = args.dark ?? false;
  const palette = paletteColors(args.palette, args.accent, dark);
  const accent = args.accent && SERIES_HEX.test(args.accent) ? args.accent : undefined;
  const useAccent = Boolean(accent) && args.index === 0 && (args.palette === "accent" || args.count === 1);
  let color = useAccent ? accent! : (palette[args.index % Math.max(palette.length, 1)] ?? "#0072B2");
  if (!dark && color.toUpperCase() === "#E6E6E6") color = "#000000";
  return color;
}

export function paletteColors(id: PaletteId, accent?: string, dark = false): string[] {
  if (id === "accent") {
    const first = accent && /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : "#5346d6";
    return [first, ...OKABE_ITO.filter((color) => color.toLowerCase() !== first.toLowerCase())];
  }
  if (id === "tableau10") return [...TABLEAU_10];
  if (id === "set2") return [...SET2];
  if (id === "viridis") return [...VIRIDIS];
  if (id === "rdbu") return [...RDBU];
  return OKABE_ITO.map((color) => (dark && color === "#000000" ? "#E6E6E6" : color));
}

export const PICKLE_REJECTION =
  "Pickle files can run code when they are opened. Ensemble will not load them. Export the frame as Parquet or Feather instead.";
