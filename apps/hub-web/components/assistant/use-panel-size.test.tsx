import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { AssistantDock } from "./assistant-dock.js";
import { clampPanelSize, defaultPanelSize, draggedPanelSize, PANEL_EDGES, PANEL_MARGIN, PANEL_MIN, PANEL_SIZE_KEY, panelBounds, readPanelSize, usePanelSize } from "./use-panel-size.js";

const WIDE = { width: 1440, height: 900 };

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

test("the panel never goes under its minimum or past the window, less the margin on each side", () => {
  assert.deepEqual(clampPanelSize({ width: 100, height: 100 }, WIDE), PANEL_MIN);
  assert.deepEqual(clampPanelSize({ width: 5000, height: 5000 }, WIDE), { width: WIDE.width - 2 * PANEL_MARGIN, height: WIDE.height - 2 * PANEL_MARGIN });
  assert.deepEqual(clampPanelSize({ width: 700.4, height: 600.6 }, WIDE), { width: 700, height: 601 });
  // A window smaller than the minimum: the panel still fits the window.
  const small = { width: 700, height: 420 };
  assert.deepEqual(clampPanelSize({ width: 900, height: 900 }, small), { width: 660, height: 380 });
  assert.deepEqual(panelBounds(small).min, { width: 380, height: 380 });
  // The default matches the stylesheet's min(660px, 94vw) × min(720px, 85vh).
  assert.deepEqual(defaultPanelSize(WIDE), { width: 660, height: 720 });
  assert.deepEqual(defaultPanelSize({ width: 800, height: 700 }), { width: 660, height: 595 });
});

test("dragging grows the panel up and to the left, from the edge or the corner it was dragged by", () => {
  const start = { width: 600, height: 600 };
  assert.deepEqual(draggedPanelSize(start, "left", -100, -50, WIDE), { width: 700, height: 600 });
  assert.deepEqual(draggedPanelSize(start, "top", -100, -50, WIDE), { width: 600, height: 650 });
  assert.deepEqual(draggedPanelSize(start, "corner", 100, 80, WIDE), { width: 500, height: 520 });
  assert.deepEqual(draggedPanelSize(start, "corner", 900, 900, WIDE), PANEL_MIN);
});

test("only a real saved size is used", () => {
  assert.deepEqual(readPanelSize({ width: 500, height: 600 }), { width: 500, height: 600 });
  for (const junk of [null, "500x600", { width: "500", height: 600 }, { width: Number.NaN, height: 600 }, { width: 500 }]) assert.equal(readPanelSize(junk), null);
});

function Harness({ active }: { active: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  const size = usePanelSize(panel, active);
  return (
    <div ref={panel} data-testid="panel" style={size.style}>
      {size.enabled ? PANEL_EDGES.map((edge) => <div key={edge} {...size.handleProps(edge)} />) : null}
    </div>
  );
}

async function mountHarness(active: boolean) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<Harness active={active} />));
  return {
    host,
    rerender: (next: boolean) => act(async () => root.render(<Harness active={next} />)),
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const separators = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[role="separator"]')];
const key = (target: HTMLElement, name: string) => act(async () => void target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));
const saved = () => JSON.parse(window.localStorage.getItem(PANEL_SIZE_KEY) ?? "null") as { width: number; height: number } | null;

test("the edges are keyboard separators: arrows resize and save, Home and double-click go back to the default", async () => {
  setViewport(WIDE.width, WIDE.height);
  window.localStorage.removeItem(PANEL_SIZE_KEY);
  const view = await mountHarness(true);
  try {
    const [left, top] = separators(view.host);
    assert.ok(left && top);
    assert.equal(left.getAttribute("aria-orientation"), "vertical");
    assert.equal(top.getAttribute("aria-orientation"), "horizontal");
    assert.equal(left.getAttribute("aria-valuenow"), "660");
    assert.equal(left.getAttribute("aria-valuemin"), String(PANEL_MIN.width));
    assert.equal(left.getAttribute("aria-valuemax"), String(WIDE.width - 2 * PANEL_MARGIN));
    assert.equal(top.getAttribute("aria-valuenow"), "720");
    assert.equal(view.host.querySelectorAll(".assistant-resize").length, 3, "left edge, top edge and the corner");
    assert.equal(view.host.querySelector('[data-edge="corner"]')?.getAttribute("aria-hidden"), "true");

    await key(left, "ArrowLeft");
    assert.deepEqual(saved(), { width: 676, height: 720 });
    await key(top, "ArrowUp");
    assert.deepEqual(saved(), { width: 676, height: 736 });
    const panel = view.host.querySelector<HTMLElement>('[data-testid="panel"]')!;
    assert.equal(panel.style.width, "676px");
    assert.equal(panel.style.height, "736px");

    await key(left, "Home");
    assert.equal(saved(), null);
    assert.equal(panel.style.width, "", "back on the stylesheet's default");

    await key(top, "ArrowDown");
    assert.deepEqual(saved(), { width: 660, height: 704 });
    await act(async () => void top.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    assert.equal(saved(), null);
  } finally {
    await view.done();
    window.localStorage.removeItem(PANEL_SIZE_KEY);
  }
});

test("a saved size is fitted to a smaller window, and comes back when the window grows", async () => {
  setViewport(WIDE.width, WIDE.height);
  window.localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify({ width: 1200, height: 820 }));
  const view = await mountHarness(true);
  try {
    const panel = view.host.querySelector<HTMLElement>('[data-testid="panel"]')!;
    assert.equal(panel.style.width, "1200px");
    setViewport(1000, 700);
    await act(async () => void window.dispatchEvent(new Event("resize")));
    assert.equal(panel.style.width, `${1000 - 2 * PANEL_MARGIN}px`);
    assert.equal(panel.style.height, `${700 - 2 * PANEL_MARGIN}px`);
    assert.deepEqual(saved(), { width: 1200, height: 820 }, "the saved size is kept");
    setViewport(WIDE.width, WIDE.height);
    await act(async () => void window.dispatchEvent(new Event("resize")));
    assert.equal(panel.style.width, "1200px");
  } finally {
    await view.done();
    window.localStorage.removeItem(PANEL_SIZE_KEY);
  }
});

