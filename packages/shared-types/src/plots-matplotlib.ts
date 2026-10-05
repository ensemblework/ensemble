import { axisPlan, niceBounds, type AxisPlan } from "./plots-axis.js";
import { BAND_ALPHA, defaultPlotConfig, figureInches, paintedGrid, paletteColors, seriesColor, type PaletteId, type PlotConfig } from "./plots.js";
import type { PlotColumn } from "./plots.js";

const DASH = { solid: "solid", dashed: "dashed", dotted: "dotted", dashdot: "dashdot" } as const;

function py(value: unknown): string {
  return JSON.stringify(value);
}

function num(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Math.round(value * 1e6) / 1e6);
}

/**
 * Runnable matplotlib that loads the dataset by the name the user sees.
 * The sandbox resolves that name. No filesystem path appears in the script.
 */
export type SeedSummary = {
  x: string;
  y: string;
  seed: string;
  /** Category column whose values become series names. Null aggregates the whole column. */
  group: string | null;
  series: Array<{ name: string; group: string; error: string }>;
};

export function matplotlibSource(args: {
  datasetName: string;
  columns: PlotColumn[];
  config: PlotConfig;
  accent?: string;
  /** Dark panel. The export uses the same ink and the same grid boost as the canvas. */
  dark?: boolean;
  /** Plotted rows, including columns derived before the chart is drawn. */
  rows?: Array<Array<string | number | null>>;
  /** Names for `rows`, in order. Defaults to `columns` when the frame matches that list. */
  rowColumns?: string[];
  /** Rebuild seed means in the script so a derived series is not read off the raw file. */
  summary?: SeedSummary | null;
}): string {
  const { config } = args;
  const inches = figureInches(config.preset, config.figure, config);
  const colors = paletteColors(config.palette, args.accent, false).map((color) => (color === "#E6E6E6" ? "#000000" : color));
  const drawn = config.series.length;
  const font = config.fontFamily === "sans" ? "DejaVu Sans" : "Liberation Serif";
  const family = config.fontFamily === "sans" ? "sans-serif" : "serif";
  const lines: string[] = [
    "from ensemble_plots import load, save, apply_style",
    "import matplotlib.pyplot as plt",
    "import pandas as pd",
    "from matplotlib.ticker import AutoLocator, AutoMinorLocator, FixedLocator, FuncFormatter, LogFormatterMathtext, MaxNLocator, MultipleLocator, NullLocator",
    "",
    "def _compact(value, _pos):",
    "    sign = \"-\" if value < 0 else \"\"",
    "    mag = abs(value)",
    "    if mag >= 1_000_000:",
    "        return f\"{sign}{mag / 1_000_000:.3g}M\"",
    "    if mag >= 1000:",
    "        return f\"{sign}{mag / 1000:.3g}k\"",
    "    return f\"{value:.3g}\"",
    "",
    "def _tag(axis, value, text, color):",
    "    if not text:",
    "        return",
    "    axis.annotate(",
    "        text,",
    "        xy=(1, value),",
    "        xycoords=axis.get_yaxis_transform(),",
    "        xytext=(-4, 2),",
    "        textcoords=\"offset points\",",
    "        ha=\"right\",",
    "        va=\"bottom\",",
    "        fontsize=8,",
    "        color=color,",
    "        clip_on=False,",
    "        annotation_clip=False,",
    "        bbox={\"facecolor\": \"white\", \"edgecolor\": \"none\", \"pad\": 0.35, \"alpha\": 0.92},",
    "    )",
    "",
    "def _temporal(value):",
    "    text = str(value).strip()",
    "    low = text.lower()",
    "    months = {\"jan\": 0, \"january\": 0, \"feb\": 1, \"february\": 1, \"mar\": 2, \"march\": 2, \"apr\": 3, \"april\": 3, \"may\": 4, \"jun\": 5, \"june\": 5, \"jul\": 6, \"july\": 6, \"aug\": 7, \"august\": 7, \"sep\": 8, \"sept\": 8, \"september\": 8, \"oct\": 9, \"october\": 9, \"nov\": 10, \"november\": 10, \"dec\": 11, \"december\": 11}",
    "    days = {\"mon\": 0, \"monday\": 0, \"tue\": 1, \"tues\": 1, \"tuesday\": 1, \"wed\": 2, \"wednesday\": 2, \"thu\": 3, \"thur\": 3, \"thurs\": 3, \"thursday\": 3, \"fri\": 4, \"friday\": 4, \"sat\": 5, \"saturday\": 5, \"sun\": 6, \"sunday\": 6}",
    "    if low in months:",
    "        return months[low]",
    "    if low in days:",
    "        return 100 + days[low]",
    "    if len(text) >= 10 and text[4] == \"-\" and text[7] == \"-\":",
    "        from datetime import datetime",
    "        try:",
    "            return datetime.strptime(text[:10], \"%Y-%m-%d\").timestamp()",
    "        except ValueError:",
    "            return None",
    "    return None",
    "",
    "def _arrange(frame, column, how):",
    "    if not column or column not in frame.columns or how in (\"y-asc\", \"y-desc\"):",
    "        return frame",
    "    ranks = frame[column].map(_temporal)",
    "    if how == \"none\":",
    "        if bool(ranks.notna().all()):",
    "            return frame.assign(_ord=ranks).sort_values(\"_ord\", kind=\"mergesort\").drop(columns=\"_ord\")",
    "        return frame",
    "    if how == \"x-asc\":",
    "        if bool(ranks.notna().all()):",
    "            return frame.assign(_ord=ranks).sort_values(\"_ord\", kind=\"mergesort\").drop(columns=\"_ord\")",
    "        return frame.sort_values(column, kind=\"mergesort\")",
    "    if how == \"x-desc\":",
    "        if bool(ranks.notna().all()):",
    "            return frame.assign(_ord=ranks).sort_values(\"_ord\", ascending=False, kind=\"mergesort\").drop(columns=\"_ord\")",
    "        return frame.sort_values(column, ascending=False, kind=\"mergesort\")",
    "    return frame",
    "",
    `apply_style(${py(font)}, ${py(family)}, ${num(config.fontSize)})`,
    "plt.rcParams[\"axes.unicode_minus\"] = False",
    `df = load(${py(args.datasetName)})`,
    `df = _arrange(df, ${config.x ? py(config.x) : "None"}, ${py(config.sort)})`,
    `fig, ax = plt.subplots(figsize=(${num(inches.widthIn)}, ${num(inches.heightIn)}), layout=\"constrained\")`,
  ];
  if (args.summary) emitSeedSummary(lines, args.summary);
  const right = config.series.some((series) => series.axis === "right");
  if (right) {
    lines.push("ax_right = ax.twinx()");
    lines.push("ax_right.spines['right'].set_visible(True)");
    lines.push("ax_right.spines['left'].set_visible(False)");
    lines.push("ax_right.spines['top'].set_visible(False)");
  }
  const x = config.x;
  if (config.chart === "box" && config.series[0]) {
    const y = config.series[0].y;
    const group = x ? py(x) : "None";
    lines.push(`# Box plot. Points ≤ 0 are dropped when an axis is logarithmic.`);
    lines.push(`_y = pd.to_numeric(df[${py(y)}], errors="coerce")`);
    lines.push(x ? `_g = df[${group}].astype(str)` : `_g = pd.Series(["all"] * len(df), index=df.index)`);
    if (config.yLogLeft) lines.push(`_y = _y.where(_y > 0)`);
    if (config.xLog && x) lines.push(`_g = _g.where(pd.to_numeric(df[${py(x)}], errors="coerce") > 0)`);
    if (config.yLogLeft || config.xLog) lines.push(`# ${y} values ≤ 0 are hidden on the log axis`);
    lines.push("_order = list(dict.fromkeys(str(item) for item in _g.dropna()))");
    lines.push("_data = [ _y[_g == name].dropna().to_numpy() for name in _order ]");
    lines.push(`_drawn = ax.boxplot(_data, tick_labels=_order, notch=${config.boxNotch ? "True" : "False"}, whis=${num(config.boxWhisker)}, showfliers=${config.boxOutliers ? "True" : "False"})`);
    lines.push("for _box in _drawn['boxes']:");
    lines.push("    _box.set_linewidth(1)");
    lines.push(`    _box.set_color(${py(colors[0]!)})`);
    paintBox(lines, Boolean(args.dark));
    if (config.boxJitter) {
      lines.push("import numpy as np");
      lines.push("_rng = np.random.default_rng(0)");
      lines.push("for _i, _vals in enumerate(_data, start=1):");
      lines.push("    if len(_vals) == 0:");
      lines.push("        continue");
      lines.push("    _jx = _i + (_rng.random(len(_vals)) - 0.5) * 0.16");
      lines.push(`    ax.scatter(_jx, _vals, s=10, color=${py(colors[0]!)}, alpha=0.55, zorder=3, linewidths=0)`);
    }
  }
  config.series.forEach((series, index) => {
    if (config.chart === "box") return;
    const color = seriesColor({
      palette: config.palette,
      accent: args.accent,
      dark: false,
      count: drawn,
      index,
      explicit: series.color || config.colors?.[series.y],
    });
    const axis = series.axis === "right" && right ? "ax_right" : "ax";
    const dash = DASH[series.lineStyle ?? "solid"];
    const width = series.width ?? 1.25;
    const y = series.y;
    const columnType = args.columns.find((column) => column.name === y)?.type;
    if (columnType && columnType !== "number") {
      lines.push(`# ${y} is a category, hidden on this chart.`);
      return;
    }
    const mark = config.chart === "combo" ? series.mark ?? (index === config.series.length - 1 ? "line" : "bar") : config.chart;
    lines.push(`_s = df.dropna(subset=[${py(y)}])`);
    if (x) lines.push(`_x = _s[${py(x)}]`);
    else lines.push("_x = pd.Series(range(len(_s)), index=_s.index)");
    lines.push(`_y = pd.to_numeric(_s[${py(y)}], errors="coerce")`);
    const yLog = series.axis === "right" ? config.yLogRight : config.yLogLeft;
    lines.push("_keep = _y.notna()");
    if (yLog) {
      lines.push("_keep &= _y > 0");
      lines.push(`# ${y} values ≤ 0 are hidden on the log axis`);
    }
    if (config.xLog && x) {
      lines.push(`_x = pd.to_numeric(_x, errors="coerce")`);
      lines.push("_keep &= _x.notna() & (_x > 0)");
      lines.push("# non-positive X values are hidden on the log axis");
    }
    lines.push("_x = _x[_keep].to_numpy()");
    lines.push("_y = _y[_keep].to_numpy()");
    if (mark === "bar" || mark === "stacked-bar" || mark === "bar-horizontal" || mark === "stacked-bar-horizontal" || mark === "stacked-bar-100" || mark === "waterfall") {
      const horizontal = mark === "bar-horizontal" || mark === "stacked-bar-horizontal";
      lines.push(
        horizontal
          ? `${axis}.barh(_x, _y, color=${py(color)}, alpha=${num(series.opacity ?? 0.9)}, label=${py(y)})`
          : `${axis}.bar(_x, _y, color=${py(color)}, alpha=${num(series.opacity ?? 0.9)}, label=${py(y)})`,
      );
    } else if (mark === "scatter" || mark === "bubble") {
      lines.push(`${axis}.scatter(_x, _y, color=${py(color)}, alpha=${num(series.opacity ?? 0.85)}, label=${py(y)})`);
    } else if (mark === "step") {
      lines.push(`${axis}.step(_x, _y, where="post", color=${py(color)}, linewidth=${num(width)}, linestyle=${py(dash)}, label=${py(y)})`);
    } else {
      lines.push(`${axis}.plot(_x, _y, color=${py(color)}, linewidth=${num(width)}, linestyle=${py(dash)}, label=${py(y)})`);
      if (mark === "area" || mark === "stacked-area") lines.push(`${axis}.fill_between(_x, _y, color=${py(color)}, alpha=${num(BAND_ALPHA)})`);
    }
    if (series.error) {
      lines.push(`_e = pd.to_numeric(_s[${py(series.error)}], errors="coerce")[_keep].to_numpy()`);
      if (series.errorKind === "band") lines.push(`${axis}.fill_between(_x, _y - _e, _y + _e, color=${py(color)}, alpha=${num(BAND_ALPHA)}, linewidth=0, zorder=1)`);
      else lines.push(`${axis}.errorbar(_x, _y, yerr=_e, fmt="none", ecolor=${py(color)}, elinewidth=0.8, capsize=2, zorder=3)`);
    }
  });
  if (config.chart === "histogram" && config.series[0]) {
    lines.push(`ax.clear()`);
    lines.push(`ax.hist(pd.to_numeric(df[${py(config.series[0].y)}], errors="coerce").dropna(), bins=${config.binCount}, color=${py(colors[0]!)}, edgecolor="white")`);
  }
  if ((config.chart === "pie" || config.chart === "donut") && config.x && config.series[0]) {
    const wedge = config.chart === "donut" ? ", wedgeprops={'width': 0.45}" : "";
    lines.push("ax.clear()");
    lines.push(`_p = df.groupby(${py(config.x)}, sort=False)[${py(config.series[0].y)}].sum()`);
    lines.push(`ax.pie(_p.values, labels=_p.index.astype(str), colors=${py(colors)}${wedge})`);
    lines.push("ax.set_aspect('equal')");
  }
  for (const note of config.annotations) {
    const color = note.color;
    if (note.kind === "hline") {
      const axis = note.axis === "right" && right ? "ax_right" : "ax";
      lines.push(`${axis}.axhline(${num(note.y)}, color=${py(color)}, linestyle=${py(DASH[note.style])}, linewidth=0.9, zorder=3)`);
      lines.push(`_tag(${axis}, ${num(note.y)}, ${py(note.label || "")}, ${py(color)})`);
    } else if (note.kind === "vline") {
      const xValue = typeof note.x === "number" ? num(note.x) : py(String(note.x));
      lines.push(`ax.axvline(${xValue}, color=${py(color)}, linestyle=${py(DASH[note.style])}, linewidth=0.9, zorder=3)`);
      if (note.label) {
        lines.push(`ax.annotate(${py(note.label)}, xy=(${xValue}, 1), xycoords=ax.get_xaxis_transform(), xytext=(3, -2), textcoords="offset points", ha="left", va="top", fontsize=8, color=${py(color)}, clip_on=False, bbox={"facecolor": "white", "edgecolor": "none", "pad": 0.35, "alpha": 0.92})`);
      }
    } else if (note.kind === "linear") {
      const axis = note.axis === "right" && right ? "ax_right" : "ax";
      const label = note.label || `y = ${note.m}x + ${note.c}`;
      lines.push(`_xs = ax.get_xlim()`);
      lines.push(`${axis}.plot(_xs, [${num(note.m)} * _xs[0] + ${num(note.c)}, ${num(note.m)} * _xs[1] + ${num(note.c)}], color=${py(color)}, linestyle=${py(DASH[note.style])}, linewidth=0.9, zorder=3)`);
      lines.push(`_tag(${axis}, ${num(note.m)} * _xs[1] + ${num(note.c)}, ${py(label)}, ${py(color)})`);
    } else if (note.kind === "band") {
      const legend = note.label ? `, label=${py(note.label)}` : "";
      if (note.orientation === "horizontal") lines.push(`ax.axhspan(${num(note.from)}, ${num(note.to)}, color=${py(color)}, alpha=0.12${legend})`);
      else lines.push(`ax.axvspan(${num(note.from)}, ${num(note.to)}, color=${py(color)}, alpha=0.12${legend})`);
    }
  }
  if (config.title) lines.push(`ax.set_title(${py(config.title)}, fontsize=10)`);
  if (config.xTitle || x) lines.push(`ax.set_xlabel(${py(config.xTitle || x || "")})`);
  if (config.yTitleLeft || config.series[0]) lines.push(`ax.set_ylabel(${py(config.yTitleLeft || config.series.find((series) => series.axis !== "right")?.y || "")})`);
  if (right) lines.push(`ax_right.set_ylabel(${py(config.yTitleRight || config.series.find((series) => series.axis === "right")?.y || "")})`);
  const dark = Boolean(args.dark);
  const names = args.rowColumns?.length ? args.rowColumns : args.columns.map((column) => column.name);
  const cartesian = config.chart !== "pie" && config.chart !== "donut";
  const horizontal = config.chart === "bar-horizontal" || config.chart === "stacked-bar-horizontal";
  const xPlan = cartesian && !horizontal ? axisPlanFor(config, "x", names, args.columns, args.rows, config.xLog, null, null) : null;
  const yPlan = cartesian && !horizontal ? axisPlanFor(config, "y", names, args.columns, args.rows, config.yLogLeft, config.yMinLeft, config.yMaxLeft) : null;
  const yPlanRight = cartesian && !horizontal ? axisPlanFor(config, "y", names, args.columns, args.rows, config.yLogRight, config.yMinRight, config.yMaxRight, "right") : null;
  if (cartesian) {
    emitScale(lines, "ax", xPlan, "x", config.xLog);
    emitScale(lines, "ax", yPlan, "y", config.yLogLeft);
    if (right) emitScale(lines, "ax_right", yPlanRight, "y", config.yLogRight);
    emitTicks(lines, "ax.xaxis", "x", config, xPlan, xColumnNumeric(args.columns, x) || !x || config.xLog, config.xLog);
    emitTicks(lines, "ax.yaxis", "y", config, yPlan, true, config.yLogLeft);
    if (right) emitTicks(lines, "ax_right.yaxis", "y", config, yPlanRight, true, config.yLogRight);
    emitGrid(lines, "ax", config, dark);
    paintFigure(lines, dark, right ? ["ax", "ax_right"] : ["ax"]);
  }
  const zeroMark = (mark: string) => ["bar", "stacked-bar", "stacked-bar-100", "bar-horizontal", "stacked-bar-horizontal", "area", "stacked-area", "waterfall"].includes(mark);
  const zeroLeft = config.chart === "combo"
    ? config.series.some((series, index) => series.axis !== "right" && zeroMark(series.mark ?? (index === config.series.length - 1 ? "line" : "bar")))
    : zeroMark(config.chart) || config.chart === "histogram";
  const zeroRight = config.chart === "combo" && config.series.some((series, index) => series.axis === "right" && zeroMark(series.mark ?? (index === config.series.length - 1 ? "line" : "bar")));
  const refsOn = (side: "left" | "right") => config.annotations.flatMap((note) => note.kind === "hline" && (note.axis === "right" ? "right" : "left") === side ? [note.y] : []);
  const ylim = (axisName: string, zero: boolean, refs: number[]) => {
    if (!zero && !refs.length) return;
    lines.push(`_lo, _hi = ${axisName}.get_ylim()`);
    if (zero) lines.push("_lo = min(0, _lo)");
    for (const y of refs) {
      lines.push(`_lo = min(_lo, ${num(y)})`);
      lines.push(`_hi = max(_hi, ${num(y)})`);
    }
    lines.push("_span = (_hi - _lo) or 1");
    lines.push(`${axisName}.set_ylim(_lo if ${zero ? "True" : "False"} else _lo - _span * 0.06, _hi + _span * 0.08)`);
  };
  // A plan already includes zero and reference lines. The pad here would move the export off the preview.
  if (!yPlan && !config.yLogLeft) ylim("ax", zeroLeft, refsOn("left"));
  if (right && !yPlanRight && !config.yLogRight) ylim("ax_right", zeroRight, refsOn("right"));
  lines.push("handles, labels = ax.get_legend_handles_labels()");
  if (right) {
    lines.push("h2, l2 = ax_right.get_legend_handles_labels()");
    lines.push("handles += h2");
    lines.push("labels += l2");
  }
  lines.push("pairs = [(handle, label) for handle, label in zip(handles, labels) if label]");
  if (config.legend !== "none") {
    const legendLoc =
      config.legend === "top" ? "outside upper center" : config.legend === "left" ? "outside center left" : config.legend === "right" ? "outside center right" : "outside lower center";
    const ncol = config.legend === "left" || config.legend === "right" ? "1" : "min(3, len(pairs))";
    lines.push("if pairs:");
    lines.push("    _handles, _labels = zip(*pairs)");
    lines.push(`    fig.legend(_handles, _labels, loc=${py(legendLoc)}, ncol=${ncol}, frameon=False, fontsize=8, borderaxespad=0.2${legendInk(Boolean(args.dark))})`);
  }
  lines.push("save(fig)");
  lines.push("");
  return lines.join("\n");
}

