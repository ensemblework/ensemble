import type { PlotConfig } from "./plots.js";

/** A step that yields about four gaps, the same 1-2-2.5-5-10 snap the canvas uses. */
export function niceStep(span: number): number {
  const rough = Math.abs(span) / 4 || 1;
  const exp = Math.floor(Math.log10(rough));
  const base = 10 ** exp;
  const frac = rough / base;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10;
  return nice * base;
}

/** Snap an axis to a 1-2-2.5-5-10 step so the ends are not the raw data extent. */
export function niceBounds(min: number, max: number): { min: number; max: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (max < min) return niceBounds(max, min);
  const step = niceStep(max - min || Math.abs(max) || 1);
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const clean = (value: number) => Math.round(value / step) * step;
  return { min: clean(lo), max: hi <= lo ? clean(lo + step) : clean(hi) };
}

/**
 * Limits the value axis actually draws. Positive series start at zero, the
 * same rule the canvas uses, then snap to a nice step.
 */
export function snappedLimits(values: number[], explicitMin: number | null, explicitMax: number | null): { min: number; max: number } {
  const finite = values.filter((value) => Number.isFinite(value));
  const low = finite.length ? Math.min(...finite) : 0;
  const high = finite.length ? Math.max(...finite) : 1;
  if (explicitMin != null && explicitMax != null) return { min: explicitMin, max: Math.max(explicitMax, explicitMin + 1) };
  const min = explicitMin ?? (low >= 0 ? Math.min(0, low) : low);
  const max = explicitMax ?? high;
  const nice = niceBounds(min, Math.max(max, high));
  return { min: explicitMin ?? nice.min, max: explicitMax ?? nice.max };
}

function decade(value: number, direction: "floor" | "ceil"): number {
  if (!(value > 0)) return direction === "floor" ? -1 : 1;
  const exp = Math.log10(value);
  const snapped = direction === "floor" ? Math.floor(exp + 1e-9) : Math.ceil(exp - 1e-9);
  return snapped;
}

function pow10(exp: number): number {
  return Number((10 ** exp).toPrecision(12));
}

/** Powers of ten that cover the positive data, so both axes label 10ⁿ. */
export function logLimits(values: number[], explicitMin: number | null, explicitMax: number | null): { min: number; max: number; ticks: number[] } {
  const positive = values.filter((value) => value > 0 && Number.isFinite(value));
  const dataMin = explicitMin != null && explicitMin > 0 ? explicitMin : positive.length ? Math.min(...positive) : 1;
  const dataMax = explicitMax != null && explicitMax > 0 ? explicitMax : positive.length ? Math.max(...positive) : 10;
  let expLo = decade(Math.min(dataMin, dataMax), "floor");
  let expHi = decade(Math.max(dataMin, dataMax), "ceil");
  if (expHi <= expLo) expHi = expLo + 1;
  const ticks: number[] = [];
  for (let exp = expLo; exp <= expHi; exp += 1) ticks.push(pow10(exp));
  return { min: ticks[0]!, max: ticks[ticks.length - 1]!, ticks };
}

/**
 * Minor ticks split each major gap into equal steps of value. ECharts does the
 * same on a log axis (1000 → 10000 in 5 gives 2800, 4600, 6400, 8200), so the
 * export draws its minor grid where the canvas does.
 */
function between(ticks: number[], divisions: number): number[] {
  const count = Math.max(2, Math.round(divisions));
  const minors: number[] = [];
  for (let index = 0; index < ticks.length - 1; index += 1) {
    const start = ticks[index]!;
    const end = ticks[index + 1]!;
    for (let step = 1; step < count; step += 1) minors.push(start + (end - start) * (step / count));
  }
  return minors;
}

/** A step that yields at most `maxTicks` gaps, the same job as MaxNLocator. */
export function maxTickStep(span: number, maxTicks: number): number {
  const rough = Math.abs(span) / Math.max(2, maxTicks) || 1;
  const exp = Math.floor(Math.log10(rough));
  const base = 10 ** exp;
  const frac = rough / base;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nice * base;
}

export type AxisPlan = {
  scale: "log" | "linear";
  min: number;
  max: number;
  /** Major tick positions. */
  ticks: number[];
  /** Minor tick positions. Empty when the minor grid and minor ticks are off. */
  minorTicks: number[];
  format: "log10" | "compact" | "number" | "percent";
  /** Distance between major ticks on a linear axis. */
  step: number | null;
};

/**
 * The scale, limits, and ticks one axis draws. The canvas and the matplotlib
 * export both consume this, so a log axis stays log and the tick count matches.
 */
export function axisPlan(args: {
  values: number[];
  log: boolean;
  min: number | null;
  max: number | null;
  mode: PlotConfig["xTicks"];
  step: number | null;
  /** Used when mode is "max". */
  maxTicks?: number;
  format: PlotConfig["tickFormat"];
  minor: boolean;
  minorDivisions: number;
}): AxisPlan {
  if (args.log) {
    const limits = logLimits(args.values, args.min, args.max);
    return {
      scale: "log",
      min: limits.min,
      max: limits.max,
      ticks: limits.ticks,
      minorTicks: args.minor ? between(limits.ticks, args.minorDivisions) : [],
      format: "log10",
      step: null,
    };
  }
  const limits = snappedLimits(args.values, args.min, args.max);
  const span = limits.max - limits.min || 1;
  const step = args.mode === "step" && args.step ? args.step : args.mode === "max" ? maxTickStep(span, args.maxTicks ?? 5) : niceStep(span);
  const ticks: number[] = [];
  const start = Math.ceil((limits.min - step * 1e-8) / step) * step;
  for (let value = start; value <= limits.max + step * 1e-6; value += step) {
    ticks.push(Math.round(value / step) * step);
    if (ticks.length > 40) break;
  }
  if (!ticks.length) ticks.push(limits.min, limits.max);
  const compact = args.format === "compact" || (args.format === "auto" && ticks.some((value) => Math.abs(value) >= 1000));
  const format = args.format === "percent" ? "percent" : compact ? "compact" : "number";
  return {
    scale: "linear",
    min: limits.min,
    max: limits.max,
    ticks,
    minorTicks: args.minor ? between(ticks, args.minorDivisions) : [],
    format,
    step,
  };
}
