/**
 * The Code panels on the plots canvas (docs/20 Plots): a tile's generated script draws that tile, an
 * edit takes over from the tile's settings, and the canvas figure draws an edited tile from its code.
 * The scripts run under the agent runtime's Python with the browser's own driver; without it those
 * tests skip.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { columnRef, joinRef, matplotlibPanels, parseTableText, sampleTables, sampleTiles, tileSchema, type PoolDataset } from "@ensemble/shared-types";
import { DRIVER_PY } from "./browser-python";
import { PLOT_HELPER } from "./python-sources";
import { canvasPanels, canvasSource, loadNames, storedTileCode, tileScript, tileSource } from "./tile-code";

const ids = {
  runs: "11111111-1111-4111-8111-111111111111",
  ablation: "22222222-2222-4222-8222-222222222222",
  scaling: "33333333-3333-4333-8333-333333333333",
  confusion: "44444444-4444-4444-8444-444444444444",
  scores: "55555555-5555-4555-8555-555555555555",
};
const datasets: PoolDataset[] = sampleTables().map((table) => {
  const parsed = parseTableText(table.csv, "csv");
  return { id: ids[table.key], name: table.name, columns: parsed.columns, rows: parsed.rows };
});
const tiles = sampleTiles(ids);
const canvas = { datasets, links: {}, accent: "#c2410c", dark: false };

test("a repeated dataset name loads as the render numbers it", () => {
  const names = loadNames([{ id: "a", name: "runs" }, { id: "b", name: "eval" }, { id: "c", name: "runs" }]);
  assert.deepEqual([...names.values()], ["runs", "eval", "runs 2"]);
});

test("a tile's generated code draws the tile, not an empty figure", () => {
  const ablation = tileSource(tiles[1]!, canvas);
  assert.match(ablation, /load\("Sample · Ablation"\)/);
  assert.match(ablation, /ax\.bar\(_x, _y, color="#[0-9a-fA-F]{6}"/);
  assert.match(ablation, /ax\.errorbar\(/);
  assert.match(ablation, /ax\.set_title\("Ablation bars"/);
  assert.match(ablation, /ax\.set_xlabel\("method"\)/);
  assert.match(ablation, /ax\.set_ylabel\("score"\)/);
  const between = ablation.slice(ablation.indexOf("plt.subplots("), ablation.indexOf("save(fig)"));
  assert.ok(between.split("\n").length > 10, "the figure is drawn between subplots() and save()");

  const confusion = tileSource(tiles[3]!, canvas);
  assert.match(confusion, /ax\.imshow\(/, "a confusion matrix is a heatmap, not two lines");
  assert.equal(/ax\.plot\(/.test(confusion), false);
  const violin = tileSource(tileSchema.parse({ ...tiles[4]!, chart: "violin" }), canvas);
  assert.match(violin, /ax\.violinplot\(/);
});

test("a tile joined across files writes its rows into the script", () => {
  const train = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "train.csv", columns: [{ name: "time", type: "number" as const }, { name: "loss", type: "number" as const }], rows: [[1, 0.9], [2, 0.4]] };
  const evals = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "eval.csv", columns: [{ name: "time", type: "number" as const }, { name: "accuracy", type: "number" as const }], rows: [[1, 0.6], [2, 0.8]] };
  const tile = tileSchema.parse({ id: "j", chart: "line", title: "Joined", xRef: joinRef("time"), yRefs: [columnRef(train.id, "loss"), columnRef(evals.id, "accuracy")], series: [{ y: "loss", axis: "left" }, { y: "accuracy", axis: "left" }] });
  const source = tileSource(tile, { datasets: [train, evals], links: { time: "join" } });
  assert.match(source, /df = pd\.DataFrame\(\{/);
  assert.equal(source.includes("load("), false);
});

test("an edit takes over from the settings until it matches the generated code again", () => {
  const tile = tiles[2]!;
  const generated = tileSource(tile, canvas);
  assert.deepEqual(tileScript(tile, generated), { code: generated, edited: false });
  const mine = `${generated}\nprint("mine")\n`;
  assert.equal(storedTileCode(mine, generated), mine);
  assert.equal(storedTileCode(generated, generated), null, "typing back to the generated code stores nothing");
  const edited = tileSchema.parse({ ...tile, code: mine });
  assert.deepEqual(tileScript(edited, generated), { code: mine, edited: true });
  assert.equal(tileScript(tileSchema.parse({ ...tile, code: generated }), generated).edited, false);
});

test("the canvas figure draws an edited tile from its code, and the Code view loads files by name", () => {
  const edited = tileSchema.parse({ ...tiles[1]!, code: "from ensemble_plots import load, save\nimport matplotlib.pyplot as plt\nimport numpy as np\nfig, ax = plt.subplots()\nax.plot([1, 2], [3, 4])\nsave(fig)\n" });
  const panels = canvasPanels([tiles[0]!, edited, tiles[2]!], { ...canvas, inline: true });
  assert.deepEqual(panels.map((panel) => panel.edited), [false, true, false]);
  assert.equal(panels[1]!.code, edited.code);
  const figure = matplotlibPanels(panels, {});
  assert.match(figure, /_tile_image\(/);
  assert.match(figure, /^import numpy$/m, "an edited tile's imports are at the top, where the browser finds them");

  const source = canvasSource([tiles[1]!, tiles[2]!], canvas);
  assert.match(source, /_df = load\("Sample · Ablation"\)/);
  assert.match(source, /_ax\.bar\(/);
  assert.equal(source.includes("pd.DataFrame({"), false, "tables straight from a file are loaded, not pasted in");
  assert.match(canvasSource([], canvas), /ax\.plot\(/, "an empty canvas still starts from a drawing script");
});

const python = join(process.cwd(), "..", "agent-runtime", ".venv", "bin", "python");
const pythonReady = existsSync(python) && spawnSync(python, ["-c", "import matplotlib, pandas"]).status === 0;

/** Runs a script the way the browser does (DRIVER_PY with the plot helper) under CPython. */
function render(code: string): { data: string | null; error?: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "tile-code-"));
  writeFileSync(join(dir, "ensemble_driver.py"), DRIVER_PY);
  writeFileSync(join(dir, "helper.txt"), PLOT_HELPER);
  const names = loadNames(datasets);
  const job = { code, format: "png", dpi: 60, datasets: datasets.map((dataset) => ({ name: names.get(dataset.id), columns: dataset.columns.map((column) => column.name), rows: dataset.rows })) };
  writeFileSync(join(dir, "job.json"), JSON.stringify(job));
  const script = `import sys\nsys.path.insert(0, ${JSON.stringify(dir)})\nimport ensemble_driver as d\nprint(d.run_plot(open(${JSON.stringify(join(dir, "job.json"))}).read(), open(${JSON.stringify(join(dir, "helper.txt"))}).read()))`;
  const out = execFileSync(python, ["-c", script], { encoding: "utf8", env: { ...process.env, MPLBACKEND: "Agg", MPLCONFIGDIR: dir } });
  return JSON.parse(out.trim().split("\n").pop()!) as { data: string | null; error?: string; stderr: string };
}