function xColumnNumeric(columns: PlotColumn[], name: string | null): boolean {
  if (!name) return false;
  const column = columns.find((item) => item.name === name);
  return column?.type === "number" || column?.type === "date";
}

function formatterFor(format: AxisPlan["format"]): string {
  if (format === "log10") return "LogFormatterMathtext()";
  if (format === "percent") return 'FuncFormatter(lambda value, _pos: f"{value * 100:.4g}%")';
  if (format === "compact") return "FuncFormatter(_compact)";
  return 'FuncFormatter(lambda value, _pos: f"{value:.6g}")';
}

function locatorList(values: number[]): string {
  return `[${values.map((value) => num(value)).join(", ")}]`;
}

/** One value per seed, then the mean and sample std the canvas already drew. */
function emitSeedSummary(lines: string[], summary: SeedSummary): void {
  lines.push(`_raw = df.copy()`);
  lines.push(`_raw["_y"] = pd.to_numeric(_raw[${py(summary.y)}], errors="coerce")`);
  lines.push(`_raw = _raw.dropna(subset=[${py(summary.x)}, "_y"])`);
  const seedKeys = summary.group ? [summary.group, summary.x, summary.seed] : [summary.x, summary.seed];
  const meanKeys = summary.group ? [summary.group, summary.x] : [summary.x];
  lines.push(`_one = _raw.groupby(${py(seedKeys)}, sort=False)["_y"].last().reset_index()`);
  lines.push(`_grouped = _one.groupby(${py(meanKeys)}, sort=False)["_y"]`);
  lines.push(`_agg = _grouped.agg(mean="mean", std=lambda values: values.std(ddof=1)).reset_index()`);
  lines.push(`_agg["std"] = _agg["std"].fillna(0)`);
  if (!summary.group) {
    const series = summary.series[0];
    if (!series) return;
    lines.push(`df = _agg.rename(columns={"mean": ${py(series.name)}, "std": ${py(series.error)}})`);
    lines.push(`df = df.sort_values(${py(summary.x)}, kind="mergesort")`);
    return;
  }
  lines.push(`_mean = _agg.pivot(index=${py(summary.x)}, columns=${py(summary.group)}, values="mean")`);
  lines.push(`_std = _agg.pivot(index=${py(summary.x)}, columns=${py(summary.group)}, values="std")`);
  lines.push(`df = _mean.reset_index()`);
  for (const series of summary.series) {
    if (series.group !== series.name) lines.push(`df = df.rename(columns={${py(series.group)}: ${py(series.name)}})`);
    lines.push(`df[${py(series.error)}] = _std[${py(series.group)}].to_numpy() if ${py(series.group)} in _std.columns else 0`);
  }
  lines.push(`df = df.sort_values(${py(summary.x)}, kind="mergesort")`);
}

