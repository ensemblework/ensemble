import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chartFrame, matplotlibSource, paintedGrid, parseTableText, sampleTables, sampleTiles, seedSummaryFor, type PlotConfig } from "@ensemble/shared-types";
import { chartOption } from "./option.js";

const IDS = {
  runs: "11111111-1111-4111-8111-111111111111",
  ablation: "22222222-2222-4222-8222-222222222222",
  scaling: "33333333-3333-4333-8333-333333333333",
  confusion: "44444444-4444-4444-8444-444444444444",
  scores: "55555555-5555-4555-8555-555555555555",
};

const DARK = { ink: "#f3eee6", muted: "#a8a29e", line: "rgba(243,238,230,0.08)", panel: "#221e1a", accent: "#7c6af7", dark: true };
const LIGHT = { ink: "#1c1915", muted: "#6d675e", line: "rgba(28,25,21,0.08)", panel: "#fffcf7", accent: "#5346d6", dark: false };

function sampleView(key: "runs" | "scaling") {
  const tables = sampleTables();
  const table = tables.find((item) => item.key === key)!;
  const parsed = parseTableText(table.csv, "csv");
  const tile = sampleTiles(IDS).find((item) => item.id === (key === "runs" ? "sample-train" : "sample-scaling"))!;
  const view = chartFrame([{ id: IDS[key], name: table.name, columns: parsed.columns, rows: parsed.rows }], tile, {});
  view.config.gridXMinor = true;
  view.config.gridYMinor = true;
  view.config.xMinorTicks = true;
  view.config.yMinorTicks = true;
  return { table, parsed, view };
}

function axisOf(option: Record<string, unknown>, side: "x" | "y") {
  const axis = side === "x" ? option.xAxis : (option.yAxis as unknown[])[0];
  return axis as {
    type?: string;
    min?: number;
    max?: number;
    splitLine?: { lineStyle?: { width?: number; color?: string } };
    minorSplitLine?: { show?: boolean; lineStyle?: { width?: number; color?: string } };
  };
}

function sourceLimits(source: string, call: "set_xlim" | "set_ylim"): [number, number] {
  const match = source.match(new RegExp(`${call}\\(([0-9eE.+-]+), ([0-9eE.+-]+)\\)`));
  assert.ok(match, `${call} missing`);
  return [Number(match[1]), Number(match[2])];
}

function sourceTicks(source: string, axis: string): number[] {
  const pattern = new RegExp(`${axis.replace(".", "\\.")}\\.set_major_locator\\(FixedLocator\\(\\[([^\\]]*)\\]\\)\\)`);
  const match = source.match(pattern);
  assert.ok(match, `${axis} FixedLocator missing`);
  return match[1]!.split(",").map((item) => Number(item.trim())).filter((value) => Number.isFinite(value));
}

function alphaOf(color: string | undefined): number {
  const match = color?.match(/,\s*([0-9.]+)\)$/);
  assert.ok(match, color);
  return Number(match[1]);
}

function close(actual: number, expected: number, label: string) {
  assert.ok(Math.abs(actual - expected) <= Math.max(1e-6, Math.abs(expected) * 1e-6), `${label}: ${actual} vs ${expected}`);
}

type FigureMeta = {
  xscale: string;
  yscale: string;
  xlim: [number, number];
  ylim: [number, number];
  xticks: number[];
  yticks: number[];
  xticklabels: string[];
  yticklabels: string[];
  xMajor: { width: number; alpha: number } | null;
  yMajor: { width: number; alpha: number } | null;
  xMinor: { width: number; alpha: number } | null;
  yMinor: { width: number; alpha: number } | null;
  series: Array<{ label: string; y: number[]; color: [number, number, number] }>;
  bands: Array<{ alpha: number; rgb: [number, number, number]; span: number }>;
  warnings: string[];
  svgSuperscript: boolean;
  sizes: { png: number; pdf: number; svg: number };
};

const SUPERSCRIPT = /[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]/;

// The agent runtime's virtualenv has matplotlib; PLOTS_PYTHON overrides it.
function figurePython(): string {
  const venv = fileURLToPath(new URL("../../../agent-runtime/.venv/", import.meta.url));
  const candidates = [
    process.env.PLOTS_PYTHON,
    join(venv, "bin", "python"),
    join(venv, "Scripts", "python.exe"),
  ].filter((bin): bin is string => Boolean(bin) && existsSync(bin!));
  return candidates[0] ?? "python3";
}

