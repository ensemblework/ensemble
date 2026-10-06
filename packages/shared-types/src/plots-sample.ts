import { columnRef } from "./plots-pool.js";
import { tableToCsv } from "./plots-parse.js";
import { tileSchema, type WorkspaceTile } from "./plots-workspace.js";

export type SampleKey = "runs" | "ablation" | "scaling" | "confusion" | "scores";

export type SampleTable = {
  key: SampleKey;
  name: string;
  filename: string;
  csv: string;
};

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function csv(header: string[], rows: Array<Array<string | number>>): string {
  return `${tableToCsv(header, rows)}\r\n`;
}

/** Three seeds, fifty steps, train and eval. Loss decays; accuracy rises; seeds disagree enough to shade. */
function runsTable(): SampleTable {
  const random = rng(7);
  const rows: Array<Array<string | number>> = [];
  for (const split of ["train", "eval"] as const) {
    for (let seed = 1; seed <= 3; seed += 1) {
      const bias = (seed - 2) * 0.11;
      for (let step = 1; step <= 50; step += 1) {
        const noise = (random() - 0.5) * 0.03;
        const decay = Math.exp(-step / 16);
        const loss = (split === "train" ? 2.35 : 2.55) * decay + (split === "train" ? 0.16 : 0.28) + bias + noise;
        const accuracy = (split === "train" ? 0.93 : 0.86) - (split === "train" ? 0.78 : 0.7) * decay + bias * 0.15 + noise;
        rows.push([step, seed, split, Number(loss.toFixed(4)), Number(Math.min(0.99, Math.max(0.05, accuracy)).toFixed(4))]);
      }
    }
  }
  return { key: "runs", name: "Sample · Runs", filename: "sample-runs.csv", csv: csv(["step", "seed", "split", "loss", "accuracy"], rows) };
}

function ablationTable(): SampleTable {
  const rows = [
    ["Baseline", 61.4, 1.6],
    ["Dropout", 64.2, 0.9],
    ["Label smoothing", 66.1, 1.1],
    ["Mixup", 67.8, 1.4],
    ["EMA", 69.5, 0.7],
    ["Longer train", 71.2, 1.8],
  ];
  return { key: "ablation", name: "Sample · Ablation", filename: "sample-ablation.csv", csv: csv(["method", "score", "std"], rows) };
}

function scalingTable(): SampleTable {
  const rows: Array<Array<number>> = [];
  for (let index = 0; index < 12; index += 1) {
    const compute = Number((10 ** (3 + index * 0.45)).toFixed(2));
    const loss = Number((9.2 * compute ** -0.16).toFixed(4));
    rows.push([compute, loss]);
  }
  return { key: "scaling", name: "Sample · Scaling", filename: "sample-scaling.csv", csv: csv(["compute", "loss"], rows) };
}

function confusionTable(): SampleTable {
  const labels = ["cat", "dog", "bird", "deer"];
  const counts = [
    [48, 4, 2, 1],
    [3, 44, 2, 6],
    [2, 1, 51, 3],
    [1, 5, 4, 46],
  ];
  const rows: Array<Array<string | number>> = [];
  labels.forEach((actual, row) => {
    labels.forEach((predicted, column) => {
      rows.push([actual, predicted, counts[row]![column]!]);
    });
  });
  return { key: "confusion", name: "Sample · Confusion", filename: "sample-confusion.csv", csv: csv(["actual", "predicted", "count"], rows) };
}

function scoresTable(): SampleTable {
  const rows: Array<Array<string | number>> = [];
  const groups: Array<[string, number, number]> = [
    ["A", 42, 4],
    ["B", 55, 6],
    ["C", 38, 5],
    ["D", 61, 7],
  ];
  for (const [group, center, spread] of groups) {
    for (let index = 0; index < 18; index += 1) {
      const value = Number((center + Math.sin(index * 1.7) * spread).toFixed(2));
      rows.push([group, value]);
    }
    rows.push([group, Number((center + spread * 4.2).toFixed(2))]);
  }
  return { key: "scores", name: "Sample · Scores", filename: "sample-scores.csv", csv: csv(["group", "value"], rows) };
}

export function sampleTables(): SampleTable[] {
  return [runsTable(), ablationTable(), scalingTable(), confusionTable(), scoresTable()];
}

/** Tiles that show each sample table's defining mark. Positions sit on the 12-column grid without overlap. */
export function sampleTiles(ids: Record<SampleKey, string>): WorkspaceTile[] {
  const common = { palette: "accent" as const, legend: "bottom" as const, annotations: [] as WorkspaceTile["annotations"] };
  return [
    tileSchema.parse({
      ...common,
      id: "sample-train",
      col: 0,
      row: 0,
      w: 6,
      h: 5,
      chart: "line",
      paper: "training",
      title: "Training curve",
      xRef: columnRef(ids.runs, "step"),
      yRefs: [columnRef(ids.runs, "loss")],
      seedRef: columnRef(ids.runs, "seed"),
      series: [{ y: "loss", axis: "left", errorKind: "band" }],
    }),
    tileSchema.parse({
      ...common,
      id: "sample-ablation",
      col: 6,
      row: 0,
      w: 6,
      h: 5,
      chart: "bar",
      paper: "ablation",
      title: "Ablation bars",
      xRef: columnRef(ids.ablation, "method"),
      yRefs: [columnRef(ids.ablation, "score")],
      errorRef: columnRef(ids.ablation, "std"),
      series: [{ y: "score", axis: "left", errorKind: "bar" }],
    }),
    tileSchema.parse({
      ...common,
      id: "sample-scaling",
      col: 0,
      row: 5,
      w: 6,
      h: 5,
      chart: "line",
      paper: "scaling",
      title: "Scaling law",
      xLog: true,
      yLogLeft: true,
      xRef: columnRef(ids.scaling, "compute"),
      yRefs: [columnRef(ids.scaling, "loss")],
      series: [{ y: "loss", axis: "left" }],
    }),
    tileSchema.parse({
      id: "sample-confusion",
      col: 6,
      row: 5,
      w: 6,
      h: 5,
      chart: "heatmap",
      paper: "confusion",
      title: "Confusion matrix",
      palette: "viridis",
      legend: "none",
      xRef: columnRef(ids.confusion, "actual"),
      yRefs: [columnRef(ids.confusion, "predicted"), columnRef(ids.confusion, "count")],
      series: [{ y: "predicted", axis: "left" }, { y: "count", axis: "left" }],
      annotations: [],
    }),
    tileSchema.parse({
      ...common,
      id: "sample-box",
      col: 0,
      row: 10,
      w: 6,
      h: 5,
      chart: "box",
      paper: null,
      title: "Score spread",
      boxOutliers: true,
      boxNotch: true,
      boxJitter: false,
      boxWhisker: 1.5,
      xRef: columnRef(ids.scores, "group"),
      yRefs: [columnRef(ids.scores, "value")],
      series: [{ y: "value", axis: "left" }],
    }),
  ];
}