function namedNumbers(names: string[], rows: Array<Array<string | number | null>> | undefined, name: string): number[] {
  const index = names.indexOf(name);
  if (index < 0 || !rows) return [];
  return rows.flatMap((row) => {
    const value = row[index];
    const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
    return Number.isFinite(numeric) ? [numeric] : [];
  });
}

const ZERO_MARKS = new Set(["bar", "stacked-bar", "stacked-bar-100", "bar-horizontal", "stacked-bar-horizontal", "area", "stacked-area", "waterfall", "histogram"]);

function axisPlanFor(
  config: PlotConfig,
  side: "x" | "y",
  names: string[],
  columns: PlotColumn[],
  rows: Array<Array<string | number | null>> | undefined,
  log: boolean,
  explicitMin: number | null,
  explicitMax: number | null,
  ySide: "left" | "right" = "left",
): AxisPlan | null {
  if (!rows?.length) return null;
  if (side === "x") {
    if (!config.x) return null;
    const column = columns.find((item) => item.name === config.x);
    const numeric = log || !column || column.type === "number" || column.type === "date";
    if (!numeric) return null;
    const values = namedNumbers(names, rows, config.x);
    if (!values.length) return null;
    return axisPlan({
      values,
      log,
      min: explicitMin,
      max: explicitMax,
      mode: config.xTicks,
      step: config.xTickStep,
      maxTicks: config.xTickMax,
      format: config.xTickFormat ?? config.tickFormat,
      minor: config.xMinorTicks || config.gridXMinor,
      minorDivisions: config.minorDivisions,
    });
  }
  const values: number[] = [];
  let hasError = false;
  for (const series of config.series) {
    if ((series.axis === "right" ? "right" : "left") !== ySide) continue;
    const ys = namedNumbers(names, rows, series.y);
    const errors = series.error ? namedNumbers(names, rows, series.error) : [];
    ys.forEach((y, index) => {
      if (series.error) {
        hasError = true;
        const error = errors[index] ?? 0;
        values.push(y - error, y, y + error);
      } else values.push(y);
    });
  }
  for (const note of config.annotations) {
    if (note.kind === "hline" && (note.axis === "right" ? "right" : "left") === ySide) values.push(note.y);
  }
  if (!values.length) return null;
  const markOf = (series: (typeof config.series)[number], index: number) => config.chart === "combo" ? series.mark ?? (index === config.series.length - 1 ? "line" : "bar") : config.chart;
  const zero = config.series.some((series, index) => (series.axis === "right" ? "right" : "left") === ySide && ZERO_MARKS.has(markOf(series, index)));
  if (zero) values.push(0);
  if (hasError) {
    const high = Math.max(...values);
    values.push(high + Math.abs(high || 1) * 0.08);
  }
  return axisPlan({
    values,
    log,
    min: explicitMin,
    max: explicitMax,
    mode: config.yTicks,
    step: config.yTickStep,
    maxTicks: config.yTickMax,
    format: config.yTickFormat ?? config.tickFormat,
    minor: config.yMinorTicks || config.gridYMinor,
    minorDivisions: config.minorDivisions,
  });
}

