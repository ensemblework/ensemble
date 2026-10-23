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

test("a completion plays once despite clones, layout changes, rerenders and returning to the board", async () => {
  const play = BD.mount, flip = BD.flipFrom;
  const played: string[] = [];
  let flips = 0;
  BD.mount = (_root, options) => {
    assert.equal(options?.layerParent, document.body);
    return {
      state: "idle", dragging: null,
      play: async (card) => { played.push(card.dataset.id!); return true; },
      agentMove: async () => false, complete: async () => false,
      cancel() {}, refresh() {}, destroy() {},
    };
  };
  BD.flipFrom = () => { flips++; return null; };
  const scope = `board-motion-${++serial}`;
  const host = document.createElement("div");
  document.body.append(host);
  let root = createRoot(host);
  function Board({ done, completion = "one", shifted = false, clone = false, drag = false }: { done: boolean; completion?: string; shifted?: boolean; clone?: boolean; drag?: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    useBoardMoveMotion(ref, drag, scope, [{ id: "task", column: done ? "done" : "in_progress", completion: done ? completion : null }]);
    const card = <div data-bdg-card="" data-id="task" ref={(node) => {
      if (node) node.getBoundingClientRect = () => new window.DOMRect((node.closest('[data-column="done"]') ? 300 : 0) + (node.closest('[data-shifted="true"]') ? 50 : 0), 0, 200, 80);
    }} />;
    return <div ref={ref} data-shifted={shifted}><div data-column="in_progress">{!done && card}</div><div data-column="done">{done && card}</div>{clone && <div className="bdg-layer"><div data-bdg-card="" data-id="task" /></div>}</div>;
  }
  try {
    await act(async () => root.render(<Board done={false} />));
    await act(async () => root.render(<Board done />));
    assert.deepEqual(played, ["task"]);
    await act(async () => root.render(<Board done shifted clone />));
    await act(async () => root.render(<Board done />));
    assert.deepEqual(played, ["task"]);
    assert.equal(flips, 0, "opening another surface is not a task reorder");
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(<Board done />));
    assert.deepEqual(played, ["task"], "returning does not replay a known completion");
    await act(async () => root.render(<Board done={false} />));
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(<Board done completion="two" />));
    assert.deepEqual(played, ["task", "task"], "a new completion while away plays once on return");
    await act(async () => root.render(<Board done={false} />));
    await act(async () => root.render(<Board done completion="three" drag />));
    await act(async () => root.render(<Board done completion="three" />));
    assert.equal(played.length, 2, "a person's drag is not replayed as an automated move");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    BD.mount = play;
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