test("every sample tile's generated code renders", { skip: !pythonReady && "the agent runtime's Python is not installed here" }, () => {
  for (const tile of [...tiles, tileSchema.parse({ ...tiles[4]!, chart: "violin" })]) {
    const result = render(tileSource(tile, canvas));
    assert.equal(result.error, undefined, `${tile.title} (${tile.chart}): ${result.stderr}`);
    assert.equal(Buffer.from(String(result.data), "base64").subarray(1, 4).toString(), "PNG");
  }
});

test("the canvas figure renders with an edited tile, and a failing edit names its panel and line", { skip: !pythonReady && "the agent runtime's Python is not installed here" }, () => {
  const edited = tileSchema.parse({ ...tiles[1]!, code: "from ensemble_plots import load, save, apply_style\nimport matplotlib.pyplot as plt\napply_style('DejaVu Sans', 'sans-serif', 14)\ndf = load('Sample · Ablation')\nfig, ax = plt.subplots()\nax.barh(df['method'], df['score'])\nsave(fig)\n" });
  const good = render(matplotlibPanels(canvasPanels([tiles[0]!, edited, tiles[3]!], { ...canvas, inline: true }), {}));
  assert.equal(good.error, undefined, good.stderr);
  assert.equal(Buffer.from(String(good.data), "base64").subarray(1, 4).toString(), "PNG");

  const broken = tileSchema.parse({ ...tiles[1]!, code: "from ensemble_plots import save\nimport matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.plot(missing)\nsave(fig)\n" });
  const bad = render(matplotlibPanels(canvasPanels([tiles[0]!, broken], { ...canvas, inline: true }), {}));
  assert.equal(bad.data, null);
  assert.match(String(bad.error), /\(b\) Ablation bars failed at line 4: NameError/);
});
