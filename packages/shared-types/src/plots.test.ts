import assert from "node:assert/strict";
import test from "node:test";
import { buildSeries, lttb, orderPoints, valueAxisBounds } from "./plots-frame.js";
import { matplotlibPanels, matplotlibSource, boilerplate } from "./plots-matplotlib.js";
import { decodeTableText, parseTableText, tableToCsv } from "./plots-parse.js";
import { defaultPlotConfig, figureInches, gridStroke, paintedGrid, seriesColor } from "./plots.js";

test("CSV export preserves quoted headers and cells through a parse round trip", () => {
  const columns = ["label", "revenue, USD"];
  const rows = [['He said "hello"', 10], ["a,b", 20], ["Line\nbreak", 30], ["\u4f60\u597d", null]];
  const csv = tableToCsv(columns, rows);
  assert.match(csv, /^label,"revenue, USD"\r\n/);
  assert.match(csv, /"He said ""hello""",10/);
  const parsed = parseTableText(csv, "csv");
  assert.deepEqual(parsed.columns.map((column) => column.name), columns);
  assert.deepEqual(parsed.rows, rows);
});

test("csv, tsv, pipe text, json, and european decimals parse with types", () => {
  const csv = parseTableText("month,revenue,when\nJan,\"12,000\",2024-01-01\nFeb,15000,2024-02-01\n", "csv");
  assert.equal(csv.columns[0]?.type, "category");
  assert.equal(csv.columns[1]?.type, "number");
  assert.equal(csv.columns[2]?.type, "date");
  assert.equal(csv.rows[0]?.[1], 12000);

  const tsv = parseTableText("a\tb\n1\t2\n3\t4\n", "tsv");
  assert.equal(tsv.delimiter, "\t");
  assert.equal(tsv.rows[1]?.[1], 4);

  const pipe = parseTableText("name|score\nalpha|1,5\nbeta|2,5\n", "txt");
  assert.equal(pipe.delimiter, "|");
  assert.equal(pipe.rows[0]?.[1], 1.5);

  const json = parseTableText('[{"city":"A","n":1},{"city":"B","n":2}]', "json");
  assert.deepEqual(json.columns.map((column) => column.name), ["city", "n"]);
  assert.equal(json.rows[1]?.[1], 2);

  const lines = parseTableText('{"k":1}\n{"k":2}\n', "jsonl");
  assert.equal(lines.rows.length, 2);
});

test("windows-1252 bytes decode when they are not utf-8", () => {
  const bytes = Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x31]);
  assert.match(decodeTableText(bytes), /caf/);
});

test("aggregation groups rows and LTTB keeps a 100k series small", () => {
  const frame = {
    columns: [
      { name: "city", type: "category" as const },
      { name: "n", type: "number" as const },
    ],
    rows: [
      ["A", 1],
      ["A", 3],
      ["B", 10],
    ],
  };
  const config = defaultPlotConfig();
  config.x = "city";
  config.series = [{ y: "n", axis: "left" }];
  config.agg = "mean";
  const series = buildSeries(frame, config);
  assert.equal(series[0]?.points.find((point) => point.x === "A")?.y, 2);

  const big = Array.from({ length: 100_000 }, (_, index) => ({ x: index, y: Math.sin(index / 40) }));
  const started = Date.now();
  const sampled = lttb(big, 4000);
  assert.ok(Date.now() - started < 2000);
  assert.ok(sampled.length <= 4000);
  assert.equal(sampled[0]?.x, 0);
  assert.equal(sampled.at(-1)?.x, 99_999);
});

