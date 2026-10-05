import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultPlotConfig, matplotlibSource } from "@ensemble/shared-types";
import { chartOption } from "../../lib/plots/option.js";
import { ColumnMenu, SeriesAxes } from "./column-select.js";

const columns = [
  { id: "revenue", name: "revenue", type: "number" as const },
  { id: "cost", name: "cost", type: "number" as const, source: "sales.csv" },
  { id: "note", name: "note", type: "text" as const },
];

function radio(html: string, name: "Left" | "Right"): string {
  const end = html.indexOf(`>${name}<`);
  assert.ok(end > 0, name);
  return html.slice(Math.max(0, end - 240), end);
}

test("chosen series carry Left/Right outside the option list", () => {
  const chosen = columns.filter((column) => column.id === "revenue" || column.id === "cost");
  const html = renderToStaticMarkup(
    <SeriesAxes
      chosen={chosen}
      columns={columns}
      axisOf={(id) => (id === "cost" ? "right" : "left")}
      onAxis={() => {}}
    />,
  );
  assert.equal(html.includes("<select"), false);
  assert.match(html, /data-series-axes/);
  assert.match(html, /aria-label="Series axes"/);
  assert.match(html, /aria-label="revenue axis"/);
  assert.match(html, /aria-label="cost axis"/);
  assert.equal(html.includes("note axis"), false);
  const revenue = html.slice(html.indexOf('aria-label="revenue axis"'), html.indexOf('aria-label="cost axis"'));
  assert.match(radio(revenue, "Left"), /aria-checked="true"/);
  assert.match(radio(revenue, "Right"), /aria-checked="false"/);
  assert.match(radio(revenue, "Left"), /tabindex="0"/);
  assert.match(radio(revenue, "Right"), /tabindex="-1"/);
  const cost = html.slice(html.indexOf('aria-label="cost axis"'));
  assert.match(radio(cost, "Right"), /aria-checked="true"/);
  assert.match(radio(cost, "Left"), /aria-checked="false"/);

  const menu = renderToStaticMarkup(
    <ColumnMenu
      label="Y series"
      columns={columns}
      selected={["revenue", "cost"]}
      multiple
      query=""
      onQuery={() => {}}
      onToggle={() => {}}
    />,
  );
  assert.equal(menu.includes("<select"), false);
  assert.equal(menu.includes("radiogroup"), false);
  assert.equal(menu.includes("<button"), false);
  assert.match(menu, /role="option"/);
  assert.match(menu, /aria-selected="true"/);
  assert.equal(menu.includes("aria-checked"), false);

  const source = readFileSync(new URL("./column-select.tsx", import.meta.url), "utf8");
  const menuSource = source.slice(source.indexOf("export function ColumnMenu"), source.indexOf("export function ColumnSelect"));
  const selectSource = source.slice(source.indexOf("export function ColumnSelect"));
  assert.equal(menuSource.includes("<select"), false);
  const popoverEnd = selectSource.indexOf("</Popover>");
  const axes = selectSource.indexOf("<SeriesAxes");
  assert.ok(popoverEnd > 0 && axes > popoverEnd, "the axis row sits outside the column menu");
  assert.match(selectSource, /onAxis && axisOf \? <SeriesAxes/);
});

test("axis chips wrap in a narrow panel and long names truncate inside the chip", () => {
  const long = { id: "long", name: "validation_accuracy_smoothed_over_five_seeds", type: "number" as const };
  const html = renderToStaticMarkup(
    <SeriesAxes chosen={[columns[0]!, long]} columns={[...columns, long]} axisOf={() => "left"} onAxis={() => {}} />,
  );
  const row = html.match(/<div[^>]*data-series-axes=""[^>]*>/)?.[0] ?? "";
  assert.match(row, /\bflex-wrap\b/);
  assert.doesNotMatch(row, /\bh-\d/, "the row has no fixed height");
  assert.doesNotMatch(row, /overflow-x-auto|overflow-x-scroll/, "the row does not scroll sideways");
  const chips = html.match(/<div[^>]*data-series-chip=""[^>]*>/g) ?? [];
  assert.equal(chips.length, 2);
  for (const chip of chips) {
    assert.match(chip, /\bmax-w-full\b/, "a chip is never wider than the panel");
    assert.match(chip, /\bmin-w-0\b/, "a chip can shrink below its content");
    assert.doesNotMatch(chip, /\bshrink-0\b/);
  }
  const label = html.match(/<span[^>]*title="validation_accuracy_smoothed_over_five_seeds"[^>]*>/)?.[0] ?? "";
  assert.match(label, /\btruncate\b/, "the name ends in an ellipsis");
  assert.match(label, /\bmin-w-0\b/);
  assert.match(html, /prefers-reduced-motion: reduce/);
});

