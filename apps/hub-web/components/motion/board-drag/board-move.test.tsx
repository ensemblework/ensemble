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