test("no handles and no saved size while expanded or on a phone", async () => {
  setViewport(WIDE.width, WIDE.height);
  window.localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify({ width: 500, height: 500 }));
  const view = await mountHarness(false);
  try {
    const panel = view.host.querySelector<HTMLElement>('[data-testid="panel"]')!;
    assert.equal(view.host.querySelectorAll(".assistant-resize").length, 0);
    assert.equal(panel.style.width, "");
    await view.rerender(true);
    assert.equal(view.host.querySelectorAll(".assistant-resize").length, 3);
    assert.equal(panel.style.width, "500px");
    setViewport(390, 844);
    await act(async () => void window.dispatchEvent(new Event("resize")));
    assert.equal(view.host.querySelectorAll(".assistant-resize").length, 0);
    assert.equal(panel.style.width, "");
  } finally {
    await view.done();
    window.localStorage.removeItem(PANEL_SIZE_KEY);
    setViewport(WIDE.width, WIDE.height);
  }
});

test("dragging the corner resizes the panel, locks the cursor and text selection, and saves once on release", async () => {
  setViewport(WIDE.width, WIDE.height);
  window.localStorage.removeItem(PANEL_SIZE_KEY);
  const view = await mountHarness(true);
  try {
    const panel = view.host.querySelector<HTMLElement>('[data-testid="panel"]')!;
    panel.getBoundingClientRect = () => ({ width: 660, height: 720, top: 160, left: 760, right: 1420, bottom: 880, x: 760, y: 160, toJSON: () => ({}) });
    const corner = view.host.querySelector<HTMLElement>('[data-edge="corner"]')!;
    // jsdom has no PointerEvent; React's pointer handlers read the same fields from a MouseEvent.
    const pointer = (type: string, x: number, y: number) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    await act(async () => void corner.dispatchEvent(pointer("pointerdown", 760, 160)));
    assert.equal(document.body.dataset.assistantResizing, "corner");
    await act(async () => void window.dispatchEvent(pointer("pointermove", 700, 100)));
    assert.equal(panel.style.width, "720px");
    assert.equal(panel.style.height, "780px");
    assert.equal(saved(), null, "nothing is saved mid-drag");
    await act(async () => void window.dispatchEvent(pointer("pointerup", 700, 100)));
    assert.equal(document.body.dataset.assistantResizing, undefined);
    assert.deepEqual(saved(), { width: 720, height: 780 });
  } finally {
    await view.done();
    window.localStorage.removeItem(PANEL_SIZE_KEY);
  }
});

test("the assistant panel has the handles when floating and none when expanded", async () => {
  if (typeof Element !== "undefined" && typeof Element.prototype.scrollTo !== "function") Element.prototype.scrollTo = () => undefined;
  setViewport(WIDE.width, WIDE.height);
  const original = globalThis.fetch;
  const settings = { settings: { assistant: { defaultTier: "medium", writePolicy: "preview" }, models: { easy: { model: "m" }, medium: { model: "m" }, high: { model: "m" }, max: { model: "m" } } } };
  globalThis.fetch = (async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).includes("/api/settings") ? settings : {}), { headers: { "Content-Type": "application/json" } })) as typeof fetch;
  window.localStorage.setItem("ensemble.assistant.open", "true");
  window.localStorage.setItem("ensemble.assistant.expanded", "false");
  window.localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify({ width: 520, height: 610 }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const host = document.createElement("div");
  const root = createRoot(host);
  document.body.appendChild(host);
  try {
    await act(async () => root.render(<PathnameContext.Provider value="/today"><QueryClientProvider client={client}><AssistantDock /></QueryClientProvider></PathnameContext.Provider>));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    const panel = document.body.querySelector<HTMLElement>(".assistant-window")!;
    assert.ok(panel);
    assert.equal(panel.style.width, "520px");
    assert.equal(panel.style.height, "610px");
    assert.equal(panel.querySelectorAll('.assistant-resize[role="separator"]').length, 2);
    await act(async () => panel.querySelector<HTMLButtonElement>('button[title="Expand"]')!.click());
    assert.equal(panel.querySelectorAll(".assistant-resize").length, 0);
    assert.equal(panel.style.width, "");
    await act(async () => panel.querySelector<HTMLButtonElement>('button[title="Shrink"]')!.click());
    assert.equal(panel.style.width, "520px", "the saved size comes back");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    globalThis.fetch = original;
    for (const name of ["ensemble.assistant.open", "ensemble.assistant.expanded", PANEL_SIZE_KEY]) window.localStorage.removeItem(name);
  }
});