function emitLogAxis(lines: string[], axis: string, side: "x" | "y", values: number[], minor: boolean): void {
  const positive = values.filter((value) => value > 0 && Number.isFinite(value));
  if (!positive.length) {
    lines.push(`${axis}.set_${side}scale('log')`);
    return;
  }
  const plan = axisPlan({
    values: positive,
    log: true,
    min: null,
    max: null,
    mode: "auto",
    step: null,
    format: "auto",
    minor,
    minorDivisions: 5,
  });
  lines.push(`${axis}.set_${side}scale('log')`);
  lines.push(`${axis}.set_${side}lim(${num(plan.min)}, ${num(plan.max)})`);
  lines.push(`${axis}.${side}axis.set_major_locator(FixedLocator(${locatorList(plan.ticks)}))`);
  lines.push(`${axis}.${side}axis.set_major_formatter(LogFormatterMathtext())`);
  if (plan.minorTicks.length) lines.push(`${axis}.${side}axis.set_minor_locator(FixedLocator(${locatorList(plan.minorTicks)}))`);
  else lines.push(`${axis}.${side}axis.set_minor_locator(NullLocator())`);
}

function emitScale(lines: string[], axis: string, plan: AxisPlan | null, side: "x" | "y", log: boolean): void {
  if (plan?.scale === "log" || (!plan && log)) lines.push(`${axis}.set_${side}scale('log')`);
  if (!plan) return;
  lines.push(`${axis}.set_${side}lim(${num(plan.min)}, ${num(plan.max)})`);
}