test("the middle of the series field opens the menu, and remove stays beside the name", () => {
  const source = readFileSync(new URL("./column-select.tsx", import.meta.url), "utf8");
  const trigger = source.slice(source.indexOf("trigger={(open, toggleOpen)"), source.indexOf("</Popover>"));
  assert.match(trigger, /aria-label=\{label\}/);
  assert.equal(trigger.includes("aria-label={`Remove"), false, "the remove control is not inside the menu button");
  const chip = source.slice(source.indexOf("function ChipField"), source.indexOf("const AXIS_SIDES"));
  assert.match(chip, /max-w-\[9rem\]/);
  assert.match(chip, /pointer-events-none/);
  assert.match(chip, /<button[\s\S]*aria-label=\{`Remove/);
  assert.match(chip, /after:left-1/, "the remove hit target starts past the middle of a narrow field");
  assert.match(chip, /after:pointer-events-auto/);
});

test("an axis row is omitted until a series is chosen", () => {
  const empty = renderToStaticMarkup(
    <SeriesAxes chosen={[]} columns={columns} axisOf={() => "left"} onAxis={() => {}} />,
  );
  assert.equal(empty, "");
});

test("preview and export put the same series on the right axis", () => {
  const config = defaultPlotConfig();
  config.chart = "line";
  config.x = "step";
  config.series = [
    { y: "loss", axis: "left", error: "loss std", errorKind: "band" },
    { y: "acc", axis: "right", error: "acc std", errorKind: "band" },
  ];
  const frame = {
    columns: [
      { name: "step", type: "number" as const },
      { name: "loss", type: "number" as const },
      { name: "loss std", type: "number" as const },
      { name: "acc", type: "number" as const },
      { name: "acc std", type: "number" as const },
    ],
    rows: [
      [1, 1.2, 0.1, 0.4, 0.02],
      [2, 0.8, 0.08, 0.7, 0.03],
      [3, 0.4, 0.05, 0.9, 0.02],
    ],
  };
  const option = chartOption(frame, config, { ink: "#111", muted: "#666", line: "#ddd", panel: "#fff", accent: "#5346d6", dark: false });
  const series = option.series as Array<{ name?: string; type?: string; yAxisIndex?: number }>;
  assert.equal(series.find((item) => item.name === "loss")?.yAxisIndex, 0);
  assert.equal(series.find((item) => item.name === "acc")?.yAxisIndex, 1);
  const bands = series.filter((item) => item.type === "custom");
  assert.deepEqual(bands.map((item) => item.yAxisIndex), [0, 1]);
  const y = option.yAxis as Array<{ name?: string }>;
  assert.equal(y.length, 2);
  assert.equal(y[1]?.name, "acc");

  const source = matplotlibSource({ datasetName: "training", columns: frame.columns, config });
  assert.match(source, /ax_right = ax\.twinx\(\)/);
  assert.match(source, /ax\.plot\(_x, _y,.*label="loss"/);
  assert.match(source, /ax_right\.plot\(_x, _y,.*label="acc"/);
  assert.match(source, /ax\.fill_between\(_x, _y - _e/);
  assert.match(source, /ax_right\.fill_between\(_x, _y - _e/);
  assert.doesNotMatch(source, /ax_right\.plot\(_x, _y,.*label="loss"/);
  assert.doesNotMatch(source, /ax\.plot\(_x, _y,.*label="acc"/);
});
