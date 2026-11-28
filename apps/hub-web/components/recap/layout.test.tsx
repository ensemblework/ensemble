import "../ui-test-dom.js";
import React, { act } from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { RECAP_LAYOUT_KEY, RECAP_TILES, recapArrangement, recapPlace } from "./layout";
import { RecapTilesSection } from "./settings-section";

(globalThis as { React?: typeof React }).React = React;

// Only strings and booleans are compared: a failing assert on a rendered element formats its whole React tree.
const keys = (rows: Array<{ key: string }>) => rows.map((row) => row.key).join(",");

test("the recap shows every tile by default and keeps the person's order, widths and removed tiles", () => {
  assert.equal(keys(recapArrangement(undefined).shown), keys(RECAP_TILES));
  assert.equal(recapArrangement(undefined).hidden.length, 0);
  const saved = recapArrangement({ v: 1, tiles: [{ key: "record", c: 6, r: 3 }, { key: "rhythm", c: 2, r: 3 }, { key: "gone", c: 4, r: 3 }, { key: "highlights", c: 40, r: 3 }], hidden: ["agents"] });
  // Tiles the layout does not mention yet come after the saved ones; removed ones stay out.
  assert.equal(keys(saved.shown), "record,rhythm,highlights,when,time,projects,ahead");
  assert.equal(keys(saved.hidden), "agents");
  assert.equal(saved.shown.map((spec) => spec.c).slice(0, 3).join(","), "6,6,12", "widths stay within 6 to 12 for Daily rhythm and 3 to 12 for the rest");
});

test("Settings › Weekly recap switches tiles off and on, and Reset layout clears the saved arrangement", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  client.setQueryData(["preferences"], { preferences: [] });
  const oldPut = api.putPreference, oldDelete = api.deletePreference;
  const writes: string[] = [];
  api.putPreference = async (key, value) => {
    writes.push(`put ${key} hidden=${(value as { hidden: string[] }).hidden.join(",")}`);
    return { preference: { id: key, key, value, source: "me", confidence: 1, evidence: [] } };
  };
  api.deletePreference = async (key) => { writes.push(`delete ${key}`); return undefined as never; };
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const flip = async (label: string) => {
    const toggle = host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`);
    assert.equal(Boolean(toggle), true, `no switch "${label}"`);
    await act(async () => toggle!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  };
  const checked = (label: string) => host.querySelector(`[role="switch"][aria-label="${label}"]`)?.getAttribute("aria-checked");
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><RecapTilesSection /></QueryClientProvider>));
    assert.equal(host.querySelectorAll('[role="switch"]').length, RECAP_TILES.length);
    assert.equal(checked("Show Highlights"), "true");
    assert.equal([...host.querySelectorAll("button")].some((node) => node.textContent === "Reset layout"), false);
    await flip("Show Highlights");
    assert.equal(checked("Show Highlights"), "false");
    await flip("Show Agent work");
    await flip("Show Highlights");
    assert.equal(checked("Show Highlights"), "true");
    assert.deepEqual(writes, [`put ${RECAP_LAYOUT_KEY} hidden=highlights`, `put ${RECAP_LAYOUT_KEY} hidden=highlights,agents`, `put ${RECAP_LAYOUT_KEY} hidden=agents`]);
    const reset = [...host.querySelectorAll("button")].find((node) => node.textContent === "Reset layout");
    assert.equal(Boolean(reset), true);
    await act(async () => reset!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    assert.equal(writes.at(-1), `delete ${RECAP_LAYOUT_KEY}`);
    assert.equal(checked("Show Agent work"), "true");
  } finally {
    await act(async () => root.unmount()); host.remove(); client.clear();
    api.putPreference = oldPut; api.deletePreference = oldDelete;
  }
});

test("recap tiles keep the original tablet widths until arranged, and a week without active time leaves no gap", () => {
  const place = (layout: unknown, key: string, active: boolean) => {
    const { layout: saved, shown } = recapArrangement(layout);
    const where = recapPlace(shown.find((spec) => spec.key === key)!, shown, { customized: Boolean(saved), active });
    return `${where.c}/${where.md ?? "full"}/${where.corner ? "corner" : "no corner"}`;
  };
  // Default: Daily rhythm and Highlights full width on a tablet; the four middle tiles in pairs.
  assert.equal(["rhythm", "highlights", "when", "time", "projects", "agents", "ahead", "record"].map((key) => place(undefined, key, true).split("/")[1]).join(","), "full,full,6,6,6,6,full,full");
  // Arranged by the person: any tile of 6 columns or fewer is half a row on a tablet.
  const arranged = { v: 1, tiles: [{ key: "highlights", c: 4, r: 3 }, { key: "when", c: 8, r: 3 }], hidden: [] };
  assert.equal(place(arranged, "highlights", true), "4/6/corner");
  assert.equal(place(arranged, "when", true), "8/full/corner");
  // No active time: When you worked takes Where time went's columns (full width by default) and draws no corner.
  assert.equal(place(undefined, "when", false), "12/full/no corner");
  assert.equal(place({ v: 1, tiles: [{ key: "when", c: 4, r: 3 }, { key: "time", c: 4, r: 3 }], hidden: [] }, "when", false), "8/full/no corner");
  // With Where time went removed, the tile keeps its own width.
  assert.equal(place({ v: 1, tiles: [], hidden: ["time"] }, "when", false), "7/full/corner");
});