function emitTicks(lines: string[], axis: string, side: "x" | "y", config: PlotConfig, plan: AxisPlan | null, numeric: boolean, log: boolean): void {
  const mode = side === "x" ? config.xTicks : config.yTicks;
  const step = side === "x" ? config.xTickStep : config.yTickStep;
  const max = side === "x" ? config.xTickMax : config.yTickMax;
  const minor = side === "x" ? config.xMinorTicks || config.gridXMinor : config.yMinorTicks || config.gridYMinor;
  const format = (side === "x" ? config.xTickFormat : config.yTickFormat) ?? config.tickFormat;
  const rotate = side === "x" ? config.xTickRotate : config.yTickRotate;
  const logged = plan?.scale === "log" || log;
  if (plan && numeric) {
    // Fixed positions, not AutoLocator. AutoLocator is linear and bunches a log axis at the right edge.
    lines.push(`${axis}.set_major_locator(FixedLocator(${locatorList(plan.ticks)}))`);
    lines.push(`${axis}.set_major_formatter(${formatterFor(plan.format)})`);
    if (plan.minorTicks.length) lines.push(`${axis}.set_minor_locator(FixedLocator(${locatorList(plan.minorTicks)}))`);
    else lines.push(`${axis}.set_minor_locator(NullLocator())`);
  } else if (numeric && !logged) {
    if (mode === "step" && step) lines.push(`${axis}.set_major_locator(MultipleLocator(${num(step)}))`);
    else if (mode === "max") lines.push(`${axis}.set_major_locator(MaxNLocator(nbins=${max}))`);
    else lines.push(`${axis}.set_major_locator(AutoLocator())`);
    lines.push(`${axis}.set_major_formatter(${format === "percent" ? 'FuncFormatter(lambda value, _pos: f"{value * 100:.4g}%")' : "FuncFormatter(_compact)"})`);
    if (minor) lines.push(`${axis}.set_minor_locator(AutoMinorLocator(${config.minorDivisions}))`);
  }
  if (rotate) {
    const labels = side === "x" ? "ax.get_xticklabels()" : axis.startsWith("ax_right") ? "ax_right.get_yticklabels()" : "ax.get_yticklabels()";
    lines.push(`plt.setp(${labels}, rotation=${num(rotate)})`);
  }
}

function pyChannel(value: number): string {
  return num(value / 255);
}

function pyDash(dash: number[] | null): string {
  if (!dash) return py("solid");
  return `(0, (${dash.map((value) => num(value)).join(", ")}))`;
}

function emitGrid(lines: string[], axis: string, config: PlotConfig, dark: boolean): void {
  const majorX = config.gridX ?? config.grid;
  const majorY = config.gridY ?? config.grid;
  const stroke = (side: "x" | "y", minor: boolean) => paintedGrid(config, side, minor, dark);
  const paint = (which: "major" | "minor", side: "x" | "y", visible: boolean, minor: boolean) => {
    const look = stroke(side, minor);
    const color = `(${pyChannel(look.red)}, ${pyChannel(look.green)}, ${pyChannel(look.blue)}, ${num(look.alpha)})`;
    lines.push(`${axis}.grid(which=${py(which)}, axis=${py(side)}, visible=${visible ? "True" : "False"}, linestyle=${pyDash(look.dash)}, linewidth=${num(look.width)}, color=${color}, alpha=1)`);
  };
  lines.push(`${axis}.grid(False)`);
  paint("major", "x", Boolean(majorX), false);
  paint("major", "y", Boolean(majorY), false);
  if (config.gridXMinor) paint("minor", "x", true, true);
  if (config.gridYMinor) paint("minor", "y", true, true);
}

