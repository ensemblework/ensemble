import type { Aggregation, PlotColumn, PlotConfig, PlotFilter } from "./plots.js";

export type Cell = string | number | null;
export type Row = Cell[];

export type Frame = {
  columns: PlotColumn[];
  rows: Row[];
};

const LTTB_TARGET = 4000;

export function columnIndex(frame: Frame, name: string | null | undefined): number {
  if (!name) return -1;
  return frame.columns.findIndex((column) => column.name === name);
}

export function asNumber(value: Cell): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
    const time = Date.parse(value);
    if (Number.isFinite(time)) return time;
  }
  return null;
}

function asLabel(value: Cell): string {
  if (value === null || value === "") return "(blank)";
  return String(value);
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};
const WEEKDAY_INDEX: Record<string, number> = {
  mon: 0, monday: 0, tue: 1, tues: 1, tuesday: 1, wed: 2, wednesday: 2,
  thu: 3, thur: 3, thurs: 3, thursday: 3, fri: 4, friday: 4, sat: 5, saturday: 5, sun: 6, sunday: 6,
};

/** Month, weekday, or calendar date. Null for ordinary categories and plain numbers. */
export function temporalRank(value: string | number): number | null {
  if (typeof value === "number") return null;
  const text = value.trim().toLowerCase();
  if (!text) return null;
  if (text in MONTH_INDEX) return MONTH_INDEX[text]!;
  if (text in WEEKDAY_INDEX) return 100 + WEEKDAY_INDEX[text]!;
  if (/^\d{4}-\d{2}-\d{2}/.test(text) || /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(text)) {
    const parsed = Date.parse(text.length > 10 && text[10] === "T" ? text : text.slice(0, 10));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function chronological(points: SeriesPoints["points"]): boolean {
  return points.length > 0 && points.every((point) => typeof point.x !== "number" && temporalRank(point.x) !== null);
}

/**
 * Sort is None keeps row order. Month names, weekdays, and dates still go
 * chronological, because alphabetical months are not an order anyone plotted.
 */
export function orderPoints(points: SeriesPoints["points"], sort: PlotConfig["sort"], xType?: PlotColumn["type"]): SeriesPoints["points"] {
  const next = [...points];
  const byTime = (a: SeriesPoints["points"][number], b: SeriesPoints["points"][number]) => (temporalRank(String(a.x)) ?? 0) - (temporalRank(String(b.x)) ?? 0);
  const byLabel = (a: SeriesPoints["points"][number], b: SeriesPoints["points"][number]) => {
    if (typeof a.x === "number" && typeof b.x === "number") return a.x - b.x;
    const ar = temporalRank(a.x);
    const br = temporalRank(b.x);
    if (ar !== null && br !== null) return ar - br;
    return String(a.x).localeCompare(String(b.x));
  };
  if (sort === "y-asc") return next.sort((a, b) => (a.y ?? 0) - (b.y ?? 0));
  if (sort === "y-desc") return next.sort((a, b) => (b.y ?? 0) - (a.y ?? 0));
  if (sort === "x-desc") return next.sort((a, b) => byLabel(b, a));
  if (sort === "x-asc") return next.sort(byLabel);
  if (xType === "date") return next.sort((a, b) => Number(a.x) - Number(b.x));
  if (chronological(next)) return next.sort(byTime);
  return next;
}

/** Bar and area axes include zero. Reference lines are kept inside the range. */
export function valueAxisBounds(args: {
  zero: boolean;
  values: number[];
  reference: number[];
  min: number | null;
  max: number | null;
  log?: boolean;
}): { min: number | null; max: number | null } {
  if (args.log) return { min: args.min, max: args.max };
  const values = args.values.filter((value) => Number.isFinite(value));
  const reference = args.reference.filter((value) => Number.isFinite(value));
  const dataMin = values.length ? Math.min(...values) : 0;
  const dataMax = values.length ? Math.max(...values) : 0;
  const low = Math.min(dataMin, ...reference, dataMin);
  const high = Math.max(dataMax, ...reference, dataMax);
  const span = high - low || Math.abs(high) || 1;
  let min = args.min;
  let max = args.max;
  if (min === null && args.zero) min = Math.min(0, low);
  else if (min === null && reference.some((value) => value < dataMin)) min = low - span * 0.08;
  if (max === null && reference.some((value) => value > dataMax)) max = high + span * 0.08;
  if (min !== null && max !== null && max <= min) max = min + 1;
  return { min, max };
}

export function applyFilter(frame: Frame, filter: PlotFilter | null): Frame {
  if (!filter) return frame;
  const index = columnIndex(frame, filter.column);
  if (index < 0) return frame;
  const needle = filter.value;
  const rows = frame.rows.filter((row) => {
    const value = row[index];
    if (filter.op === "contains") return asLabel(value).toLowerCase().includes(needle.toLowerCase());
    if (filter.op === "eq") return asLabel(value) === needle || (asNumber(value) !== null && asNumber(value) === Number(needle));
    const numeric = asNumber(value);
    const limit = Number(needle);
    if (numeric === null || !Number.isFinite(limit)) return false;
    return filter.op === "gt" ? numeric > limit : numeric < limit;
  });
  return { columns: frame.columns, rows };
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! * (hi - pos) + sorted[hi]! * (pos - lo);
}

export function aggregate(values: number[], how: Aggregation): number | null {
  if (how === "count") return values.length;
  if (!values.length) return null;
  if (how === "sum") return values.reduce((sum, value) => sum + value, 0);
  if (how === "mean" || how === "none") return values.reduce((sum, value) => sum + value, 0) / values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export type SeriesPoints = {
  name: string;
  axis: "left" | "right";
  points: Array<{ x: string | number; y: number | null; size?: number; error?: number }>;
};

function groupKey(value: Cell, type: PlotColumn["type"] | undefined): string | number {
  if (type === "number" || type === "date") {
    const numeric = asNumber(value);
    if (numeric !== null) return type === "date" ? numeric : numeric;
  }
  return asLabel(value);
}

/** Rows in, one or more series out. Colour-by splits a single Y into series. */
export function buildSeries(frame: Frame, config: PlotConfig): SeriesPoints[] {
  const filtered = applyFilter(frame, config.filter);
  const xIndex = columnIndex(filtered, config.x);
  const xType = xIndex >= 0 ? filtered.columns[xIndex]?.type : undefined;
  const colorIndex = columnIndex(filtered, config.colorBy);
  const pointwise = config.chart === "scatter" || config.chart === "bubble";
  const encodings = config.series.length ? config.series : [];
  const sizeName = bubbleSizeColumn(config);
  const buckets = new Map<string, { name: string; axis: "left" | "right"; x: string | number; ys: number[]; size?: number; error?: number }>();

  const push = (name: string, axis: "left" | "right", x: string | number, y: number | null, size?: number, error?: number) => {
    if (y === null) return;
    const key = pointwise ? `${name}\0${buckets.size}` : `${name}\0${String(x)}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.ys.push(y);
      if (size !== undefined) existing.size = size;
      if (error !== undefined) existing.error = error;
      return;
    }
    buckets.set(key, { name, axis, x, ys: [y], size, error });
  };

  filtered.rows.forEach((row, rowIndex) => {
    const xValue = xIndex >= 0 ? groupKey(row[xIndex] ?? null, xType) : rowIndex;
    const color = colorIndex >= 0 ? asLabel(row[colorIndex] ?? null) : null;
    for (const series of encodings) {
      if (sizeName && series.y === sizeName) continue;
      const yIndex = columnIndex(filtered, series.y);
      if (yIndex < 0) continue;
      const y = asNumber(row[yIndex] ?? null);
      const name = color ? `${series.y} · ${color}` : series.y;
      const size = sizeName ? asNumber(row[columnIndex(filtered, sizeName)] ?? null) ?? undefined : undefined;
      const err = series.error ? asNumber(row[columnIndex(filtered, series.error)] ?? null) ?? undefined : undefined;
      push(name, series.axis, xValue, y, size ?? undefined, err ?? undefined);
    }
  });

  const how = config.agg;
  const grouped = new Map<string, SeriesPoints>();
  for (const bucket of buckets.values()) {
    const y = how === "none" && bucket.ys.length === 1 ? bucket.ys[0]! : aggregate(bucket.ys, how === "none" ? "mean" : how);
    const series = grouped.get(bucket.name) ?? { name: bucket.name, axis: bucket.axis, points: [] };
    series.points.push({ x: bucket.x, y, size: bucket.size, error: bucket.error });
    grouped.set(bucket.name, series);
  }
  let list = [...grouped.values()];
  for (const series of list) series.points = orderPoints(series.points, config.sort, xType);
  if (config.chart === "pie" || config.chart === "donut") {
    list = list.slice(0, 4);
    for (const series of list) {
      if (series.points.length <= 8) continue;
      const sorted = [...series.points].sort((a, b) => (b.y ?? 0) - (a.y ?? 0));
      const head = sorted.slice(0, 7);
      const rest = sorted.slice(7).reduce((sum, point) => sum + (point.y ?? 0), 0);
      series.points = [...head, { x: "Other", y: rest }];
    }
  }
  return list.slice(0, 12);
}

export type PreparedPlot = { series: SeriesPoints[]; warnings: string[] };

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Series the chart can actually draw. A category, an empty column, or a
 * non-positive value on a log axis is skipped. One bad series must not
 * wipe the axes of the series that are fine.
 */
export function prepareSeries(frame: Frame, config: PlotConfig): PreparedPlot {
  const warnings: string[] = [];
  const built = buildSeries(frame, config);
  const kept: SeriesPoints[] = [];
  const noted = new Set<string>();
  const note = (name: string, message: string) => {
    if (noted.has(name)) return;
    noted.add(name);
    warnings.push(message);
  };
  const classAxis = config.chart === "heatmap" && config.series.length > 1 ? config.series[0]?.y : null;
  for (const encoding of config.series) {
    const column = frame.columns.find((item) => item.name === encoding.y);
    const matches = built.filter((series) => series.name === encoding.y || series.name.startsWith(`${encoding.y} ·`));
    if (encoding.y === classAxis) continue;
    if (column && column.type !== "number") {
      note(encoding.y, `${encoding.y} is a category, hidden on this chart.`);
      continue;
    }
    if (!matches.length) {
      note(encoding.y, `${encoding.y} has no numeric values, so it is hidden.`);
      continue;
    }
    const yLog = encoding.axis === "right" ? config.yLogRight : config.yLogLeft;
    for (const series of matches) {
      let nonPositive = 0;
      const points = series.points.filter((point) => {
        if (!finite(point.y)) return false;
        const xBad = config.xLog && typeof point.x === "number" && !(point.x > 0);
        const yBad = yLog && !(point.y > 0);
        if (xBad || yBad) {
          nonPositive += 1;
          return false;
        }
        return true;
      });
      if (nonPositive > 0) {
        note(
          encoding.y,
          points.length
            ? `${encoding.y} has values ≤ 0, those points are hidden on the log axis`
            : `${encoding.y} has values ≤ 0, hidden on log axis`,
        );
      }
      if (!points.length && nonPositive === 0) note(encoding.y, `${encoding.y} has no numeric values, so it is hidden.`);
      if (points.length) kept.push({ ...series, points });
    }
  }
  return { series: kept.slice(0, 12), warnings };
}

/** Bubble size is the second series column. It is not drawn as its own series. */
export function bubbleSizeColumn(config: PlotConfig): string | null {
  if (config.chart !== "bubble") return null;
  return config.series[1]?.y ?? null;
}

export function lttb<T extends { x: string | number; y: number | null }>(points: T[], threshold = LTTB_TARGET): T[] {
  const usable = points.filter((point): point is T & { y: number } => point.y !== null);
  if (usable.length <= threshold || threshold < 3) return points;
  const sampled: Array<T & { y: number }> = [usable[0]!];
  const bucket = (usable.length - 2) / (threshold - 2);
  let prev = 0;
  for (let i = 0; i < threshold - 2; i++) {
    const start = Math.floor((i + 1) * bucket) + 1;
    const end = Math.min(usable.length - 1, Math.floor((i + 2) * bucket) + 1);
    const nextStart = Math.floor((i + 1) * bucket) + 1;
    let avgX = 0;
    let avgY = 0;
    let count = 0;
    for (let j = nextStart; j < Math.min(usable.length, Math.floor((i + 2) * bucket) + 1); j++) {
      avgX += j;
      avgY += usable[j]!.y;
      count++;
    }
    avgX = count ? avgX / count : end;
    avgY = count ? avgY / count : usable[end]?.y ?? 0;
    const rangeStart = Math.floor(i * bucket) + 1;
    const rangeEnd = Math.floor((i + 1) * bucket) + 1;
    let maxArea = -1;
    let pick = rangeStart;
    const pointA = usable[prev]!;
    for (let j = rangeStart; j < rangeEnd && j < usable.length - 1; j++) {
      const area = Math.abs((prev - avgX) * (usable[j]!.y - pointA.y) - (prev - j) * (avgY - pointA.y));
      if (area > maxArea) {
        maxArea = area;
        pick = j;
      }
    }
    sampled.push(usable[pick]!);
    prev = pick;
    void start;
  }
  sampled.push(usable[usable.length - 1]!);
  return sampled;
}

export function histogram(values: number[], bins: number): Array<{ x: string; y: number }> {
  if (!values.length) return [];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const width = hi === lo ? 1 : (hi - lo) / bins;
  const counts = new Array<number>(bins).fill(0);
  for (const value of values) {
    const index = Math.min(bins - 1, Math.max(0, Math.floor((value - lo) / width)));
    counts[index]!++;
  }
  return counts.map((count, index) => {
    const from = lo + index * width;
    const to = from + width;
    const label = `${trim(from)}–${trim(to)}`;
    return { x: label, y: count };
  });
}

function trim(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1000 || (abs > 0 && abs < 0.01)) return value.toExponential(1);
  return String(Math.round(value * 100) / 100);
}

export type BoxStats = {
  name: string;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  values: number[];
  outliers: number[];
  whiskerLow: number;
  whiskerHigh: number;
  notchLow: number;
  notchHigh: number;
};

export function boxStats(name: string, values: number[], whisker = 1.5): BoxStats | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const median = quantile(sorted, 0.5);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const span = Math.max(0, whisker) * iqr;
  const lowFence = q1 - span;
  const highFence = q3 + span;
  const inside = sorted.filter((value) => value >= lowFence && value <= highFence);
  const whiskerLow = inside[0] ?? sorted[0]!;
  const whiskerHigh = inside[inside.length - 1] ?? sorted[sorted.length - 1]!;
  const notch = sorted.length > 0 ? (1.57 * iqr) / Math.sqrt(sorted.length) : 0;
  return {
    name,
    min: sorted[0]!,
    q1,
    median,
    q3,
    max: sorted[sorted.length - 1]!,
    values: sorted,
    outliers: sorted.filter((value) => value < lowFence || value > highFence),
    whiskerLow,
    whiskerHigh,
    notchLow: median - notch,
    notchHigh: median + notch,
  };
}

/** Gaussian KDE sampled at `samples` points. */
export function kde(values: number[], samples = 40): Array<{ x: number; y: number }> {
  if (!values.length) return [];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const sigma = Math.max(span / 20, deviation(values) * 0.4 || span / 10);
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < samples; i++) {
    const x = lo + (span * i) / (samples - 1);
    let density = 0;
    for (const value of values) {
      const z = (x - value) / sigma;
      density += Math.exp(-0.5 * z * z);
    }
    out.push({ x, y: density / (values.length * sigma * Math.sqrt(2 * Math.PI)) });
  }
  return out;
}

function deviation(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function numericColumn(frame: Frame, name: string | null): number[] {
  const index = columnIndex(frame, name);
  if (index < 0) return [];
  const out: number[] = [];
  for (const row of frame.rows) {
    const value = asNumber(row[index] ?? null);
    if (value !== null) out.push(value);
  }
  return out;
}

export function waterfallSteps(points: Array<{ x: string | number; y: number | null }>): Array<{ x: string; base: number; delta: number; total: number }> {
  let running = 0;
  return points.map((point) => {
    const delta = point.y ?? 0;
    const base = delta >= 0 ? running : running + delta;
    running += delta;
    return { x: String(point.x), base, delta, total: running };
  });
}

/** Plotted rows for CSV export: x plus each series. */
export function plottedRows(series: SeriesPoints[]): { columns: string[]; rows: Array<Array<string | number | null>> } {
  const columns = ["x", ...series.map((item) => item.name)];
  const keys = new Map<string, Array<string | number | null>>();
  for (const item of series) {
    for (const point of item.points) {
      const key = String(point.x);
      const row = keys.get(key) ?? [point.x, ...series.map(() => null)];
      const index = series.indexOf(item) + 1;
      row[index] = point.y;
      keys.set(key, row);
    }
  }
  return { columns, rows: [...keys.values()] };
}
