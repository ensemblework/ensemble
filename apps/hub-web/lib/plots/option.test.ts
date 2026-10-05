import assert from "node:assert/strict";
import test from "node:test";
import { defaultPlotConfig } from "@ensemble/shared-types";
import { chartOption, logTickLabel, niceBounds, tooltipFormatter } from "./option.js";

test("combo bars start at zero, keep month order, and draw the threshold", () => {
  const config = defaultPlotConfig();
  config.chart = "combo";
  config.x = "month";
  config.series = [
    { y: "revenue", axis: "left", mark: "bar" },
    { y: "cost", axis: "right", mark: "line" },
  ];
  config.annotations = [{ id: "t", kind: "hline", y: 10000, axis: "left", label: "Threshold", color: "#D55E00", style: "dashed" }];
  const option = chartOption(
    {
      columns: [
        { name: "month", type: "category" },
        { name: "revenue", type: "number" },
        { name: "cost", type: "number" },
      ],
      rows: [
        ["Jan", 12000, 8000],
        ["Feb", 15000, 9000],
        ["Mar", 18000, 11000],
        ["Apr", 14000, 10000],
      ],
    },
    config,
    { ink: "#111", muted: "#666", line: "#ddd", panel: "#fff", accent: "#f0a0b8", dark: false },
  );
  const y = option.yAxis as Array<{ min?: number; name?: string }>;
  assert.equal(y[0]?.min, 0);
  assert.equal(y[1]?.name, "cost");
  const x = option.xAxis as { data?: string[]; nameLocation?: string };
  assert.deepEqual(x.data, ["Jan", "Feb", "Mar", "Apr"]);
  assert.equal(x.nameLocation, "middle");
  const series = option.series as Array<{ markLine?: { data: unknown[] } }>;
  const line = JSON.stringify(series[0]?.markLine);
  assert.match(line, /10000/);
  assert.match(line, /Threshold/);
  const pies = chartOption(
    {
      columns: [
        { name: "month", type: "category" },
        { name: "revenue", type: "number" },
        { name: "cost", type: "number" },
      ],
      rows: [
        ["Jan", 12000, 8000],
        ["Feb", 15000, 9000],
      ],
    },
    { ...config, chart: "pie", pieLabels: "both" },
    { ink: "#111", muted: "#666", line: "#ddd", panel: "#fff", accent: "#f0a0b8", dark: false },
  );
  assert.equal((pies.series as unknown[]).length, 2);
});

const theme = { ink: "#111", muted: "#666", line: "#ddd", panel: "#fff", accent: "#be185d", dark: false };

