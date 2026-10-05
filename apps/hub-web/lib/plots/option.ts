import {
  applyFilter,
  boxStats,
  buildSeries,
  histogram,
  kde,
  lttb,
  numericColumn,
  BAND_ALPHA,
  axisPlan,
  paintedGrid,
  paletteColors,
  plottedRows,
  seriesColor,
  prepareSeries,
  valueAxisBounds,
  waterfallSteps,
  type AxisPlan,
  type Frame,
  type PlotConfig,
} from "@ensemble/shared-types";

export type PlotTheme = {
  ink: string;
  muted: string;
  line: string;
  panel: string;
  accent: string;
  dark: boolean;
};

const DASH: Record<string, number[]> = {
  solid: [],
  dashed: [6, 4],
  dotted: [2, 3],
  dashdot: [8, 3, 2, 3],
};

function colorsOf(config: PlotConfig, theme: PlotTheme): string[] {
  return paletteColors(config.palette, theme.accent, theme.dark);
}

const SUPERSCRIPTS = ["⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"];

/** Powers of ten read as 10³, not 1000 and not the raw data max. */
export function logTickLabel(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  const exp = Math.log10(value);
  const rounded = Math.round(exp);
  if (Math.abs(exp - rounded) > 1e-6) return formatTick(value, "auto");
  const body = String(rounded).replace("-", "⁻").replace(/\d/g, (digit) => SUPERSCRIPTS[Number(digit)] ?? digit);
  return `10${body}`;
}

