import assert from "node:assert/strict";
import test from "node:test";
import { prepareSeries } from "./plots-frame.js";
import { matplotlibPanels } from "./plots-matplotlib.js";
import { chartFrame } from "./plots-pool.js";
import { parseTableText } from "./plots-parse.js";
import { sampleTables, sampleTiles } from "./plots-sample.js";

test("sample runs cover three seeds and fifty steps, and the training tile shades the std", () => {
  const tables = sampleTables();
  assert.deepEqual(tables.map((table) => table.key), ["runs", "ablation", "scaling", "confusion", "scores"]);
  const runs = parseTableText(tables[0]!.csv, "csv");
  const steps = new Set(runs.rows.map((row) => row[0]));
  const seeds = new Set(runs.rows.map((row) => row[1]));
  assert.equal(steps.size, 50);
  assert.equal(seeds.size, 3);
  assert.equal(Math.min(...[...steps].map(Number)), 1);
  const ids = { runs: "11111111-1111-4111-8111-111111111111", ablation: "22222222-2222-4222-8222-222222222222", scaling: "33333333-3333-4333-8333-333333333333", confusion: "44444444-4444-4444-8444-444444444444", scores: "55555555-5555-4555-8555-555555555555" };
  const tiles = sampleTiles(ids);
  const train = tiles[0]!;
  const parsed = parseTableText(tables[0]!.csv, "csv");
  const view = chartFrame([{ id: ids.runs, name: tables[0]!.name, columns: parsed.columns, rows: parsed.rows }], train, {});
  assert.equal(view.config.series.length, 2);
  assert.deepEqual(view.config.series.map((series) => series.y), ["train", "eval"]);
  assert.ok(view.config.series.every((series) => series.errorKind === "band" && series.error));
  assert.equal(view.frame.rows.length, 50);
  const xs = view.frame.rows.map((row) => Number(row[0]));
  assert.equal(xs[0], 1);
  for (let index = 1; index < xs.length; index += 1) assert.ok(xs[index]! > xs[index - 1]!, `x is not monotonic at ${index}`);
  const std = view.frame.rows.map((row) => Number(row[2]));
  assert.ok(std.some((value) => value > 0.02));
  const script = matplotlibPanels([{
    title: "Training curve",
    datasetName: tables[0]!.name,
    x: view.config.x ?? "step",
    ys: view.config.series.map((series) => series.y),
    yTitle: view.config.yTitleLeft || "loss",
    chart: "line",
    columns: view.frame.columns.map((column) => column.name),
    rows: view.frame.rows,
    series: view.config.series.map((series) => ({ y: series.y, error: series.error, errorKind: series.errorKind })),
  }]);
  assert.equal(script.match(/_ax\.plot\(/g)?.length, 2);
  assert.equal(script.match(/fill_between/g)?.length, 2);
  assert.match(script, /sort_values/);
  assert.match(script, /\(a\)  Training curve/);
  assert.match(script, /_ax\.set_ylim\(0, 3\)/);
  assert.equal(script.includes("transAxes"), false);
  const scaling = tiles[2]!;
  assert.equal(scaling.xLog, true);
  assert.equal(scaling.yLogLeft, true);
  const ablation = tiles[1]!;
  assert.equal(ablation.series[0]?.errorKind, "bar");
  const ablationTable = parseTableText(tables[1]!.csv, "csv");
  const ablationView = chartFrame([{ id: ids.ablation, name: tables[1]!.name, columns: ablationTable.columns, rows: ablationTable.rows }], ablation, {});
  const bars = matplotlibPanels([{
    title: "Ablation bars",
    datasetName: tables[1]!.name,
    x: ablationView.config.x ?? "method",
    ys: ablationView.config.series.map((series) => series.y),
    yTitle: "score",
    chart: "bar",
    columns: ablationView.frame.columns.map((column) => column.name),
    rows: ablationView.frame.rows,
    series: ablationView.config.series.map((series) => ({ y: series.y, error: series.error, errorKind: series.errorKind })),
  }]);
  assert.match(bars, /_ax\.set_ylim\(0, 80\)/);
  assert.match(bars, /set_rotation\(28\)/);
  const scale = parseTableText(tables[2]!.csv, "csv");
  const computes = scale.rows.map((row) => Number(row[0]));
  assert.ok(Math.max(...computes) / Math.min(...computes) > 1000);

  const confusion = parseTableText(tables[3]!.csv, "csv");
  const matrix = tiles[3]!;
  const matrixView = chartFrame([{ id: ids.confusion, name: tables[3]!.name, columns: confusion.columns, rows: confusion.rows }], matrix, {});
  const scalingView = chartFrame([{ id: ids.scaling, name: tables[2]!.name, columns: scale.columns, rows: scale.rows }], scaling, {});
  const figure = matplotlibPanels([
    {
      title: "Training curve",
      datasetName: tables[0]!.name,
      x: view.config.x ?? "step",
      ys: view.config.series.map((series) => series.y),
      yTitle: view.config.yTitleLeft || "loss",
      chart: "line",
      columns: view.frame.columns.map((column) => column.name),
      rows: view.frame.rows,
      series: view.config.series.map((series) => ({ y: series.y, error: series.error, errorKind: series.errorKind })),
    },
    {
      title: "Ablation bars",
      datasetName: tables[1]!.name,
      x: ablationView.config.x ?? "method",
      ys: ablationView.config.series.map((series) => series.y),
      yTitle: "score",
      chart: "bar",
      columns: ablationView.frame.columns.map((column) => column.name),
      rows: ablationView.frame.rows,
      series: ablationView.config.series.map((series) => ({ y: series.y, error: series.error, errorKind: series.errorKind })),
    },
    {
      title: "Scaling law",
      datasetName: tables[2]!.name,
      x: scalingView.config.x ?? "compute",
      ys: scalingView.config.series.map((series) => series.y),
      yTitle: "loss",
      chart: "line",
      xLog: true,
      yLog: true,
      columns: scalingView.frame.columns.map((column) => column.name),
      rows: scalingView.frame.rows,
      series: scalingView.config.series.map((series) => ({ y: series.y, error: series.error, errorKind: series.errorKind })),
    },
    {
      title: "Confusion matrix",
      datasetName: tables[3]!.name,
      x: matrixView.config.x ?? "actual",
      ys: matrixView.config.series.map((series) => series.y),
      chart: "heatmap",
      columns: matrixView.frame.columns.map((column) => column.name),
      rows: matrixView.frame.rows,
    },
  ], { preset: "icml", width: "double", columns: 2 });
  const size = figure.match(/figsize=\(([0-9.]+), ([0-9.]+)\)/);
  assert.ok(size, "the figure sets an explicit size");
  const width = Number(size![1]);
  const height = Number(size![2]);
  assert.equal(width, 7);
  const ratio = height / width;
  assert.ok(ratio >= 0.55 && ratio <= 0.65, `a 2×2 figure should be 0.55–0.65× its width, got ${ratio}`);
  assert.match(figure, /set_box_aspect\(1\)/);
  assert.match(figure, /reindex\(index=_classes, columns=_classes\)/);
  assert.match(figure, /_label\.set_rotation\(70\)/);
  assert.match(figure, /def _swatch/);
  assert.match(figure, /if swatch in _seen/);
});

test("sample defaults do not warn about unselected series, and a heatmap class is not hidden", () => {
  const tables = sampleTables();
  const ids = { runs: "11111111-1111-4111-8111-111111111111", ablation: "22222222-2222-4222-8222-222222222222", scaling: "33333333-3333-4333-8333-333333333333", confusion: "44444444-4444-4444-8444-444444444444", scores: "55555555-5555-4555-8555-555555555555" };
  const tiles = sampleTiles(ids);
  const datasets = tables.map((table) => {
    const parsed = parseTableText(table.csv, "csv");
    return { id: ids[table.key], name: table.name, columns: parsed.columns, rows: parsed.rows };
  });
  const scaling = tiles.find((tile) => tile.id === "sample-scaling")!;
  const scalingView = chartFrame(datasets, scaling, {});
  const scalingNotes = [...scalingView.warnings, ...prepareSeries(scalingView.frame, scalingView.config).warnings].join(" ");
  assert.doesNotMatch(scalingNotes, /step/);
  const matrix = tiles.find((tile) => tile.id === "sample-confusion")!;
  const matrixView = chartFrame(datasets, matrix, {});
  const matrixNotes = [...matrixView.warnings, ...prepareSeries(matrixView.frame, matrixView.config).warnings].join(" ");
  assert.doesNotMatch(matrixNotes, /predicted is a category/);
  const box = tiles.find((tile) => tile.id === "sample-box")!;
  const boxView = chartFrame(datasets, box, {});
  const script = matplotlibPanels([{
    title: box.title,
    datasetName: "Sample · Scores",
    x: boxView.config.x ?? "group",
    ys: boxView.config.series.map((series) => series.y),
    chart: "box",
    columns: boxView.frame.columns.map((column) => column.name),
    rows: boxView.frame.rows,
    boxNotch: boxView.config.boxNotch,
    boxOutliers: boxView.config.boxOutliers,
    boxWhisker: boxView.config.boxWhisker,
  }]);
  assert.match(script, /_ax\.boxplot\(/);
  assert.match(script, /notch=True/);
  assert.doesNotMatch(script, /_ax\.plot\(/);
});