const PANEL_DARK = "#221e1a";
const PANEL_LIGHT = "#fffcf7";
const INK_DARK = "#f3eee6";
const INK_LIGHT = "#1c1915";
const MUTED_DARK = "#a8a29e";
const MUTED_LIGHT = "#6d675e";

function paintFigure(lines: string[], dark: boolean, axes: string[]): void {
  const panel = dark ? PANEL_DARK : PANEL_LIGHT;
  const ink = dark ? INK_DARK : INK_LIGHT;
  const muted = dark ? MUTED_DARK : MUTED_LIGHT;
  lines.push(`fig.patch.set_facecolor(${py(panel)})`);
  for (const axis of axes) {
    lines.push(`${axis}.set_facecolor(${py(panel)})`);
    lines.push(`${axis}.tick_params(colors=${py(ink)})`);
    lines.push(`${axis}.xaxis.label.set_color(${py(ink)})`);
    lines.push(`${axis}.yaxis.label.set_color(${py(ink)})`);
    lines.push(`${axis}.title.set_color(${py(ink)})`);
    lines.push(`for _spine in ${axis}.spines.values():`);
    lines.push(`    _spine.set_color(${py(muted)})`);
  }
}

/** Whiskers, caps, and outlier rings default to black, which vanishes on the dark panel. */
function paintBox(lines: string[], dark: boolean): void {
  if (!dark) return;
  lines.push("for _part in _drawn['whiskers'] + _drawn['caps']:");
  lines.push(`    _part.set_color(${py(INK_DARK)})`);
  lines.push("for _part in _drawn['fliers']:");
  lines.push(`    _part.set_markeredgecolor(${py(INK_DARK)})`);
}

/** Legend text takes the theme ink; the default is black even on a dark figure. */
function legendInk(dark: boolean): string {
  return dark ? `, labelcolor=${py(INK_DARK)}` : "";
}

/** The seed summary the canvas built, so the script can derive the same columns from the raw file. */
export function seedSummaryFor(args: {
  columns: Array<{ name: string; type: string }>;
  x: string | null;
  y: string | null;
  seed: string | null;
  series: Array<{ y: string; error?: string }>;
}): SeedSummary | null {
  if (!args.x || !args.y || !args.seed || !args.series.length) return null;
  const extras = args.columns.filter((column) => column.name !== args.x && column.name !== args.y && column.name !== args.seed && (column.type === "category" || column.type === "text"));
  const group = extras.length === 1 ? extras[0]!.name : null;
  return {
    x: args.x,
    y: args.y,
    seed: args.seed,
    group,
    series: args.series.map((series) => ({
      name: series.y,
      group: group ? series.y : "",
      error: series.error || `${series.y} std`,
    })),
  };
}

export function boilerplate(datasetName: string): string {
  return `from ensemble_plots import load, save, apply_style
import matplotlib.pyplot as plt

apply_style("Liberation Serif", "serif")
df = load(${JSON.stringify(datasetName)})
fig, ax = plt.subplots(figsize=(3.5, 2.6), layout="constrained")
# df columns are available as df["column"].
ax.plot(df.iloc[:, 0], df.iloc[:, 1] if df.shape[1] > 1 else df.iloc[:, 0], color="#0072B2", linewidth=1.25)
ax.set_xlabel(df.columns[0])
if df.shape[1] > 1:
    ax.set_ylabel(df.columns[1])
save(fig)
`;
}

export function workspaceBoilerplate(names: string[]): string {
  const loads = names.length
    ? names.map((name) => `frames[${JSON.stringify(name)}] = load(${JSON.stringify(name)})`).join("\n")
    : "frames[\"data\"] = load(\"data\")";
  return `from ensemble_plots import load, save, apply_style
import matplotlib.pyplot as plt

apply_style("Liberation Serif", "serif")
frames = {}
${loads}
# Every dataset on this workspace is loaded by the name shown in the column pool.
fig, ax = plt.subplots(figsize=(6.75, 2.6), layout="constrained")
save(fig)
`;
}

/** One matplotlib figure for the canvas: a subplot per tile, panel letters, and a shared legend that keeps one meaning per colour. */
function pyCell(value: string | number | null): string {
  if (value === null || (typeof value === "number" && !Number.isFinite(value))) return "None";
  if (typeof value === "number") return num(value);
  return py(value);
}

function columnNumbers(
  panel: { columns?: string[]; rows?: Array<Array<string | number | null>> },
  name: string,
): number[] {
  const index = panel.columns?.indexOf(name) ?? -1;
  if (index < 0 || !panel.rows) return [];
  return panel.rows.flatMap((row) => {
    const value = row[index];
    return typeof value === "number" && Number.isFinite(value) ? [value] : [];
  });
}