test("matplotlib export uses publication sizes and does not leak a path", () => {
  const config = defaultPlotConfig();
  config.chart = "combo";
  config.x = "month";
  config.series = [
    { y: "revenue", axis: "left", mark: "bar" },
    { y: "cost", axis: "right", mark: "line" },
  ];
  config.annotations = [{ id: "t", kind: "hline", y: 10000, axis: "left", label: "Target", color: "#D55E00", style: "dashed" }];
  config.preset = "icml";
  config.figure = "double";
  const source = matplotlibSource({
    datasetName: "sales",
    columns: [
      { name: "month", type: "category" },
      { name: "revenue", type: "number" },
      { name: "cost", type: "number" },
    ],
    config,
  });
  assert.match(source, /from ensemble_plots import load, save, apply_style/);
  assert.match(source, /figsize=\(7/);
  assert.match(source, /_arrange\(df, "month", "none"\)/);
  assert.match(source, /january/);
  assert.match(source, /set_ylim/);
  assert.match(source, /axhline\(10000/);
  assert.match(source, /twinx/);
  assert.match(source, /outside lower center/);
  assert.match(source, /_tag\(ax, 10000, "Target"/);
  assert.match(source, /spines\['right'\]\.set_visible\(True\)/);
  assert.doesNotMatch(source, /lower center", frameon/);
  assert.match(boilerplate("sales"), /apply_style/);
  assert.doesNotMatch(source, /\/Users\/|C:\\|\/tmp\//);
  assert.match(source, /ax\.grid\(which="major"/);
  assert.deepEqual(figureInches("neurips", "single", { widthIn: 1, heightIn: 1 }), { widthIn: 1, heightIn: 1 });
  assert.deepEqual(figureInches("iclr", "double", { widthIn: 1, heightIn: 1 }), { widthIn: 7, heightIn: 3.5 });
  config.xLog = true;
  config.yLogLeft = true;
  config.series = [{ y: "revenue", axis: "left" }, { y: "month", axis: "left" }];
  const logged = matplotlibSource({
    datasetName: "sales",
    columns: [
      { name: "month", type: "category" },
      { name: "revenue", type: "number" },
    ],
    config,
  });
  assert.match(logged, /month is a category, hidden on this chart/);
  assert.match(logged, /revenue values ≤ 0 are hidden on the log axis/);
});

test("grid strokes keep the major line at least as visible as the minor line", () => {
  const config = defaultPlotConfig();
  config.gridYMinor = true;
  const major = gridStroke(config, "y", false);
  const minor = gridStroke(config, "y", true);
  assert.ok(major.width >= minor.width);
  assert.ok(major.alpha >= minor.alpha);
  assert.equal(minor.width, config.minorGridWidth);
  assert.equal(minor.alpha, config.minorGridAlpha);
  config.gridXMinor = false;
  assert.equal(gridStroke(config, "x", false).alpha, config.gridAlpha);
  const paintedMajor = paintedGrid(config, "y", false, false);
  const paintedMinor = paintedGrid(config, "y", true, false);
  assert.equal(paintedMajor.width, major.width);
  assert.equal(paintedMinor.alpha, minor.alpha);
  const source = matplotlibSource({
    datasetName: "sales",
    columns: [
      { name: "month", type: "category" },
      { name: "revenue", type: "number" },
    ],
    config,
  });
  const channel = (value: number) => String(Math.round((value / 255) * 1e6) / 1e6);
  const rgba = (paint: { red: number; green: number; blue: number; alpha: number }) => `\\(${channel(paint.red)}, ${channel(paint.green)}, ${channel(paint.blue)}, ${paint.alpha}\\)`;
  assert.match(source, new RegExp(`axis="y", visible=True, linestyle="solid", linewidth=${paintedMajor.width}, color=${rgba(paintedMajor)}, alpha=1`));
  assert.match(source, new RegExp(`which="minor", axis="y", visible=True, linestyle=\\(0, \\(2, 2\\)\\), linewidth=${paintedMinor.width}, color=${rgba(paintedMinor)}, alpha=1`));
  assert.doesNotMatch(source, /linewidth=0\.9/);
});

test("matplotlib export uses the theme accent the canvas draws", () => {
  const config = defaultPlotConfig();
  config.chart = "line";
  config.palette = "okabe-ito";
  config.x = "month";
  config.series = [{ y: "revenue", axis: "left" }];
  const accent = "#7c6af7";
  assert.equal(seriesColor({ palette: "okabe-ito", accent, count: 1, index: 0 }), accent);
  const source = matplotlibSource({
    datasetName: "sales",
    columns: [
      { name: "month", type: "category" },
      { name: "revenue", type: "number" },
    ],
    config,
    accent,
  });
  assert.match(source, new RegExp(`color="${accent}"`));
  const panels = matplotlibPanels(
    [{ title: "Revenue", datasetName: "sales", x: "month", ys: ["revenue"], chart: "line", palette: "accent", series: [{ y: "revenue" }] }],
    { accent },
  );
  assert.match(panels, new RegExp(`color="${accent}"`));
  assert.doesNotMatch(panels, /#0072B2/);
});

test("categorical axes keep row order, and months and dates stay chronological", () => {
  const months = {
    columns: [
      { name: "month", type: "category" as const },
      { name: "revenue", type: "number" as const },
    ],
    rows: [
      ["Apr", 1],
      ["Feb", 2],
      ["Jan", 3],
      ["Mar", 4],
    ],
  };
  const config = defaultPlotConfig();
  config.chart = "bar";
  config.x = "month";
  config.sort = "none";
  config.series = [{ y: "revenue", axis: "left" }];
  assert.deepEqual(buildSeries(months, config)[0]?.points.map((point) => point.x), ["Jan", "Feb", "Mar", "Apr"]);

  const regions = {
    columns: [
      { name: "region", type: "category" as const },
      { name: "n", type: "number" as const },
    ],
    rows: [
      ["North", 1],
      ["South", 2],
      ["East", 3],
    ],
  };
  config.x = "region";
  config.series = [{ y: "n", axis: "left" }];
  assert.deepEqual(buildSeries(regions, config)[0]?.points.map((point) => point.x), ["North", "South", "East"]);

  const dates = orderPoints(
    [
      { x: "2024-03-01", y: 1 },
      { x: "2024-01-01", y: 2 },
      { x: "2024-02-01", y: 3 },
    ],
    "none",
  );
  assert.deepEqual(dates.map((point) => point.x), ["2024-01-01", "2024-02-01", "2024-03-01"]);
});

test("bar axes include zero and a threshold below the bars", () => {
  const bars = valueAxisBounds({ zero: true, values: [12000, 15000, 18000], reference: [10000], min: null, max: null });
  assert.equal(bars.min, 0);
  assert.ok((bars.max ?? 18000) >= 10000);
  const line = valueAxisBounds({ zero: false, values: [12000, 18000], reference: [], min: null, max: null });
  assert.equal(line.min, null);
  const above = valueAxisBounds({ zero: true, values: [12000], reference: [30000], min: null, max: null });
  assert.equal(above.min, 0);
  assert.ok((above.max ?? 0) >= 30000);
});

test("log minor ticks sit where ECharts draws them: equal value steps inside each decade", async () => {
  const { axisPlan } = await import("./plots-axis.js");
  const plan = axisPlan({ values: [1000, 1e5], log: true, min: null, max: null, mode: "auto", step: null, format: "auto", minor: true, minorDivisions: 5 });
  assert.deepEqual(plan.ticks, [1000, 10000, 100000]);
  assert.deepEqual(plan.minorTicks.map((value) => Math.round(value)), [2800, 4600, 6400, 8200, 28000, 46000, 64000, 82000]);
  const source = matplotlibSource({
    datasetName: "scaling",
    columns: [{ name: "compute", type: "number" }, { name: "loss", type: "number" }],
    config: { ...defaultPlotConfig(), chart: "line", x: "compute", xLog: true, gridXMinor: true, series: [{ y: "loss", axis: "left" }] },
    rows: [[1000, 3], [100000, 1]],
    rowColumns: ["compute", "loss"],
  });
  assert.match(source, /ax\.xaxis\.set_minor_locator\(FixedLocator\(\[2800, 4600, 6400, 8200, 28000/);
});

test("a dark canvas export paints every panel, its letter title, box whiskers, and the legend text", () => {
  const rows = [["A", 1], ["A", 2], ["B", 3], ["B", 9]];
  const source = matplotlibPanels(
    [
      { title: "Spread", datasetName: "d", x: "g", ys: ["v"], chart: "box", columns: ["g", "v"], rows },
      { title: "Confusion", datasetName: "c", x: "actual", ys: ["predicted", "count"], chart: "heatmap", columns: ["actual", "predicted", "count"], rows: [["cat", "cat", 3], ["cat", "dog", 1], ["dog", "cat", 2], ["dog", "dog", 4]] },
      { title: "Curve", datasetName: "t", x: "step", ys: ["loss"], chart: "line", columns: ["step", "loss"], rows: [[1, 2], [2, 1]] },
    ],
    { dark: true, accent: "#7c6af7" },
  );
  assert.equal(source.match(/_ax\.set_facecolor\("#221e1a"\)/g)?.length, 3);
  assert.match(source, /set_title\("\(a\)  Spread", fontsize=9, loc="left", pad=10, color="#f3eee6"\)/);
  assert.match(source, /_drawn\['whiskers'\] \+ _drawn\['caps'\]/);
  assert.match(source, /fig\.legend\([^\n]*labelcolor="#f3eee6"\)/);
  const light = matplotlibPanels([{ title: "Curve", datasetName: "t", x: "step", ys: ["loss"], chart: "line" }], {});
  assert.doesNotMatch(light, /labelcolor|_drawn\['whiskers'\]|color="#f3eee6"/);
});