function niceStep(span: number): number {
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

/** Labels a value axis may draw, so the title can clear the widest one. */
function axisTickLabels(bounds: { min: number | null; max: number | null }, log: boolean, format: PlotConfig["tickFormat"]): string[] {
  if (log) return ["10⁰", "10⁻¹", "10⁸"];
  const min = bounds.min ?? 0;
  const max = bounds.max ?? 1;
  const step = niceStep(max - min || 1);
  const labels: string[] = [];
  for (let index = 0; index <= 6; index += 1) {
    const value = Math.round((min + step * index) * 1e6) / 1e6;
    if (value > max + step * 0.01) break;
    labels.push(formatTick(value, format));
  }
  labels.push(formatTick(Math.round((min + step / 2) * 1e6) / 1e6, format));
  return labels;
}

/** Gap from the axis line to a rotated title, past the tick labels, plus the outer pad that keeps the title inside the tile. */
function yTitleLayout(
  title: string,
  bounds: { min: number | null; max: number | null },
  log: boolean,
  fontSize: number,
  format: PlotConfig["tickFormat"],
): { nameGap: number; pad: number } {
  const labelSize = Math.max(8, fontSize - 1);
  const widest = Math.max(14, ...axisTickLabels(bounds, log, format).map((text) => Math.ceil([...text].length * labelSize * 0.7)));
  const nameHalf = Math.ceil(fontSize * 0.75) + 2;
  const labelExtent = 8 + widest;
  const nameGap = labelExtent + nameHalf + 8;
  // The title is nameGap left of the axis, so the outer pad has to grow with that gap or the word is clipped.
  const pad = nameGap + 16;
  return { nameGap, pad: title ? pad : 8 };
}

function formatTick(value: number, mode: PlotConfig["tickFormat"]): string {
  if (!Number.isFinite(value)) return "";
  if (mode === "percent") return `${Math.round(value * (Math.abs(value) <= 1 ? 100 : 1))}${Math.abs(value) <= 1 ? "%" : ""}`;
  if (mode === "compact") return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
  if (mode === "number") return new Intl.NumberFormat(undefined, { maximumSignificantDigits: 6, maximumFractionDigits: 4 }).format(value);
  if (Math.abs(value) >= 1000) return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
  const digits = Math.abs(value) >= 1 ? 4 : 3;
  return new Intl.NumberFormat(undefined, { maximumSignificantDigits: digits }).format(value);
}

function tidy(value: unknown, mode: PlotConfig["tickFormat"]): string {
  if (typeof value === "number") return formatTick(value, mode);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return formatTick(Number(value), mode);
  if (Array.isArray(value)) return tidy(value.length > 1 ? value[1] : value[0], mode);
  return value == null ? "" : String(value);
}

/** Tooltip values use the tick formatter, so a log-axis crosshair is not a raw float. */
export function tooltipFormatter(params: unknown, mode: PlotConfig["tickFormat"]): string {
  const rows = (Array.isArray(params) ? params : [params]) as Array<{ marker?: string; seriesName?: string; axisValue?: unknown; data?: unknown; value?: unknown }>;
  if (!rows.length) return "";
  const head = tidy(rows[0]?.axisValue, mode);
  const lines = rows.map((row) => {
    const raw = row.data ?? row.value;
    const y = Array.isArray(raw) ? tidy(raw[1], mode) : tidy(raw, mode);
    const name = row.seriesName ? `${row.marker ?? ""}${row.seriesName}` : "";
    return name ? `${name}: ${y}` : y;
  });
  return [head, ...lines.filter(Boolean)].filter(Boolean).join("<br/>");
}

function majorOn(config: PlotConfig, side: "x" | "y"): boolean {
  if (side === "x") return config.gridX ?? config.grid;
  return config.gridY ?? config.grid;
}

function axisFormat(config: PlotConfig, side: "x" | "y"): PlotConfig["tickFormat"] {
  return (side === "x" ? config.xTickFormat : config.yTickFormat) ?? config.tickFormat;
}

/** Same width, alpha, ink, and dash the matplotlib export draws. */
function gridLook(config: PlotConfig, theme: PlotTheme, minor: boolean, side: "x" | "y" = "y") {
  const paint = paintedGrid(config, side, minor, theme.dark);
  return {
    color: `rgba(${paint.red}, ${paint.green}, ${paint.blue}, ${paint.alpha})`,
    width: paint.width,
    opacity: 1,
    type: paint.dash ?? "solid",
  };
}

/** A step that yields about `maxTicks` gaps, the same job as MaxNLocator. */
function niceTickStep(span: number, maxTicks: number): number | undefined {
  if (!(span > 0) || !(maxTicks >= 2)) return undefined;
  const rough = span / maxTicks;
  const pow = 10 ** Math.floor(Math.log10(rough));
  if (!Number.isFinite(pow) || pow === 0) return undefined;
  const fraction = rough / pow;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * pow;
}

function noteLabel(text: string, color: string, position: string, panel: string) {
  return {
    formatter: text,
    color,
    position,
    distance: 6,
    fontSize: 11,
    backgroundColor: panel,
    padding: [2, 5],
    borderRadius: 3,
  };
}

function annotations(config: PlotConfig, horizontal: boolean, panel: string) {
  const lines: unknown[] = [];
  const areas: unknown[] = [];
  for (const note of config.annotations) {
    const dash = DASH[note.kind === "band" ? "solid" : note.style] ?? [];
    if (note.kind === "hline" && !horizontal) {
      lines.push({
        yAxis: note.y,
        axis: note.axis === "right" ? 1 : 0,
        name: note.label,
        lineStyle: { color: note.color, type: dash, width: 2 },
        label: noteLabel(note.label || String(note.y), note.color, "insideEndTop", panel),
      });
    } else if (note.kind === "vline") {
      lines.push({
        xAxis: note.x,
        name: note.label,
        lineStyle: { color: note.color, type: dash, width: 2 },
        label: noteLabel(note.label || String(note.x), note.color, "end", panel),
      });
    } else if (note.kind === "band") {
      if (note.orientation === "horizontal") areas.push([{ yAxis: note.from, itemStyle: { color: note.color, opacity: 0.15 } }, { yAxis: note.to }]);
      else areas.push([{ xAxis: note.from, itemStyle: { color: note.color, opacity: 0.15 } }, { xAxis: note.to }]);
    }
  }
  return { lines, areas };
}

export function chartOption(frame: Frame, config: PlotConfig, theme: PlotTheme, opts?: { compact?: boolean; showTitle?: boolean }): Record<string, unknown> {
  const compact = Boolean(opts?.compact);
  const showTitle = opts?.showTitle !== false && Boolean(config.title);
  const palette = colorsOf(config, theme);
  const text = { color: theme.ink, fontSize: config.fontSize };
  const axis = {
    axisLine: { lineStyle: { color: theme.muted } },
    axisTick: { lineStyle: { color: theme.muted } },
    axisLabel: { color: theme.muted, fontSize: Math.max(8, config.fontSize - 1), hideOverlap: false, formatter: (value: number | string) => (typeof value === "number" ? formatTick(value, config.tickFormat) : String(value)) },
    splitLine: { show: config.grid, lineStyle: gridLook(config, theme, false) },
    minorSplitLine: { show: false, lineStyle: gridLook(config, theme, true) },
    minorTick: { show: false, splitNumber: config.minorDivisions },
    nameLocation: "middle",
    nameGap: 28,
    nameTextStyle: { color: theme.muted, fontSize: Math.max(10, config.fontSize - 1) },
  };
  const base = {
    backgroundColor: "transparent",
    color: palette,
    textStyle: text,
    animationDuration: 0,
    title: showTitle
      ? { text: config.title, subtext: config.subtitle || undefined, left: 8, top: 4, textStyle: { color: theme.ink, fontSize: config.fontSize + 3, fontWeight: 600 }, subtextStyle: { color: theme.muted, fontSize: config.fontSize - 1 } }
      : undefined,
    animationDurationUpdate: 0,
    tooltip: {
      trigger: config.chart === "pie" || config.chart === "donut" ? "item" : "axis",
      axisPointer: { type: "cross", lineStyle: { color: theme.muted } },
      backgroundColor: theme.panel,
      borderColor: theme.line,
      textStyle: { color: theme.ink, fontSize: config.fontSize },
      formatter: (params: unknown) => tooltipFormatter(params, config.tickFormat),
    },
    legend:
      config.legend === "none"
        ? { show: false }
        : {
            textStyle: { color: theme.muted, fontSize: config.fontSize - 1 },
            type: "scroll",
            itemWidth: 14,
            itemHeight: 8,
            ...(config.legend === "bottom" ? { bottom: 4, left: "center" } : {}),
            ...(config.legend === "top" ? { top: showTitle ? 28 : 4, left: "center" } : {}),
            ...(config.legend === "left" ? { left: 8, top: "middle" } : {}),
            ...(config.legend === "right" ? { right: 8, top: "middle" } : {}),
          },
    toolbox: { show: false },
  };

  if (config.chart === "pie" || config.chart === "donut") {
    const pies = buildSeries(frame, config);
    const count = Math.max(pies.length, 1);
    const centers = count === 1 ? [["50%", "52%"]] : pies.map((_, index) => [`${(100 / count) * (index + 0.5)}%`, "54%"]);
    const radius = config.chart === "donut" ? (count === 1 ? ["32%", "48%"] : ["16%", "30%"]) : count === 1 ? "56%" : "30%";
    const formatter = config.pieLabels === "percent" ? "{d}%" : config.pieLabels === "both" ? "{b}\n{d}%" : "{b}";
    return {
      ...base,
      title: count > 1 ? pies.map((item, index) => ({ text: item.name, left: centers[index]![0], top: 8, textAlign: "center", textStyle: { color: theme.ink, fontSize: config.fontSize, fontWeight: 600 } })) : base.title,
      legend: { show: false },
      series: pies.map((item, index) => ({
        name: item.name,
        type: "pie",
        radius,
        center: centers[index],
        data: item.points.map((point) => ({
          name: String(point.x),
          value: point.y,
          itemStyle: config.colors[String(point.x)] ? { color: config.colors[String(point.x)] } : undefined,
        })),
        avoidLabelOverlap: true,
        label: { color: theme.ink, fontSize: config.fontSize - 1, position: "outside", formatter },
        labelLine: { length: count > 1 ? 8 : 12, length2: 6, lineStyle: { color: theme.muted } },
      })),
    };
  }

  if (config.chart === "histogram") {
    const values = numericColumn(frame, config.series[0]?.y ?? config.x);
    const bins = histogram(values, config.binCount);
    return {
      ...base,
      grid: { left: 48, right: 16, top: config.title ? 48 : 24, bottom: 40 },
      xAxis: { type: "category", data: bins.map((bin) => bin.x), ...axis, name: config.xTitle || config.series[0]?.y || "" },
      yAxis: { type: "value", ...axis, name: "count", min: 0, scale: false },
      series: [{ type: "bar", data: bins.map((bin) => bin.y), itemStyle: { color: palette[0] }, barMaxWidth: 28 }],
    };
  }

  if (config.chart === "box" || config.chart === "violin") {
    const yName = config.series[0]?.y;
    const xIndex = frame.columns.findIndex((column) => column.name === config.x);
    const yIndex = frame.columns.findIndex((column) => column.name === yName);
    const grouped = new Map<string, number[]>();
    if (yIndex >= 0) {
      for (const row of applyFilter(frame, config.filter).rows) {
        const raw = row[yIndex];
        const value = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isFinite(value)) continue;
        if (config.yLogLeft && value <= 0) continue;
        const key = xIndex >= 0 ? String(row[xIndex] ?? "") : (yName ?? "value");
        if (!key) continue;
        const bucket = grouped.get(key) ?? [];
        bucket.push(value);
        grouped.set(key, bucket);
      }
    }
    const stats = [...grouped.entries()]
      .map(([name, values]) => boxStats(name, values, config.boxWhisker))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (config.chart === "box") {
      const jitter = config.boxJitter
        ? stats.flatMap((item, index) => item.values.map((value, point) => [index + (((point * 17) % 11) - 5) / 80, value]))
        : [];
      const outliers = config.boxOutliers
        ? stats.flatMap((item, index) => item.outliers.map((value) => [index, value]))
        : [];
      const swatch = (name: string, color: string) => ({ name, itemStyle: { color, borderColor: color } });
      const legendData = [
        swatch(yName || "Box", palette[0]!),
        ...(outliers.length ? [swatch("Outliers", palette[5] || palette[0]!)] : []),
        ...(jitter.length ? [swatch("Points", theme.ink)] : []),
      ];
      const showLegend = config.legend !== "none";
      const legendTop = showLegend && (compact || config.legend !== "bottom");
      const legend: Record<string, unknown> = { ...(base.legend as Record<string, unknown>), data: legendData };
      if (!showLegend) {
        legend.show = false;
      } else if (legendTop) {
        delete legend.bottom;
        legend.top = 2;
        if (config.legend === "left") {
          delete legend.right;
          legend.left = 8;
        } else {
          delete legend.left;
          legend.right = 8;
        }
      } else {
        delete legend.top;
        delete legend.right;
        legend.bottom = 2;
        legend.left = "center";
      }
      return {
        ...base,
        legend,
        grid: {
          left: 48,
          right: 16,
          top: legendTop ? 28 : 16,
          bottom: showLegend && !legendTop ? 58 : 28,
        },
        xAxis: { type: "category", data: stats.map((item) => item.name), ...axis, axisLabel: { ...axis.axisLabel, rotate: config.xTickRotate || 0, margin: 8 } },
        yAxis: { type: config.yLogLeft ? "log" : "value", ...axis, name: config.yTitleLeft, scale: true },
        series: [
          {
            type: "boxplot",
            name: yName || "Box",
            data: stats.map((item) => [item.whiskerLow, item.q1, item.median, item.q3, item.whiskerHigh]),
            itemStyle: { color: palette[0], borderColor: palette[0], borderWidth: config.boxNotch ? 1.25 : 1 },
          },
          ...(config.boxNotch
            ? [{
                type: "custom",
                silent: true,
                tooltip: { show: false },
                legendHoverLink: false,
                data: stats.map((item, index) => [index, item.notchLow, item.median, item.notchHigh, item.q1, item.q3]),
                renderItem: (_params: unknown, api: { coord: (pair: number[]) => number[]; value: (dim: number) => number }) => {
                  const index = api.value(0);
                  const low = api.coord([index, api.value(1)]);
                  const mid = api.coord([index, api.value(2)]);
                  const high = api.coord([index, api.value(3)]);
                  const left = api.coord([index - 0.2, api.value(2)]);
                  const right = api.coord([index + 0.2, api.value(2)]);
                  return {
                    type: "polygon",
                    shape: { points: [[left[0], high[1]], [mid[0], high[1]], [right[0], high[1]], [right[0] - 6, mid[1]], [right[0], low[1]], [left[0], low[1]], [left[0] + 6, mid[1]]] },
                    style: { fill: "none", stroke: theme.ink, lineWidth: 1 },
                  };
                },
              }]
            : []),
          ...(outliers.length ? [{ type: "scatter", name: "Outliers", data: outliers, symbolSize: 6, itemStyle: { color: palette[5] || palette[0] } }] : []),
          ...(jitter.length ? [{ type: "scatter", name: "Points", data: jitter, symbolSize: 4, itemStyle: { color: theme.ink, opacity: 0.45 } }] : []),
        ],
      };
    }
    const series = stats.map((item, index) => {
      const density = kde(item.values);
      const max = Math.max(...density.map((point) => point.y), 1e-9);
      return {
        type: "custom",
        name: item.name,
        renderItem: (_params: unknown, api: { coord: (pair: number[]) => number[]; value: (dim: number) => number }) => {
          const points = density.map((point) => api.coord([index + (point.y / max) * 0.35, point.x]));
          const mirror = [...density].reverse().map((point) => api.coord([index - (point.y / max) * 0.35, point.x]));
          return { type: "polygon", shape: { points: [...points, ...mirror] }, style: { fill: palette[index % palette.length], opacity: 0.85 } };
        },
        data: density.map((point) => [index, point.x, point.y]),
      };
    });
    return {
      ...base,
      grid: { left: 48, right: 16, top: config.title ? 48 : 24, bottom: 36 },
      xAxis: { type: "category", data: stats.map((item) => item.name), ...axis },
      yAxis: { type: "value", ...axis, scale: true },
      series,
    };
  }

  if (config.chart === "heatmap") {
    const gridFrame = applyFilter(frame, config.filter);
    const xName = config.x;
    const yName = config.series[0]?.y;
    const valueName = config.series[1]?.y ?? config.series[0]?.y;
    const xIndex = gridFrame.columns.findIndex((column) => column.name === xName);
    const yIndex = gridFrame.columns.findIndex((column) => column.name === yName);
    const vIndex = gridFrame.columns.findIndex((column) => column.name === valueName);
    const xs = new Set<string>();
    const ys = new Set<string>();
    const cells: Array<[number, number, number]> = [];
    const xLabels: string[] = [];
    const yLabels: string[] = [];
    const xAt = new Map<string, number>();
    const yAt = new Map<string, number>();
    for (const row of gridFrame.rows) {
      const x = String(row[xIndex] ?? "");
      const y = String(row[yIndex] ?? "");
      const value = typeof row[vIndex] === "number" ? row[vIndex] : Number(row[vIndex]);
      if (!x || !y || !Number.isFinite(value)) continue;
      if (!xAt.has(x)) {
        xAt.set(x, xLabels.length);
        xLabels.push(x);
      }
      if (!yAt.has(y)) {
        yAt.set(y, yLabels.length);
        yLabels.push(y);
      }
      xs.add(x);
      ys.add(y);
      cells.push([xAt.get(x)!, yAt.get(y)!, value as number]);
    }
    const sequential = config.palette === "rdbu" ? paletteColors("rdbu") : paletteColors("viridis");
    const peak = Math.max(...cells.map((cell) => cell[2]), 1);
    const ink = theme.dark ? "#1a1814" : "#1c1915";
    const paper = theme.dark ? "#f4efe6" : "#f7f4ee";
    return {
      ...base,
      grid: { left: 72, right: 16, top: showTitle ? 36 : 16, bottom: 36 },
      xAxis: { type: "category", data: xLabels, ...axis, name: xName || "", nameGap: compact ? 22 : 28, axisLabel: { ...axis.axisLabel, interval: 0, hideOverlap: false } },
      yAxis: { type: "category", data: yLabels, inverse: true, ...axis, name: yName || "", nameGap: compact ? 36 : 42, axisLabel: { ...axis.axisLabel, interval: 0, hideOverlap: false } },
      visualMap: { show: false, min: Math.min(...cells.map((cell) => cell[2]), 0), max: peak, inRange: { color: sequential } },
      series: [{
        type: "heatmap",
        data: cells.map(([x, y, value]) => ({ value: [x, y, value], label: { color: value > peak * 0.55 ? ink : paper } })),
        label: {
          show: true,
          fontSize: 11,
          formatter: (item: { value?: number[] }) => (item.value && item.value.length > 2 ? String(Math.round(Number(item.value[2]))) : ""),
        },
        emphasis: { itemStyle: { borderColor: theme.ink, borderWidth: 1 } },
      }],
    };
  }

  const built = prepareSeries(frame, config).series;
  const horizontal = config.chart === "bar-horizontal" || config.chart === "stacked-bar-horizontal";
  const stacked = config.chart === "stacked-bar" || config.chart === "stacked-bar-100" || config.chart === "stacked-area" || config.chart === "stacked-bar-horizontal";
  const percent = config.chart === "stacked-bar-100";
  const categories = [...new Set(built.flatMap((series) => series.points.map((point) => String(point.x))))];
  const notes = annotations(config, horizontal, theme.panel);
  const linear = config.annotations.filter((note) => note.kind === "linear");
  const valueXCharts = new Set(["line", "area", "stacked-area", "step", "scatter", "bubble"]);
  const numericX =
    valueXCharts.has(config.chart) &&
    built.length > 0 &&
    built.every((series) => series.points.length > 0 && series.points.every((point) => typeof point.x === "number"));
  const heavy = built.some((series) => series.points.length > 4000);

  const series = built.map((item, index) => {
    const encoding = config.series.find((row) => item.name === row.y || item.name.startsWith(`${row.y} ·`));
    const mark = config.chart === "combo" ? encoding?.mark ?? (index === built.length - 1 ? "line" : "bar") : config.chart;
    const type = mark === "scatter" || mark === "bubble" ? "scatter" : mark === "bar" || String(mark).includes("bar") || mark === "waterfall" ? "bar" : "line";
    const explicit = encoding?.color || config.colors[item.name];
    const color = seriesColor({ palette: config.palette, accent: theme.accent, dark: theme.dark, count: built.length, index, explicit });
    const sampled = numericX || type !== "line" ? item.points : lttb(item.points);
    let data: unknown[] = sampled.map((point) => {
      const y = point.y;
      if (mark === "bubble") return [point.x, y, point.size ?? 10];
      if (numericX || type === "scatter") return y === null ? null : [point.x, y];
      return y;
    });
    if (numericX) {
      data = sampled.map((point) => (point.y === null ? null : mark === "bubble" ? [point.x, point.y, point.size ?? 10] : [point.x, point.y]));
    } else if (percent && type === "bar") {
      data = categories.map((category) => {
        const total = built.reduce((sum, candidate) => sum + (candidate.points.find((point) => String(point.x) === category)?.y ?? 0), 0);
        const value = item.points.find((point) => String(point.x) === category)?.y ?? 0;
        return total ? (value / total) * 100 : 0;
      });
    } else if (type === "bar" || type === "line") {
      data = categories.map((category) => item.points.find((point) => String(point.x) === category)?.y ?? null);
    }
    const step = mark === "step" ? "end" : false;
    const area = mark === "area" || mark === "stacked-area";
    return {
      name: item.name,
      type,
      yAxisIndex: item.axis === "right" ? 1 : 0,
      xAxisIndex: 0,
      stack: stacked && type !== "scatter" ? "total" : undefined,
      step,
      smooth: false,
      sampling: type === "line" ? "lttb" : undefined,
      progressive: heavy ? 8000 : 0,
      progressiveThreshold: 4000,
      large: type === "scatter" && heavy,
      symbol: (encoding?.marker ?? "auto") === "none" ? "none" : encoding?.marker === "auto" || !encoding?.marker ? (sampled.length > 24 ? "none" : "circle") : encoding.marker,
      symbolSize: mark === "bubble" ? (value: number[]) => Math.max(6, Math.min(36, (value[2] ?? 8) / 2)) : 6,
      lineStyle: { width: encoding?.width ?? 1.5, type: DASH[encoding?.lineStyle ?? "solid"], color },
      itemStyle: { color, opacity: encoding?.opacity ?? (area ? 0.9 : 1) },
      areaStyle: area ? { opacity: 0.2, color } : undefined,
      data,
      markLine: (() => {
        const axisIndex = item.axis === "right" ? 1 : 0;
        const first = built.findIndex((series) => (series.axis === "right" ? 1 : 0) === axisIndex) === index;
        if (!first) return undefined;
        const owned = (line: unknown) => line as { axis?: number; yAxis?: number; xAxis?: unknown };
        const horizontalNotes = notes.lines.filter((line) => owned(line).yAxis !== undefined && owned(line).axis === axisIndex).map((line) => {
          const { axis: _axis, ...rest } = owned(line);
          return rest;
        });
        const verticalNotes = axisIndex === 0 ? notes.lines.filter((line) => owned(line).xAxis !== undefined) : [];
        return {
          symbol: "none",
          z: 8,
          data: [
            ...horizontalNotes,
            ...verticalNotes,
            ...linear.flatMap((note) => {
              if ((note.axis === "right" ? 1 : 0) !== axisIndex) return [];
              if (numericX) {
                const xs = item.points.map((point) => point.x).filter((value): value is number => typeof value === "number");
                const min = Math.min(...xs);
                const max = Math.max(...xs);
                if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
                return [[{ coord: [min, note.m * min + note.c] }, { coord: [max, note.m * max + note.c] }]];
              }
              if (!categories.length) return [];
              return [[{ coord: [categories[0], note.c] }, { coord: [categories[categories.length - 1], note.m * (categories.length - 1) + note.c] }]];
            }),
          ],
        };
      })(),
      markArea: index === 0 ? { data: notes.areas } : undefined,
    };
  });

  if (config.chart === "waterfall" && built[0]) {
    const steps = waterfallSteps(built[0].points);
    series.length = 0;
    series.push(
      { name: "base", type: "bar", stack: "waterfall", itemStyle: { color: "transparent" }, data: steps.map((step) => step.base), emphasis: { disabled: true } } as never,
      { name: built[0].name, type: "bar", stack: "waterfall", data: steps.map((step) => ({ value: Math.abs(step.delta), itemStyle: { color: step.delta >= 0 ? palette[2] : palette[5] } })), markLine: { symbol: "none", data: notes.lines } } as never,
    );
  }

  const zeroMarks = new Set(["bar", "stacked-bar", "stacked-bar-100", "bar-horizontal", "stacked-bar-horizontal", "area", "stacked-area", "waterfall", "histogram"]);
  const markOf = (series: (typeof config.series)[number], index: number) => config.chart === "combo" ? series.mark ?? (index === config.series.length - 1 ? "line" : "bar") : config.chart;
  const axisZero = (side: "left" | "right") => config.series.some((series, index) => (series.axis === "right" ? "right" : "left") === side && zeroMarks.has(markOf(series, index)));
  const nums = (side: "left" | "right") => built.filter((series) => (series.axis === "right" ? "right" : "left") === side).flatMap((series) => series.points.flatMap((point) => {
    if (point.y === null) return [];
    return point.error !== undefined ? [point.y - point.error, point.y, point.y + point.error] : [point.y];
  }));
  const refs = (side: "left" | "right") => config.annotations.flatMap((note) => note.kind === "hline" && (note.axis === "right" ? "right" : "left") === side ? [note.y] : []);
  const leftBounds = valueAxisBounds({ zero: axisZero("left"), values: nums("left"), reference: refs("left"), min: config.yMinLeft, max: config.yMaxLeft, log: config.yLogLeft });
  const rightBounds = valueAxisBounds({ zero: axisZero("right"), values: nums("right"), reference: refs("right"), min: config.yMinRight, max: config.yMaxRight, log: config.yLogRight });
  const longLabel = categories.some((label) => label.length > 8);
  const sideBits = (side: "x" | "y", log: boolean, bounds?: { min: number | null; max: number | null }, plan?: AxisPlan | null) => {
    const mode = side === "x" ? config.xTicks : config.yTicks;
    const step = side === "x" ? config.xTickStep : config.yTickStep;
    const max = side === "x" ? config.xTickMax : config.yTickMax;
    const minor = side === "x" ? config.xMinorTicks || config.gridXMinor : config.yMinorTicks || config.gridYMinor;
    const rotate = side === "x" ? config.xTickRotate : config.yTickRotate;
    const format = axisFormat(config, side);
    const span = bounds?.min != null && bounds.max != null ? bounds.max - bounds.min : null;
    const capped = !log && mode === "max" && span != null ? niceTickStep(span, max) : undefined;
    const fromPlan = plan && !log && plan.step ? { interval: plan.step, maxInterval: plan.step } : null;
    const logBits = log && plan ? { splitNumber: Math.max(1, plan.ticks.length - 1) } : null;
    return {
      splitLine: { show: majorOn(config, side), lineStyle: gridLook(config, theme, false, side) },
      minorSplitLine: { show: side === "x" ? config.gridXMinor : config.gridYMinor, lineStyle: gridLook(config, theme, true, side) },
      minorTick: { show: minor, splitNumber: Math.max(2, config.minorDivisions) },
      ...(fromPlan ?? logBits ?? (log ? {} : mode === "step" && step ? { interval: step } : capped ? { interval: capped, maxInterval: capped } : mode === "max" ? { splitNumber: max } : { splitNumber: side === "x" ? 6 : 5 })),
      axisLabel: {
        ...axis.axisLabel,
        rotate: rotate || (side === "x" && longLabel ? 32 : 0),
        formatter: (item: number | string) => {
          const numeric = typeof item === "number" ? item : Number(item);
          if (!Number.isFinite(numeric)) return String(item);
          if (log) return logTickLabel(numeric);
          return formatTick(numeric, format);
        },
      },
    };
  };
  const categoryAxis = {
    type: "category",
    data: categories,
    ...axis,
    ...sideBits("x", false),
    name: config.xTitle || config.x || "",
    nameGap: longLabel ? (compact ? 36 : 46) : (compact ? 20 : 28),
    axisLabel: { ...axis.axisLabel, ...sideBits("x", false).axisLabel, interval: 0, hideOverlap: false },
    axisLine: config.despine ? { show: true, lineStyle: { color: theme.muted } } : axis.axisLine,
  };
  const value = (log: boolean, title: string, bounds: { min: number | null; max: number | null }, nameGap: number, side: "x" | "y", plan?: AxisPlan | null) => ({
    type: log ? "log" : "value",
    ...axis,
    ...sideBits(side, log, plan ? { min: plan.min, max: plan.max } : bounds, plan),
    name: title,
    nameGap,
    ...(log ? { logBase: 10 } : {}),
    scale: !log && !plan && bounds.min == null && bounds.max == null,
    min: plan ? plan.min : log ? undefined : bounds.min ?? undefined,
    max: plan ? plan.max : log ? undefined : bounds.max ?? undefined,
  });
  const right = built.some((item) => item.axis === "right");
  const leftName = config.yTitleLeft || built.find((series) => series.axis !== "right")?.name || "";
  const rightName = config.yTitleRight || built.find((series) => series.axis === "right")?.name || "";
  const legendBottom = config.legend === "bottom";
  const withError = (side: "left" | "right", bounds: { min: number | null; max: number | null }, log: boolean) => {
    if (log) return bounds;
    const values = nums(side);
    if (!values.length || !built.some((series) => series.points.some((point) => point.error !== undefined) && (series.axis === "right" ? "right" : "left") === side)) return bounds;
    const high = Math.max(...values);
    const low = Math.min(...values);
    return {
      min: bounds.min ?? (low < 0 ? low : bounds.min),
      max: bounds.max ?? high + Math.abs(high || 1) * 0.08,
    };
  };
  const snap = (bounds: { min: number | null; max: number | null }, values: number[], log: boolean, explicitMin: number | null, explicitMax: number | null) => {
    if (log || !values.length) return { min: explicitMin, max: explicitMax };
    const low = Math.min(...values);
    const high = Math.max(...values);
    const min = explicitMin ?? bounds.min ?? (low >= 0 ? 0 : low);
    const max = explicitMax ?? bounds.max ?? high;
    if (explicitMin != null && explicitMax != null) return { min: explicitMin, max: explicitMax };
    const nice = niceBounds(min, Math.max(max, high));
    return { min: explicitMin ?? nice.min, max: explicitMax ?? nice.max };
  };
  const planValues = (side: "left" | "right") => {
    const values = [...nums(side), ...refs(side)];
    if (!values.length) return values;
    if (axisZero(side)) values.push(0);
    const hasError = built.some((series) => series.points.some((point) => point.error !== undefined) && (series.axis === "right" ? "right" : "left") === side);
    if (hasError) {
      const high = Math.max(...values);
      values.push(high + Math.abs(high || 1) * 0.08);
    }
    return values;
  };
  const makePlan = (side: "x" | "y", log: boolean, values: number[], min: number | null, max: number | null): AxisPlan | null => {
    if (!values.length) return null;
    return axisPlan({
      values,
      log,
      min,
      max,
      mode: side === "x" ? config.xTicks : config.yTicks,
      step: side === "x" ? config.xTickStep : config.yTickStep,
      maxTicks: side === "x" ? config.xTickMax : config.yTickMax,
      format: axisFormat(config, side),
      minor: side === "x" ? config.xMinorTicks || config.gridXMinor : config.yMinorTicks || config.gridYMinor,
      minorDivisions: config.minorDivisions,
    });
  };
  const xValues = numericX
    ? built.flatMap((series) => series.points.flatMap((point) => (typeof point.x === "number" && Number.isFinite(point.x) ? [point.x] : [])))
    : [];
  const xPlan = numericX ? makePlan("x", config.xLog, xValues, null, null) : null;
  const leftPlan = makePlan("y", config.yLogLeft, planValues("left"), config.yMinLeft, config.yMaxLeft);
  const rightPlan = makePlan("y", config.yLogRight, planValues("right"), config.yMinRight, config.yMaxRight);
  const leftAxis = leftPlan ? { min: leftPlan.min, max: leftPlan.max } : snap(withError("left", leftBounds, config.yLogLeft), nums("left"), config.yLogLeft, config.yMinLeft, config.yMaxLeft);
  const rightAxis = rightPlan ? { min: rightPlan.min, max: rightPlan.max } : snap(withError("right", rightBounds, config.yLogRight), nums("right"), config.yLogRight, config.yMinRight, config.yMaxRight);
  const xGap = compact ? 22 : 32;
  const leftTitle = yTitleLayout(horizontal ? "" : leftName, leftAxis, config.yLogLeft, config.fontSize, config.tickFormat);
  const rightTitle = yTitleLayout(horizontal ? "" : rightName, rightAxis, config.yLogRight, config.fontSize, config.tickFormat);
  const xAxis = numericX ? value(config.xLog, config.xTitle || config.x || "", { min: null, max: null }, xGap, "x", xPlan) : horizontal ? value(config.xLog, config.xTitle, leftAxis, xGap, "x", leftPlan) : categoryAxis;
  const yAxis = horizontal
    ? categoryAxis
    : [value(config.yLogLeft, leftName, leftAxis, leftTitle.nameGap, "y", leftPlan), ...(right ? [value(config.yLogRight, rightName, rightAxis, rightTitle.nameGap, "y", rightPlan)] : [])];
  built.forEach((item, index) => {
    const encoding = config.series.find((row) => item.name === row.y || item.name.startsWith(`${row.y} ·`));
    if (!encoding?.error || (encoding.errorKind !== "band" && encoding.errorKind !== "bar")) return;
    const explicit = encoding.color || config.colors[item.name];
    const color = seriesColor({ palette: config.palette, accent: theme.accent, dark: theme.dark, count: built.length, index, explicit });
    const points = item.points.filter((point) => point.y !== null);
    const yAxisIndex = item.axis === "right" ? 1 : 0;
    if (encoding.errorKind === "band") {
      series.push({
        type: "custom",
        name: "",
        silent: true,
        z: 1,
        yAxisIndex,
        xAxisIndex: 0,
        tooltip: { show: false },
        data: points.length ? [[points[0]!.x, points[0]!.y]] : [],
        renderItem: (_params: unknown, api: { coord: (value: unknown[]) => number[] }) => {
          const upper = points.map((point) => api.coord([point.x, (point.y ?? 0) + (point.error ?? 0)]));
          const lower = [...points].reverse().map((point) => api.coord([point.x, (point.y ?? 0) - (point.error ?? 0)]));
          if (upper.length < 2) return { type: "group", children: [] };
          return { type: "polygon", shape: { points: [...upper, ...lower] }, style: { fill: color, opacity: BAND_ALPHA } };
        },
      } as never);
      return;
    }
    series.push({
      type: "custom",
      name: "",
      silent: true,
      z: 5,
      yAxisIndex,
      xAxisIndex: 0,
      tooltip: { show: false },
      data: points.map((point) => [point.x, point.y, point.error ?? 0]),
      renderItem: (_params: unknown, api: { coord: (value: unknown[]) => number[]; value: (index: number) => unknown }) => {
        const x = api.value(0);
        const y = Number(api.value(1));
        const error = Number(api.value(2));
        const high = api.coord([x, y + error]);
        const low = api.coord([x, y - error]);
        const cap = 4;
        const stroke = { stroke: color, lineWidth: 1.25 };
        return {
          type: "group",
          children: [
            { type: "line", shape: { x1: high[0], y1: high[1], x2: low[0], y2: low[1] }, style: stroke },
            { type: "line", shape: { x1: high[0] - cap, y1: high[1], x2: high[0] + cap, y2: high[1] }, style: stroke },
            { type: "line", shape: { x1: low[0] - cap, y1: low[1], x2: low[0] + cap, y2: low[1] }, style: stroke },
          ],
        };
      },
    } as never);
  });

  return {
    ...base,
    grid: { left: leftTitle.pad, right: right ? Math.max(rightTitle.pad, 16) : 12, top: showTitle ? (compact ? 22 : 36) : (compact ? 16 : 12), bottom: compact ? (longLabel ? 18 : 26) : legendBottom ? 48 : 24, containLabel: true },
    dataZoom: compact ? [] : [
      { type: "inside", filterMode: "none", zoomOnMouseWheel: true, moveOnMouseMove: true },
      { type: "slider", filterMode: "none", height: 12, bottom: legendBottom ? 32 : 8, borderColor: theme.line, fillerColor: "rgba(127,127,127,0.12)", textStyle: { color: theme.muted, fontSize: 10 }, showDetail: false, showDataShadow: !heavy, brushSelect: false },
    ],
    brush: compact ? { toolbox: [] as string[], xAxisIndex: 0 } : { toolbox: ["lineX", "clear"], xAxisIndex: 0, brushStyle: { color: "rgba(83,70,214,0.08)", borderColor: theme.accent } },
    legend: compact && config.legend !== "none"
      ? { ...base.legend, top: 0, right: 4, left: undefined, bottom: undefined }
      : base.legend,
    xAxis,
    yAxis,
    series,
  };
}

export function plottedCsv(frame: Frame, config: PlotConfig): string {
  const plotted = plottedRows(buildSeries(frame, config));
  const lines = [plotted.columns.join(",")];
  for (const row of plotted.rows) lines.push(row.map((cell) => (cell === null ? "" : JSON.stringify(cell))).join(","));
  return lines.join("\n");
}