export function matplotlibPanels(
  panels: Array<{ title: string; datasetName: string; x: string; ys: string[]; yTitle?: string; chart: string; palette?: PaletteId; xLog?: boolean; yLog?: boolean; columns?: string[]; rows?: Array<Array<string | number | null>>; error?: string; errorKind?: "bar" | "band"; series?: Array<{ y: string; color?: string; error?: string; errorKind?: "bar" | "band" }>; boxNotch?: boolean; boxOutliers?: boolean; boxWhisker?: number }>,
  options?: { preset?: string; width?: "single" | "double"; columns?: number; legend?: boolean; widthIn?: number; heightIn?: number; dpi?: number; fontSize?: number; accent?: string; dark?: boolean },
): string {
  const n = Math.max(panels.length, 1);
  const cols = Math.max(1, Math.min(options?.columns ?? Math.min(n, 3), n));
  const legendOn = options?.legend !== false;
  const rows = Math.ceil(n / cols);
  const figureWidth = options?.widthIn && options.widthIn > 0 ? options.widthIn : options?.width === "single" ? 3.5 : 7;
  const figureHeight = options?.heightIn && options.heightIn > 0 ? options.heightIn : figureWidth * 0.3 * rows;
  const fontSize = options?.fontSize && options.fontSize > 0 ? options.fontSize : 9;
  const lines = [
    "from ensemble_plots import load, save, apply_style",
    "import matplotlib.pyplot as plt",
    "import pandas as pd",
    "from matplotlib.ticker import FixedLocator, LogFormatterMathtext, NullLocator",
    "",
    `apply_style("Liberation Serif", "serif", ${num(fontSize)})`,
    "plt.rcParams[\"axes.unicode_minus\"] = False",
    ...(options?.dpi ? [`# dpi ${num(options.dpi)}`] : []),
    `fig, axes = plt.subplots(${rows}, ${cols}, figsize=(${num(figureWidth)}, ${num(figureHeight)}), layout="constrained", squeeze=False)`,
    "axes = axes.ravel()",
    "handles, labels = [], []",
  ];
  panels.forEach((panel, index) => {
    const letter = String.fromCharCode(97 + index);
    if (panel.rows && panel.columns?.length) {
      const fields = panel.columns.map((name, index) => `${py(name)}: [${panel.rows!.map((row) => pyCell(row[index] ?? null)).join(", ")}]`);
      lines.push(`_df = pd.DataFrame({${fields.join(", ")}})`);
    } else {
      lines.push(`_df = load(${py(panel.datasetName)})`);
    }
    lines.push(`_ax = axes[${index}]`);
    const heading = panel.title ? `(${letter})  ${panel.title}` : `(${letter})`;
    // A loc="left" title is not ax.title, so paintFigure cannot recolour it.
    lines.push(`_ax.set_title(${py(heading)}, fontsize=9, loc="left", pad=10${options?.dark ? `, color=${py(INK_DARK)}` : ""})`);
    if (panel.chart === "heatmap" && panel.ys.length >= 2) {
      const yName = panel.ys[0]!;
      const valueName = panel.ys[1]!;
      lines.push(`_classes = list(dict.fromkeys([str(item) for item in _df[${py(panel.x)}]] + [str(item) for item in _df[${py(yName)}]]))`);
      lines.push(`_mat = _df.pivot(index=${py(yName)}, columns=${py(panel.x)}, values=${py(valueName)})`);
      lines.push("_mat.index = _mat.index.map(str)");
      lines.push("_mat.columns = _mat.columns.map(str)");
      lines.push("_mat = _mat.reindex(index=_classes, columns=_classes)");
      lines.push(`_ax.imshow(_mat.to_numpy(dtype=float), cmap="viridis", aspect="equal")`);
      lines.push("_ax.set_box_aspect(1)");
      lines.push("_ax.set_xticks(range(_mat.shape[1]))");
      lines.push("_ax.set_xticklabels([str(item) for item in _mat.columns], fontsize=8)");
      lines.push("for _label in _ax.get_xticklabels():");
      lines.push("    _label.set_rotation(70)");
      lines.push("    _label.set_ha('right')");
      lines.push("    _label.set_rotation_mode('anchor')");
      lines.push("_ax.set_yticks(range(_mat.shape[0]))");
      lines.push("_ax.set_yticklabels([str(item) for item in _mat.index], fontsize=8)");
      lines.push("_vals = _mat.to_numpy(dtype=float)");
      lines.push("_flat = [float(item) for item in _vals.ravel() if item == item]");
      lines.push("_lo = min(_flat) if _flat else 0.0");
      lines.push("_hi = max(_flat) if _flat else 1.0");
      lines.push('_cmap = plt.get_cmap("viridis")');
      lines.push("for _r in range(_vals.shape[0]):");
      lines.push("    for _c in range(_vals.shape[1]):");
      lines.push("        _v = _vals[_r, _c]");
      lines.push("        if _v == _v:");
      lines.push("            _t = 0.0 if _hi <= _lo else (_v - _lo) / (_hi - _lo)");
      lines.push("            _rgba = _cmap(_t)");
      lines.push("            _lum = 0.2126 * _rgba[0] + 0.7152 * _rgba[1] + 0.0722 * _rgba[2]");
      lines.push('            _ax.text(_c, _r, f"{int(round(_v))}", ha="center", va="center", fontsize=9, color=("black" if _lum >= 0.55 else "white"))');
      lines.push(`_ax.set_xlabel(${py(panel.x)})`);
      lines.push(`_ax.set_ylabel(${py(yName)})`);
      paintFigure(lines, Boolean(options?.dark), ["_ax"]);
    } else if (panel.chart === "box" && panel.ys[0]) {
      const y = panel.ys[0];
      const whisker = typeof panel.boxWhisker === "number" ? panel.boxWhisker : 1.5;
      lines.push(`_y = pd.to_numeric(_df[${py(y)}], errors="coerce")`);
      lines.push(`_g = _df[${py(panel.x)}].astype(str)`);
      if (panel.yLog) {
        lines.push("_y = _y.where(_y > 0)");
        lines.push(`# ${y} values ≤ 0 are hidden on the log axis`);
      }
      lines.push("_order = list(dict.fromkeys(str(item) for item in _g.dropna()))");
      lines.push("_data = [_y[_g == name].dropna().to_numpy() for name in _order]");
      lines.push(`_drawn = _ax.boxplot(_data, tick_labels=_order, notch=${panel.boxNotch ? "True" : "False"}, whis=${num(whisker)}, showfliers=${panel.boxOutliers === false ? "False" : "True"})`);
      const boxColor = paletteColors(panel.palette ?? "okabe-ito", options?.accent, false)[0] ?? "#0072B2";
      lines.push("for _box in _drawn['boxes']:");
      lines.push("    _box.set_linewidth(1)");
      lines.push(`    _box.set_color(${py(boxColor)})`);
      paintBox(lines, Boolean(options?.dark));
      lines.push(`_ax.set_xlabel(${py(panel.x)})`);
      lines.push(`_ax.set_ylabel(${py(y)})`);
      if (panel.yLog) emitLogAxis(lines, "_ax", "y", columnNumbers(panel, y), false);
      paintFigure(lines, Boolean(options?.dark), ["_ax"]);
    } else {
      const draw = panel.chart === "bar" || panel.chart === "stacked-bar" ? "bar" : panel.chart === "scatter" ? "scatter" : "plot";
      const encoded = panel.series?.length
        ? panel.series
        : panel.ys.map((y, series) => ({ y, error: series === 0 ? panel.error : undefined, errorKind: series === 0 ? panel.errorKind : undefined }));
      if (draw === "plot" || draw === "scatter") lines.push(`_df = _df.sort_values(${py(panel.x)}, kind="mergesort")`);
      encoded.forEach((series, seriesIndex) => {
        const color = seriesColor({
          palette: panel.palette ?? "okabe-ito",
          accent: options?.accent,
          dark: false,
          count: encoded.length,
          index: seriesIndex,
          explicit: "color" in series ? series.color : undefined,
        });
        const y = series.y;
        const frame = panel.xLog || panel.yLog ? "_sub" : "_df";
        if (panel.xLog || panel.yLog) {
          const parts = ["_sub = _df"];
          if (panel.xLog) parts.push(`_sub = _sub.loc[pd.to_numeric(_sub[${py(panel.x)}], errors="coerce") > 0]`);
          if (panel.yLog) parts.push(`_sub = _sub.loc[pd.to_numeric(_sub[${py(y)}], errors="coerce") > 0]`);
          lines.push(parts.join("\n".padEnd(1)));
          lines.push(`# ${y} values ≤ 0 are hidden on the log axis`);
        }
        if (draw === "bar") lines.push(`_ax.bar(${frame}[${py(panel.x)}], ${frame}[${py(y)}], label=${py(y)}, color=${py(color)}, width=0.7)`);
        else if (draw === "scatter") lines.push(`_ax.scatter(${frame}[${py(panel.x)}], ${frame}[${py(y)}], label=${py(y)}, color=${py(color)}, s=16)`);
        else lines.push(`_ax.plot(${frame}[${py(panel.x)}], ${frame}[${py(y)}], label=${py(y)}, color=${py(color)}, linewidth=1.25)`);
        if (series.error && series.errorKind === "band") {
          lines.push(`_y = pd.to_numeric(${frame}[${py(y)}], errors="coerce")`);
          lines.push(`_e = pd.to_numeric(${frame}[${py(series.error)}], errors="coerce")`);
          lines.push(`_x = pd.to_numeric(${frame}[${py(panel.x)}], errors="coerce")`);
          lines.push(`_ax.fill_between(_x, _y - _e, _y + _e, color=${py(color)}, alpha=${num(BAND_ALPHA)}, linewidth=0, zorder=1)`);
        } else if (series.error && series.errorKind === "bar") {
          lines.push(`_ax.errorbar(${frame}[${py(panel.x)}], ${frame}[${py(y)}], yerr=pd.to_numeric(${frame}[${py(series.error)}], errors="coerce"), fmt="none", ecolor=${py(color)}, elinewidth=0.8, capsize=2)`);
        }
      });
      if (draw === "bar") {
        lines.push("for _label in _ax.get_xticklabels():");
        lines.push("    _label.set_rotation(28)");
        lines.push("    _label.set_ha('right')");
        lines.push("    _label.set_fontsize(8)");
      }
      if (panel.xLog) emitLogAxis(lines, "_ax", "x", columnNumbers(panel, panel.x), false);
      if (panel.yLog) {
        const yValues = encoded.flatMap((series) => {
          const ys = columnNumbers(panel, series.y);
          const errors = series.error ? columnNumbers(panel, series.error) : [];
          return ys.flatMap((y, index) => (series.error ? [y - (errors[index] ?? 0), y, y + (errors[index] ?? 0)] : [y]));
        });
        emitLogAxis(lines, "_ax", "y", yValues, false);
      } else {
        const values: number[] = [];
        encoded.forEach((series) => {
          const ys = columnNumbers(panel, series.y);
          const errors = series.error ? columnNumbers(panel, series.error) : [];
          ys.forEach((y, index) => {
            const error = errors[index] ?? 0;
            values.push(y - error, y + error);
          });
        });
        if (values.length) {
          const low = Math.min(...values);
          const high = Math.max(...values);
          const nice = niceBounds(low >= 0 ? 0 : low, high);
          lines.push(`_ax.set_ylim(${num(nice.min)}, ${num(nice.max)})`);
        }
      }
      emitGrid(lines, "_ax", defaultPlotConfig(), Boolean(options?.dark));
      paintFigure(lines, Boolean(options?.dark), ["_ax"]);
      lines.push(`_ax.set_xlabel(${py(panel.x)})`);
      if (panel.yTitle || encoded[0]) lines.push(`_ax.set_ylabel(${py(panel.yTitle || encoded[0]!.y)})`);
      lines.push("_h, _l = _ax.get_legend_handles_labels()");
      lines.push("handles += _h");
      lines.push("labels += _l");
    }
  });
  lines.push(`for _ax in axes[${n}:]:`);
  lines.push("    _ax.set_visible(False)");
  lines.push("def _swatch(handle):");
  lines.push("    color = handle.get_color() if hasattr(handle, 'get_color') else None");
  lines.push("    if color is None and getattr(handle, 'patches', None):");
  lines.push("        color = handle.patches[0].get_facecolor()");
  lines.push("    if isinstance(color, str):");
  lines.push("        text = color.lstrip('#')");
  lines.push("        if len(text) == 6:");
  lines.push("            return tuple(int(text[i:i+2], 16) for i in (0, 2, 4))");
  lines.push("    if isinstance(color, tuple) and len(color) >= 3:");
  lines.push("        channels = color[:3]");
  lines.push("        scale = 255 if max(channels) <= 1 else 1");
  lines.push("        return tuple(int(round(channel * scale)) for channel in channels)");
  lines.push("    return id(handle)");
  lines.push("pairs = []");
  lines.push("_seen = set()");
  lines.push("for handle, label in zip(handles, labels):");
  lines.push("    if not label or any(item[1] == label for item in pairs):");
  lines.push("        continue");
  lines.push("    swatch = _swatch(handle)");
  lines.push("    if swatch in _seen:");
  lines.push("        continue");
  lines.push("    _seen.add(swatch)");
  lines.push("    pairs.append((handle, label))");
  if (legendOn) {
    lines.push("if pairs:");
    lines.push("    _handles, _labels = zip(*pairs)");
    lines.push(`    fig.legend(_handles, _labels, loc="outside lower center", ncol=min(4, len(pairs)), frameon=False, fontsize=8${legendInk(Boolean(options?.dark))})`);
  }
  lines.push("save(fig)");
  lines.push("");
  return lines.join("\n");
}