function renderFigure(code: string, csv: string): FigureMeta {
  const python = figurePython();
  const dir = mkdtempSync(join(tmpdir(), "ensemble-plot-"));
  const stub = [
    "import json",
    "import warnings",
    "import matplotlib",
    "import matplotlib.pyplot as plt",
    "import pandas as pd",
    "from matplotlib.collections import PolyCollection",
    "def load(name):",
    `    return pd.read_csv(${JSON.stringify(join(dir, "data.csv"))})`,
    "def apply_style(font, family, size):",
    "    plt.rcParams['font.family'] = family",
    "    if family == 'serif':",
    "        plt.rcParams['font.serif'] = [font]",
    "    else:",
    "        plt.rcParams['font.sans-serif'] = [font]",
    "    plt.rcParams['font.size'] = size",
    "    plt.rcParams['axes.unicode_minus'] = True",
    "def save(fig):",
    "    caught = []",
    "    with warnings.catch_warnings(record=True) as caught:",
    "        warnings.simplefilter('always')",
    "        fig.canvas.draw()",
    `        fig.savefig(${JSON.stringify(join(dir, "figure.png"))})`,
    `        fig.savefig(${JSON.stringify(join(dir, "figure.pdf"))})`,
    `        fig.savefig(${JSON.stringify(join(dir, "figure.svg"))})`,
    "    ax = fig.axes[0]",
    "    def stroke(axis, which):",
    "        ticks = axis.majorTicks if which == 'major' else axis.minorTicks",
    "        lines = [tick.gridline for tick in ticks if tick.gridline.get_visible()]",
    "        if not lines:",
    "            return None",
    "        line = lines[0]",
    "        color = line.get_color()",
    "        fade = line.get_alpha()",
    "        rgba = float(color[3]) if isinstance(color, tuple) and len(color) >= 4 else 1.0",
    "        return {'width': float(line.get_linewidth()), 'alpha': rgba * (1.0 if fade is None else float(fade))}",
    "    def rgb_of(artist):",
    "        color = artist.get_color()",
    "        if isinstance(color, str):",
    "            color = matplotlib.colors.to_rgb(color)",
    "        return [float(color[0]), float(color[1]), float(color[2])]",
    "    bands = []",
    "    for col in ax.collections:",
    "        if not isinstance(col, PolyCollection) or not col.get_paths():",
    "            continue",
    "        verts = col.get_paths()[0].vertices",
    "        buckets = {}",
    "        for x, y in verts:",
    "            buckets.setdefault(round(float(x), 5), []).append(float(y))",
    "        spans = [max(ys) - min(ys) for ys in buckets.values() if len(ys) >= 2]",
    "        spans.sort()",
    "        face = col.get_facecolor()[0]",
    "        alpha = col.get_alpha()",
    "        bands.append({",
    "            'alpha': float(face[3] if alpha is None else alpha),",
    "            'rgb': [float(face[0]), float(face[1]), float(face[2])],",
    "            'span': float(spans[len(spans) // 2]) if spans else 0.0,",
    "        })",
    "    meta = {",
    "        'xscale': ax.get_xscale(),",
    "        'yscale': ax.get_yscale(),",
    "        'xlim': [float(v) for v in ax.get_xlim()],",
    "        'ylim': [float(v) for v in ax.get_ylim()],",
    "        'xticks': [float(v) for v in ax.get_xticks()],",
    "        'yticks': [float(v) for v in ax.get_yticks()],",
    "        'xticklabels': [tick.get_text() for tick in ax.get_xticklabels()],",
    "        'yticklabels': [tick.get_text() for tick in ax.get_yticklabels()],",
    "        'xMajor': stroke(ax.xaxis, 'major'),",
    "        'yMajor': stroke(ax.yaxis, 'major'),",
    "        'xMinor': stroke(ax.xaxis, 'minor'),",
    "        'yMinor': stroke(ax.yaxis, 'minor'),",
    "        'series': [{'label': line.get_label(), 'y': [float(v) for v in line.get_ydata()], 'color': rgb_of(line)} for line in ax.get_lines() if not line.get_label().startswith('_')],",
    "        'bands': bands,",
    "        'warnings': [str(item.message) for item in caught],",
    `        'svgSuperscript': any(ch in open(${JSON.stringify(join(dir, "figure.svg"))}, encoding='utf-8').read() for ch in '⁰¹²³⁴⁵⁶⁷⁸⁹⁻'),`,
    "        'sizes': {",
    `            'png': __import__('os').path.getsize(${JSON.stringify(join(dir, "figure.png"))}),`,
    `            'pdf': __import__('os').path.getsize(${JSON.stringify(join(dir, "figure.pdf"))}),`,
    `            'svg': __import__('os').path.getsize(${JSON.stringify(join(dir, "figure.svg"))}),`,
    "        },",
    "    }",
    `    open(${JSON.stringify(join(dir, "meta.json"))}, "w").write(json.dumps(meta))`,
  ].join("\n");
  try {
    writeFileSync(join(dir, "ensemble_plots.py"), stub);
    writeFileSync(join(dir, "data.csv"), csv);
    writeFileSync(join(dir, "figure.py"), code);
    execFileSync(python, ["figure.py"], {
      cwd: dir,
      env: { ...process.env, MPLBACKEND: "Agg", PYTHONPATH: dir },
      stdio: "pipe",
    });
    return JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as FigureMeta;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertGlyphs(source: string, meta: FigureMeta) {
  assert.match(source, /LogFormatterMathtext\(\)/);
  assert.match(source, /axes\.unicode_minus"\] = False/);
  assert.doesNotMatch(source, SUPERSCRIPT);
  assert.equal(meta.svgSuperscript, false);
  assert.ok(meta.sizes.png > 1000 && meta.sizes.pdf > 1000 && meta.sizes.svg > 1000);
  const missing = meta.warnings.filter((warning) => /missing from font|Glyph/i.test(warning));
  assert.deepEqual(missing, []);
  for (const label of [...meta.xticklabels, ...meta.yticklabels]) {
    assert.doesNotMatch(label, SUPERSCRIPT);
    if (label.includes("10")) assert.match(label, /\$\\mathdefault\{10\^\{[-0-9]+\}\}\$/);
  }
}

function assertShared(source: string, option: Record<string, unknown>, dark: boolean, config: PlotConfig) {
  const x = axisOf(option, "x");
  const y = axisOf(option, "y");
  const [xMin, xMax] = sourceLimits(source, "set_xlim");
  const [yMin, yMax] = sourceLimits(source, "set_ylim");
  close(xMin, x.min ?? NaN, "x min");
  close(xMax, x.max ?? NaN, "x max");
  close(yMin, y.min ?? NaN, "y min");
  close(yMax, y.max ?? NaN, "y max");
  assert.equal(source.includes("set_xscale('log')"), x.type === "log");
  assert.equal(source.includes("set_yscale('log')"), y.type === "log");
  const xTicks = sourceTicks(source, "ax.xaxis");
  const yTicks = sourceTicks(source, "ax.yaxis");
  assert.ok(xTicks.length >= 2);
  assert.ok(yTicks.length >= 2);
  if (x.type === "log") {
    for (const tick of xTicks) {
      const exp = Math.log10(tick);
      assert.ok(Math.abs(exp - Math.round(exp)) < 1e-6, `x tick ${tick} is not 10^n`);
    }
    for (let index = 1; index < xTicks.length; index += 1) close(xTicks[index]! / xTicks[index - 1]!, 10, "x decade");
  }
  const major = paintedGrid(config, "y", false, dark);
  const minor = paintedGrid(config, "y", true, dark);
  assert.ok(major.width >= minor.width);
  assert.ok(major.alpha >= minor.alpha);
  assert.ok(minor.alpha >= (dark ? 0.5 : 0.35), `minor alpha ${minor.alpha} is too faint`);
  assert.equal(y.splitLine?.lineStyle?.width, major.width);
  assert.equal(alphaOf(y.splitLine?.lineStyle?.color), major.alpha);
  assert.equal(y.minorSplitLine?.show, true);
  assert.equal(y.minorSplitLine?.lineStyle?.width, minor.width);
  assert.equal(alphaOf(y.minorSplitLine?.lineStyle?.color), minor.alpha);
  assert.match(source, new RegExp(`which="major", axis="y", visible=True, linestyle="solid", linewidth=${major.width}`));
  assert.match(source, new RegExp(`which="minor", axis="y", visible=True, linestyle=\\(0, \\(2, 2\\)\\), linewidth=${minor.width}`));
  assert.doesNotMatch(source, /set_major_locator\(AutoLocator\(\)\)/);
  return { xTicks, yTicks, major, minor };
}

test("scaling preview and matplotlib export share log limits, decade ticks, and grid", () => {
  const { table, view } = sampleView("scaling");
  const option = chartOption(view.frame, view.config, DARK);
  const source = matplotlibSource({
    datasetName: table.name,
    columns: view.frame.columns,
    config: view.config,
    accent: DARK.accent,
    dark: true,
    rows: view.frame.rows,
    rowColumns: view.frame.columns.map((column) => column.name),
  });
  const shared = assertShared(source, option, true, view.config);
  const meta = renderFigure(source, table.csv);
  assert.equal(meta.xscale, "log");
  assert.equal(meta.yscale, "log");
  close(meta.xlim[0], axisOf(option, "x").min ?? NaN, "export x min");
  close(meta.xlim[1], axisOf(option, "x").max ?? NaN, "export x max");
  close(meta.ylim[0], axisOf(option, "y").min ?? NaN, "export y min");
  close(meta.ylim[1], axisOf(option, "y").max ?? NaN, "export y max");
  assert.equal(meta.xticks.length, shared.xTicks.length);
  assert.equal(meta.yticks.length, shared.yTicks.length);
  assert.equal(meta.yMajor?.width, shared.major.width);
  close(meta.yMajor?.alpha ?? NaN, shared.major.alpha, "major alpha");
  assert.equal(meta.yMinor?.width, shared.minor.width);
  close(meta.yMinor?.alpha ?? NaN, shared.minor.alpha, "minor alpha");
  assert.ok((meta.yMajor?.alpha ?? 0) >= (meta.yMinor?.alpha ?? 0));
  assertGlyphs(source, meta);
  const lightSource = matplotlibSource({
    datasetName: table.name,
    columns: view.frame.columns,
    config: view.config,
    accent: LIGHT.accent,
    dark: false,
    rows: view.frame.rows,
    rowColumns: view.frame.columns.map((column) => column.name),
  });
  assertGlyphs(lightSource, renderFigure(lightSource, table.csv));
});

test("training export derives the seed mean instead of reading a missing column", () => {
  const { table, parsed, view } = sampleView("runs");
  const option = chartOption(view.frame, view.config, LIGHT);
  const summary = seedSummaryFor({
    columns: parsed.columns,
    x: view.config.x,
    y: "loss",
    seed: "seed",
    series: view.config.series,
  });
  assert.equal(summary?.group, "split");
  assert.deepEqual(summary?.series.map((series) => series.name), ["train", "eval"]);
  const source = matplotlibSource({
    datasetName: table.name,
    columns: parsed.columns,
    config: view.config,
    accent: LIGHT.accent,
    dark: false,
    rows: view.frame.rows,
    rowColumns: view.frame.columns.map((column) => column.name),
    summary,
  });
  assert.match(source, /groupby/);
  assert.match(source, /std\(ddof=1\)/);
  assert.equal(source.match(/fill_between\(_x, _y - _e, _y \+ _e/g)?.length, 2);
  assert.match(source, /alpha=0\.22/);
  const shared = assertShared(source, option, false, view.config);
  assert.equal(axisOf(option, "x").type, "value");
  assert.equal(axisOf(option, "y").type, "value");
  const meta = renderFigure(source, table.csv);
  assert.equal(meta.xscale, "linear");
  assert.equal(meta.yscale, "linear");
  close(meta.xlim[0], axisOf(option, "x").min ?? NaN, "train x min");
  close(meta.xlim[1], axisOf(option, "x").max ?? NaN, "train x max");
  close(meta.ylim[0], axisOf(option, "y").min ?? NaN, "train y min");
  close(meta.ylim[1], axisOf(option, "y").max ?? NaN, "train y max");
  assert.equal(meta.xticks.length, shared.xTicks.length);
  assert.equal(meta.yMajor?.width, shared.major.width);
  close(meta.yMinor?.alpha ?? NaN, shared.minor.alpha, "train minor alpha");
  const byLabel = new Map(meta.series.map((series) => [series.label, series.y]));
  const trainIndex = view.frame.columns.findIndex((column) => column.name === "train");
  const evalIndex = view.frame.columns.findIndex((column) => column.name === "eval");
  const train = byLabel.get("train") ?? [];
  const evalY = byLabel.get("eval") ?? [];
  assert.equal(train.length, view.frame.rows.length);
  assert.equal(evalY.length, view.frame.rows.length);
  view.frame.rows.forEach((row, index) => {
    close(train[index]!, Number(row[trainIndex]), `train ${index}`);
    close(evalY[index]!, Number(row[evalIndex]), `eval ${index}`);
  });
  assertBands(meta, view.frame.rows);
  const darkSource = matplotlibSource({
    datasetName: table.name,
    columns: parsed.columns,
    config: view.config,
    accent: DARK.accent,
    dark: true,
    rows: view.frame.rows,
    rowColumns: view.frame.columns.map((column) => column.name),
    summary,
  });
  assertBands(renderFigure(darkSource, table.csv), view.frame.rows);
});

function assertBands(meta: FigureMeta, rows: Array<Array<string | number | null>>) {
  assert.equal(meta.bands.length, 2);
  const stds = rows.flatMap((row) => [Number(row[2]), Number(row[4])]).filter((value) => Number.isFinite(value) && value > 0);
  const typical = [...stds].sort((a, b) => a - b)[Math.floor(stds.length / 2)]! * 2;
  for (const band of meta.bands) {
    close(band.alpha, 0.22, "band alpha");
    assert.ok(band.span > typical * 0.8 && band.span < typical * 1.2, `band span ${band.span} vs 2*std ${typical}`);
    const match = meta.series.some((series) => series.color.every((channel, index) => Math.abs(channel - band.rgb[index]!) < 0.02));
    assert.ok(match, `band ${band.rgb.join(",")} is not a series colour`);
  }
  const missing = meta.warnings.filter((warning) => /missing from font|Glyph/i.test(warning));
  assert.deepEqual(missing, []);
}