test("a training band is a polygon, ablation draws error bars, and scaling is log-log", () => {
  const band = chartOption(
    {
      columns: [
        { name: "step", type: "number" },
        { name: "loss", type: "number" },
        { name: "loss std", type: "number" },
      ],
      rows: [[1, 1.2, 0.11], [2, 0.8, 0.08], [3, 0.4, 0.05]],
    },
    { ...defaultPlotConfig(), chart: "line", x: "step", series: [{ y: "loss", axis: "left", error: "loss std", errorKind: "band" }] },
    theme,
    { compact: true },
  );
  const bandSeries = band.series as Array<{ type?: string; areaStyle?: unknown }>;
  assert.equal(bandSeries.some((item) => item.type === "custom"), true);
  assert.equal(bandSeries.find((item) => item.type === "line")?.areaStyle, undefined);
  assert.equal((band.xAxis as { type?: string }).type, "value");
  assert.equal((band.dataZoom as unknown[]).length, 0);

  const bars = chartOption(
    {
      columns: [
        { name: "method", type: "category" },
        { name: "score", type: "number" },
        { name: "std", type: "number" },
      ],
      rows: [["Baseline", 61.4, 1.6], ["Dropout", 64.2, 0.9]],
    },
    { ...defaultPlotConfig(), chart: "bar", x: "method", series: [{ y: "score", axis: "left", error: "std", errorKind: "bar" }] },
    theme,
    { compact: true },
  );
  assert.equal((bars.series as Array<{ type?: string }>).some((item) => item.type === "custom"), true);
  const yMax = (bars.yAxis as Array<{ max?: number }>)[0]?.max ?? 0;
  assert.ok(yMax > 64.2);

  const log = chartOption(
    {
      columns: [
        { name: "compute", type: "number" },
        { name: "loss", type: "number" },
      ],
      rows: [[1000, 2.1], [10000, 1.2], [100000, 0.7]],
    },
    { ...defaultPlotConfig(), chart: "line", x: "compute", xLog: true, yLogLeft: true, series: [{ y: "loss", axis: "left" }] },
    theme,
    { compact: true },
  );
  assert.equal((log.xAxis as { type?: string }).type, "log");
  assert.equal((log.yAxis as Array<{ type?: string }>)[0]?.type, "log");
  assert.equal((log.xAxis as { min?: number }).min, 1000);
  assert.equal((log.xAxis as { max?: number }).max, 100000);
  assert.equal((log.yAxis as Array<{ min?: number }>)[0]?.min, 0.1);
  assert.equal((log.yAxis as Array<{ max?: number }>)[0]?.max, 10);
  const xLabel = (log.xAxis as { axisLabel?: { formatter?: (value: number) => string } }).axisLabel?.formatter;
  assert.equal(xLabel?.(1000), "10³");
  assert.equal(xLabel?.(10000), "10⁴");
  assert.equal((log.xAxis as { name?: string }).name, "compute");
});

test("tooltip uses the tick formatter instead of a raw float", () => {
  const text = tooltipFormatter(
    [{ marker: "", seriesName: "loss", axisValue: 89125093.8100000024, data: [89125093.8100000024, 1.2] }],
    "auto",
  );
  assert.equal(text.includes("8100000024"), false);
  assert.match(text, /89/);
  assert.equal(logTickLabel(1000), "10³");
});

test("a non-positive series on a log axis does not remove the valid series", () => {
  const option = chartOption(
    {
      columns: [
        { name: "compute", type: "number" },
        { name: "loss", type: "number" },
        { name: "std", type: "number" },
        { name: "method", type: "category" },
      ],
      rows: [
        [1000, 2.1, -1, "A"],
        [10000, 1.2, 0, "B"],
      ],
    },
    {
      ...defaultPlotConfig(),
      chart: "line",
      x: "compute",
      xLog: true,
      yLogLeft: true,
      series: [
        { y: "loss", axis: "left" },
        { y: "std", axis: "left" },
        { y: "method", axis: "left" },
      ],
    },
    theme,
  );
  const series = option.series as Array<{ name?: string; data?: unknown[] }>;
  assert.equal(series.some((item) => item.name === "loss" && (item.data?.length ?? 0) > 0), true);
  assert.equal(series.some((item) => item.name === "std"), false);
  assert.equal(series.some((item) => item.name === "method"), false);
  assert.equal((option.xAxis as { type?: string }).type, "log");
});

