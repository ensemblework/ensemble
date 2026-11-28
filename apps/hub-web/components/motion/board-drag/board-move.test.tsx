/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../../ui-test-dom.js";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useBoardMoveMotion } from "./board-drag-dnd-kit";

const BD = createRequire(import.meta.url)("./board-drag.js") as typeof import("./board-drag");
(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "CustomEvent", { configurable: true, value: window.CustomEvent });
let serial = 0;

test("a card reaching Done moves like any other: no completion animation, and no reorder flip", async () => {
  const mount = BD.mount, flip = BD.flipFrom;
  let mounted = 0;
  let flips = 0;
  BD.mount = (() => { mounted++; throw new Error("the move hook should not mount the animation engine"); }) as typeof BD.mount;
  BD.flipFrom = () => { flips++; return null; };
  const scope = `board-motion-${++serial}`;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Board({ done, shifted = false }: { done: boolean; shifted?: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    useBoardMoveMotion(ref, false, scope, [{ id: "task", column: done ? "done" : "in_progress" }]);
    const card = <div data-bdg-card="" data-id="task" ref={(node) => {
      if (node) node.getBoundingClientRect = () => new window.DOMRect((node.closest('[data-column="done"]') ? 300 : 0) + (node.closest('[data-shifted="true"]') ? 50 : 0), 0, 200, 80);
    }} />;
    return <div ref={ref} data-shifted={shifted}><div data-column="in_progress">{!done && card}</div><div data-column="done">{done && card}</div></div>;
  }
  try {
    await act(async () => root.render(<Board done={false} />));
    await act(async () => root.render(<Board done />));
    await act(async () => root.render(<Board done shifted />));
    assert.equal(mounted, 0);
    assert.equal(flips, 0, "a column change or a layout shift is not a reorder");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    BD.mount = mount;
    BD.flipFrom = flip;
  }
});

test("system animation leaves React's column counts alone and ignores work queued after teardown", async () => {
  const host = document.createElement("div");
  host.dataset.reduceMotion = "true";
  host.innerHTML = '<div data-column="done"><span class="bdg-n">1</span><div><div data-bdg-card data-id="task"></div></div><div data-bdg-list></div></div>';
  document.body.append(host);
  const card = host.querySelector<HTMLElement>("[data-bdg-card]")!;
  Object.defineProperty(card, "animate", { value: () => ({ finished: Promise.resolve() }) });
  card.getAnimations = () => [];
  const engine = BD.mount(host, { input: false, layerParent: document.body, card: "[data-bdg-card]", column: "[data-column]", list: "[data-bdg-list]" });
  try {
    assert.equal(await engine.play(card, { left: 0, top: 0, width: 200, height: 80 }, "done"), true);
    assert.equal(host.querySelector(".bdg-n")?.textContent, "1");
    const queued = engine.play(card, { left: 0, top: 0, width: 200, height: 80 }, "done");
    engine.destroy();
    assert.equal(await queued, false);
    assert.equal(document.querySelector(".bdg-system-layer"), null);
  } finally { engine.destroy(); host.remove(); }
});

test("cards drawn again in another order do not glide; a reorder after a card moved does", async () => {
  const flip = BD.flipFrom;
  let flips = 0;
  BD.flipFrom = () => { flips++; return null; };
  const scope = `board-motion-${++serial}`;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  type Row = { id: string; order: number };
  function Column({ drawn, rows }: { drawn: string[]; rows: Row[] }) {
    const ref = useRef<HTMLDivElement>(null);
    useBoardMoveMotion(ref, false, scope, rows.map((row) => ({ id: row.id, column: "proposed", key: `proposed:${row.order}` })));
    return <div ref={ref}><div data-column="proposed">{drawn.map((id, index) => <div key={id} data-bdg-card="" data-id={id} ref={(node) => { if (node) node.getBoundingClientRect = () => new window.DOMRect(0, index * 90, 200, 80); }} />)}</div></div>;
  }
  const rows = [{ id: "a", order: 1 }, { id: "b", order: 2 }, { id: "c", order: 3 }];
  try {
    // Mounted in one order, then sorted by a choice loaded after mount: nothing moved, so nothing glides.
    await act(async () => root.render(<Column drawn={["c", "b", "a"]} rows={rows} />));
    await act(async () => root.render(<Column drawn={["a", "b", "c"]} rows={rows} />));
    assert.equal(flips, 0, "a re-sort on mount is not a move");
    // A refetch with the same cards and keys, drawn in the same order: nothing to glide either.
    await act(async () => root.render(<Column drawn={["a", "b", "c"]} rows={rows.map((row) => ({ ...row }))} />));
    assert.equal(flips, 0);
    // Someone moves c to the top: its key changes, and the columns follow one render later.
    const moved = [{ id: "c", order: 0 }, { id: "a", order: 1 }, { id: "b", order: 2 }];
    await act(async () => root.render(<Column drawn={["a", "b", "c"]} rows={moved} />));
    await act(async () => root.render(<Column drawn={["c", "a", "b"]} rows={moved} />));
    assert.equal(flips, 3, "every card that shifted glides after a real move");
    // The move is spent: a later re-sort without a move does not glide.
    await act(async () => root.render(<Column drawn={["a", "b", "c"]} rows={moved} />));
    assert.equal(flips, 3);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    BD.flipFrom = flip;
  }
});
