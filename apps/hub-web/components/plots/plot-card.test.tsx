import "../ui-test-dom";
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { defaultPlotConfig, workspaceSchema } from "@ensemble/shared-types";
import { inlinePlotRatio, mountPlotCard } from "./plot-card";

test("inline plot sizing follows chart shape and tile proportions", () => {
  assert.equal(inlinePlotRatio("line"), 1.6);
  assert.equal(inlinePlotRatio("heatmap"), 1);
  assert.equal(inlinePlotRatio("scatter", { w: 6, h: 4 }), 480 / 312);
  assert.equal(inlinePlotRatio("line", { w: 12, h: 3 }), 3);
});
test("an empty plot shows a useful state, compacts, and removes just its page embed", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ plot: { id: "plot", title: "Empty plot", datasetId: null, config: defaultPlotConfig() }, spark: [] }), { headers: { "content-type": "application/json" } });
  const host = document.createElement("span");
  document.body.append(host);
  let stop = () => {};
  let removed = 0;
  try {
    await act(async () => { stop = mountPlotCard(host, "plot", "Plot", () => { removed += 1; }).destroy; });
    assert.match(host.textContent ?? "", /No chart yet/);
    const compact = host.querySelector<HTMLButtonElement>("[aria-label='Compact plot']")!;
    await act(async () => compact.click());
    assert.equal(host.querySelector("[aria-label='Expand plot']")?.getAttribute("aria-expanded"), "false");
    assert.doesNotMatch(host.textContent ?? "", /No chart yet/);
    await act(async () => host.querySelector<HTMLButtonElement>("[aria-label='Remove plot from page']")!.click());
    assert.equal(removed, 1);
  } finally {
    await act(async () => stop());
    host.remove();
    globalThis.fetch = original;
  }
});
test("workspace tiles render their real chart instead of an empty sparkline", async () => {
  const original = globalThis.fetch;
  const config = workspaceSchema.parse({ kind: "workspace", tiles: [{ id: "tile", title: "Accuracy", chart: "line", xRef: "data\u001fepoch", yRefs: ["data\u001faccuracy"] }], datasetIds: ["11111111-1111-4111-8111-111111111111"] });
  globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).includes("/datasets/") ? { dataset: { id: "data", name: "epochs.csv", columns: [{ name: "epoch", type: "number" }, { name: "accuracy", type: "number" }], rows: [[1, 0.7], [2, 0.8]] } } : { plot: { id: "space", title: "Training", config }, spark: [] }), { headers: { "content-type": "application/json" } });
  const host = document.createElement("span");
  document.body.append(host);
  let stop = () => {};
  try {
    await act(async () => { stop = mountPlotCard(host, "space/tile", "Accuracy").destroy; });
    assert.equal(host.querySelectorAll("[data-plot-chart]").length, 1);
    assert.equal(host.querySelector("a")?.getAttribute("href"), "/plots?space=space&tile=tile");
    assert.equal(Number.parseFloat(host.querySelector<HTMLElement>("[style*='aspect-ratio']")!.style.aspectRatio), 480 / 312);
  } finally {
    await act(async () => stop());
    host.remove();
    globalThis.fetch = original;
  }
});

test("an editable plot embed keeps page width and resizes its height with a minimum", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ plot: { id: "plot", title: "Empty plot", datasetId: null, config: defaultPlotConfig() }, spark: [] }), { headers: { "content-type": "application/json" } });
  const host = document.createElement("span");
  document.body.append(host);
  const committed: number[] = [];
  let card: ReturnType<typeof mountPlotCard> | null = null;
  try {
    await act(async () => { card = mountPlotCard(host, "plot", "Plot", undefined, { height: 240, onResize: (value) => committed.push(value) }); });
    const handle = host.querySelector<HTMLElement>("[role='separator']")!;
    assert.equal(handle.getAttribute("aria-valuenow"), "240");
    await act(async () => { handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    assert.deepEqual(committed, [264]);
    for (let index = 0; index < 20; index += 1) {
      await act(async () => { handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })); });
    }
    assert.equal(committed.at(-1), 180);
    await act(async () => { card!.setHeight(400); });
    const next = host.querySelector<HTMLElement>("[role='separator']")!;
    next.dispatchEvent(new window.FocusEvent("focus"));
    assert.equal(next.getAttribute("aria-valuenow"), "400");
  } finally {
    await act(async () => card?.destroy());
    host.remove();
    globalThis.fetch = original;
  }
});