test("axes end on a nice number and category labels are not skipped", () => {
  assert.equal(logTickLabel(1e3), "10³");
  assert.deepEqual(niceBounds(0, 78.84), { min: 0, max: 80 });
  const bars = chartOption(
    {
      columns: [
        { name: "method", type: "category" },
        { name: "score", type: "number" },
        { name: "std", type: "number" },
      ],
      rows: [
        ["Baseline", 61.4, 1.6],
        ["Dropout", 64.2, 0.9],
        ["Label smoothing", 66.1, 1.1],
        ["Mixup", 67.8, 1.4],
        ["EMA", 69.5, 0.7],
        ["Longer train", 71.2, 1.8],
      ],
    },
    { ...defaultPlotConfig(), chart: "bar", x: "method", title: "Ablation bars", series: [{ y: "score", axis: "left", error: "std", errorKind: "bar" }] },
    theme,
    { compact: true, showTitle: false },
  );
  const y = (bars.yAxis as Array<{ min?: number; max?: number; name?: string; nameGap?: number }>)[0];
  assert.equal(y?.min, 0);
  assert.equal(y?.max, 80);
  assert.equal(y?.name, "score");
  const grid = bars.grid as { left?: number };
  assert.ok((y?.nameGap ?? 0) > 36, `nameGap ${y?.nameGap} still overlaps the ticks`);
  assert.ok((grid.left ?? 0) > (y?.nameGap ?? 0), `left pad ${grid.left} clips the title`);
  const labels = bars.xAxis as { axisLabel?: { interval?: number; hideOverlap?: boolean }; data?: string[] };
  assert.equal(labels.axisLabel?.interval, 0);
  assert.equal(labels.axisLabel?.hideOverlap, false);
  assert.equal(labels.data?.length, 6);
  assert.equal(bars.title, undefined);

  const focus = chartOption(
    {
      columns: [
        { name: "step", type: "number" },
        { name: "train", type: "number" },
        { name: "train std", type: "number" },
        { name: "eval", type: "number" },
        { name: "eval std", type: "number" },
      ],
      rows: [[1, 2.1, 0.1, 2.4, 0.2], [50, 0.4, 0.05, 0.6, 0.08]],
    },
    { ...defaultPlotConfig(), chart: "line", x: "step", yTitleLeft: "loss", title: "Training curve", series: [
      { y: "train", axis: "left", error: "train std", errorKind: "band" },
      { y: "eval", axis: "left", error: "eval std", errorKind: "band" },
    ] },
    theme,
    { showTitle: false },
  );
  const focusY = (focus.yAxis as Array<{ name?: string; nameGap?: number }>)[0];
  assert.equal(focusY?.name, "loss");
  assert.ok((focusY?.nameGap ?? 0) > 36);
  assert.ok(((focus.grid as { left?: number }).left ?? 0) > (focusY?.nameGap ?? 0));
});

