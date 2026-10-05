import assert from "node:assert/strict";
import test from "node:test";
import { matplotlibPanels } from "./plots-matplotlib.js";
import { chartFrame, columnRef, duplicateGroups, joinRef, poolColumns } from "./plots-pool.js";

const train = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "train.csv",
  columns: [
    { name: "time", type: "number" as const },
    { name: "loss", type: "number" as const },
  ],
  rows: [
    [1, 0.9],
    [2, 0.4],
  ],
};
const evalSet = {
  id: "22222222-2222-2222-2222-222222222222",
  name: "eval.csv",
  columns: [
    { name: "time", type: "number" as const },
    { name: "accuracy", type: "number" as const },
  ],
  rows: [
    [2, 0.7],
    [3, 0.8],
  ],
};
const notes = {
  id: "33333333-3333-3333-3333-333333333333",
  name: "notes.csv",
  columns: [
    { name: "time", type: "text" as const },
    { name: "note", type: "text" as const },
  ],
  rows: [["monday", "ok"]],
};

test("unique names need no duplicate control", () => {
  assert.deepEqual(duplicateGroups([train]), []);
  const pool = poolColumns([train], {});
  assert.ok(pool.every((column) => column.source === null));
});

test("a shared name stays separate until that name is joined, and a type mismatch cannot join", () => {
  const groups = duplicateGroups([train, evalSet]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.name, "time");
  assert.equal(groups[0]!.sameType, true);
  const separate = poolColumns([train, evalSet], {});
  assert.equal(separate.filter((column) => column.name === "time").length, 2);
  assert.ok(separate.filter((column) => column.name === "time").every((column) => column.source));
  const joined = poolColumns([train, evalSet], { time: "join" });
  assert.equal(joined.filter((column) => column.name === "time").length, 1);
  assert.equal(joined.find((column) => column.name === "time")?.join, true);

  const mismatch = duplicateGroups([train, notes]);
  assert.equal(mismatch.find((group) => group.name === "time")?.sameType, false);
  const forced = poolColumns([train, notes], { time: "join" });
  assert.equal(forced.filter((column) => column.name === "time" && column.join).length, 0);
});

test("joining on time aligns measures from both files and drops the unmatched step", () => {
  const { frame, config } = chartFrame(
    [train, evalSet],
    {
      chart: "line",
      xLog: false,
      yLogLeft: false,
      yLogRight: false,
      title: "",
      palette: "okabe-ito",
      annotations: [],
      legend: "bottom",
      xRef: joinRef("time"),
      yRefs: [columnRef(train.id, "loss"), columnRef(evalSet.id, "accuracy")],
    },
    { time: "join" },
  );
  assert.equal(config.x, "time");
  assert.deepEqual(frame.rows, [[2, 0.4, 0.7]]);
  assert.equal(joinRef("time").includes("\u0000"), false);
});

test("a band on the series is kept, and a panel plots that table", () => {
  const { config } = chartFrame(
    [train],
    {
      chart: "line",
      xLog: false,
      yLogLeft: false,
      yLogRight: false,
      title: "Training curve",
      palette: "okabe-ito",
      annotations: [],
      legend: "bottom",
      xRef: columnRef(train.id, "time"),
      yRefs: [columnRef(train.id, "loss")],
      errorRef: columnRef(train.id, "loss"),
      series: [{ errorKind: "band" }],
    },
    {},
  );
  assert.equal(config.series[0]?.errorKind, "band");
  const script = matplotlibPanels([{
    title: "Training curve",
    datasetName: "train.csv",
    x: "time",
    ys: ["loss"],
    chart: "line",
    columns: ["time", "loss"],
    rows: [[1, 0.9], [2, 0.4]],
    error: "loss",
    errorKind: "band",
  }]);
  assert.match(script, /pd\.DataFrame/);
  assert.match(script, /fill_between/);
  assert.equal(script.includes("load("), false);
});

test("a category or another table on a log chart does not drop the valid series", () => {
  const view = chartFrame(
    [train, notes],
    {
      chart: "line",
      xLog: true,
      yLogLeft: true,
      yLogRight: false,
      title: "Scaling law",
      palette: "okabe-ito",
      annotations: [],
      legend: "bottom",
      xRef: columnRef(train.id, "time"),
      yRefs: [columnRef(train.id, "loss"), columnRef(notes.id, "note")],
    },
    {},
  );
  assert.equal(view.frame.rows.length, 2);
  assert.deepEqual(view.config.series.map((series) => series.y), ["loss"]);
  assert.match(view.warnings.join(" "), /note is a category/);
});