test("max ticks set an interval, a notch stays out of the legend, and minor grid keeps contrast", () => {
  const ticks = chartOption(
    {
      columns: [
        { name: "x", type: "number" },
        { name: "y", type: "number" },
      ],
      rows: [[0, 0], [1, 10], [2, 20], [3, 40]],
    },
    { ...defaultPlotConfig(), chart: "line", x: "x", yTicks: "max", yTickMax: 4, series: [{ y: "y", axis: "left" }] },
    { ...theme, dark: true },
  );
  const y = (ticks.yAxis as Array<{ interval?: number; maxInterval?: number; splitNumber?: number }>)[0];
  assert.ok(y?.interval && y.interval > 0, `interval ${y?.interval}`);
  assert.equal(y?.maxInterval, y?.interval);
  assert.equal(y?.splitNumber, undefined);

  const box = chartOption(
    {
      columns: [
        { name: "group", type: "category" },
        { name: "value", type: "number" },
      ],
      rows: [["a", 1], ["a", 2], ["a", 3], ["a", 4], ["b", 2], ["b", 3], ["b", 5], ["b", 8]],
    },
    { ...defaultPlotConfig(), chart: "box", x: "group", boxNotch: true, series: [{ y: "value", axis: "left" }] },
    theme,
  );
  const legend = box.legend as { data?: Array<{ name?: string; itemStyle?: { color?: string; borderColor?: string } }>; bottom?: number };
  const names = (legend.data ?? []).map((item) => item.name);
  assert.equal(names.includes("Notch"), false);
  assert.equal((box.series as Array<{ name?: string }>).some((item) => item.name === "Notch"), false);
  const swatch = legend.data?.find((item) => item.name === "value");
  assert.ok(swatch?.itemStyle?.color);
  assert.notEqual(swatch?.itemStyle?.color, theme.ink);
  assert.equal(swatch?.itemStyle?.borderColor, swatch?.itemStyle?.color);
  assert.ok(((box.grid as { bottom?: number }).bottom ?? 0) >= 48);
  const tileBox = chartOption(
    {
      columns: [
        { name: "group", type: "category" },
        { name: "value", type: "number" },
      ],
      rows: [["a", 1], ["a", 2], ["a", 3], ["a", 4], ["b", 2], ["b", 3], ["b", 5], ["b", 8]],
    },
    { ...defaultPlotConfig(), chart: "box", x: "group", boxNotch: true, series: [{ y: "value", axis: "left" }] },
    theme,
    { compact: true },
  );
  const tileLegend = tileBox.legend as { top?: number; bottom?: number };
  assert.equal(tileLegend.bottom, undefined);
  assert.equal(typeof tileLegend.top, "number");
  assert.ok(((tileBox.grid as { top?: number }).top ?? 0) >= 24);

  const grid = chartOption(
    {
      columns: [
        { name: "x", type: "category" },
        { name: "y", type: "number" },
      ],
      rows: [["a", 1], ["b", 4]],
    },
    { ...defaultPlotConfig(), chart: "bar", x: "x", gridYMinor: true, series: [{ y: "y", axis: "left" }] },
    { ink: "#f3eee6", muted: "#a8a29e", line: "rgba(243,238,230,0.08)", panel: "#141210", accent: "#f0a0b8", dark: true },
  );
  const yAxis = (grid.yAxis as Array<{ splitLine?: { lineStyle?: { color?: string; width?: number; opacity?: number } }; minorSplitLine?: { lineStyle?: { color?: string; width?: number; opacity?: number } } }>)[0];
  const minor = yAxis?.minorSplitLine?.lineStyle;
  const major = yAxis?.splitLine?.lineStyle;
  assert.equal(minor?.color, "rgba(243, 238, 230, 0.55)");
  assert.equal(minor?.width, 0.65);
  assert.equal(minor?.opacity, 1);
  assert.equal(major?.color, "rgba(243, 238, 230, 0.65)");
  assert.equal(major?.width, 1);
  assert.ok((major?.width ?? 0) >= (minor?.width ?? 0));
  const majorAlpha = Number(major?.color?.match(/[\d.]+\)/)?.[0]?.replace(")", ""));
  const minorAlpha = Number(minor?.color?.match(/[\d.]+\)/)?.[0]?.replace(")", ""));
  assert.ok(majorAlpha >= minorAlpha);

  const light = chartOption(
    {
      columns: [
        { name: "x", type: "category" },
        { name: "y", type: "number" },
      ],
      rows: [["a", 1], ["b", 4]],
    },
    { ...defaultPlotConfig(), chart: "bar", x: "x", gridYMinor: true, minorGridAlpha: 0.2, series: [{ y: "y", axis: "left" }] },
    { ink: "#1c1915", muted: "#6d675e", line: "rgba(28,25,21,0.08)", panel: "#fffcf7", accent: "#5346d6", dark: false },
  );
  const lightMajor = (light.yAxis as Array<{ splitLine?: { lineStyle?: { color?: string; width?: number } } }>)[0]?.splitLine?.lineStyle;
  assert.equal(lightMajor?.color, "rgba(28, 25, 21, 0.5)");
  assert.equal(lightMajor?.width, 1);
});

test("a confusion matrix keeps class order with the first class at the top", () => {
  const option = chartOption(
    {
      columns: [
        { name: "actual", type: "category" },
        { name: "predicted", type: "category" },
        { name: "count", type: "number" },
      ],
      rows: [
        ["cat", "cat", 48],
        ["cat", "dog", 4],
        ["dog", "dog", 44],
        ["bird", "bird", 51],
        ["deer", "deer", 46],
      ],
    },
    { ...defaultPlotConfig(), chart: "heatmap", x: "actual", series: [{ y: "predicted", axis: "left" }, { y: "count", axis: "left" }] },
    theme,
    { compact: true, showTitle: false },
  );
  const x = option.xAxis as { data?: string[] };
  const y = option.yAxis as { data?: string[]; inverse?: boolean };
  assert.deepEqual(x.data, ["cat", "dog", "bird", "deer"]);
  assert.deepEqual(y.data, ["cat", "dog", "bird", "deer"]);
  assert.equal(y.inverse, true);
});
