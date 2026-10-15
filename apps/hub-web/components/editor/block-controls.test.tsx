/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { ToggleBlock } from "./toggle-block";
import { BlockControls } from "./block-controls";

// block-controls.tsx uses the classic JSX runtime.
(globalThis as { React?: typeof React }).React = React;
// jsdom has no pointer capture or hit testing.
Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: () => undefined });
let pointTarget: Element | null = null;
Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => pointTarget });

const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

async function mount(content: object[]) {
  const editor = new Editor({ extensions: [StarterKit, ToggleBlock], content: { type: "doc", content } });
  document.body.appendChild(editor.view.dom);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<BlockControls editor={editor} />));
  return {
    editor,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      editor.destroy();
    },
  };
}

const fire = (node: EventTarget, event: Event) => act(async () => { node.dispatchEvent(event); });
const pointer = (type: string, x = 0, y = 0) => new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
const handle = () => document.querySelector<HTMLButtonElement>("[aria-label='Block actions']");
const menu = () => document.querySelector<HTMLElement>("[role='menu']");
const items = () => Array.from(menu()?.querySelectorAll<HTMLElement>("[role^='menuitem']") ?? []);
/** Turn into rows start with the kind's symbol (H1, •, …), so match on how the text ends. */
const named = (label: string) => items().find((item) => item.textContent?.endsWith(label));
const key = (target: EventTarget, name: string) => fire(target, new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));

test("clicking the drag handle without moving opens Delete, Duplicate and Turn into; Esc returns to the handle", async () => {
  const { editor, done } = await mount([p("First"), p("Second")]);
  try {
    await fire(editor.view.dom.querySelector("p")!, pointer("pointermove"));
    assert.ok(handle());
    await fire(handle()!, pointer("pointerdown", 10, 10));
    await fire(document, pointer("pointermove", 11, 12));
    await fire(document, pointer("pointerup", 11, 12));
    await fire(handle()!, new MouseEvent("click", { bubbles: true, detail: 1 }));
    assert.ok(menu(), "a click opens the menu");
    assert.equal(handle()!.getAttribute("aria-expanded"), "true");
    const labels = items().map((item) => item.textContent);
    assert.deepEqual(labels.slice(0, 2), ["Delete", "Duplicate"]);
    assert.ok(named("Heading 1") && named("Collapsible block") && named("Numbered list"));
    assert.equal(menu()!.querySelectorAll("[aria-checked='true']").length, 1);
    assert.equal(named("Text")!.getAttribute("aria-checked"), "true");
    assert.equal(document.activeElement, items()[0]);
    await key(document.activeElement!, "ArrowDown");
    assert.equal(document.activeElement, items()[1]);
    await key(document.activeElement!, "ArrowUp");
    await key(document.activeElement!, "ArrowUp");
    assert.equal(document.activeElement, items().at(-1));
    await key(document.activeElement!, "Escape");
    assert.equal(menu(), null);
    assert.equal(document.activeElement, handle());
  } finally {
    await done();
  }
});

test("the menu opens from the keyboard and from a right click, and its actions change the block", async () => {
  const { editor, done } = await mount([p("First"), p("Second")]);
  try {
    await fire(editor.view.dom.querySelector("p")!, pointer("pointermove"));
    await fire(handle()!, new MouseEvent("click", { bubbles: true, detail: 0 }));
    assert.ok(menu(), "Enter or Space on the focused handle (a click with no pointer) opens it");
    await act(async () => items()[1]!.click());
    assert.equal(menu(), null);
    assert.deepEqual(editor.getJSON().content!.map((node) => node.content?.[0]?.text), ["First", "First", "Second"]);

    await fire(editor.view.dom.querySelector("p")!, pointer("pointermove"));
    await fire(handle()!, new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
    assert.ok(menu(), "a right click opens it");
    await act(async () => named("Heading 2")!.click());
    assert.equal(editor.state.doc.firstChild!.type.name, "heading");
    assert.equal(editor.state.doc.firstChild!.attrs.level, 2);

    await fire(editor.view.dom.querySelector("h2")!, pointer("pointermove"));
    await fire(handle()!, new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
    await act(async () => named("Delete")!.click());
    assert.deepEqual(editor.getJSON().content!.map((node) => node.content?.[0]?.text), ["First", "Second"]);
  } finally {
    await done();
  }
});

test("dragging the handle still moves the block and does not open the menu", async () => {
  const { editor, done } = await mount([p("First"), p("Second")]);
  try {
    const [first, second] = Array.from(editor.view.dom.querySelectorAll("p"));
    await fire(first!, pointer("pointermove"));
    await fire(handle()!, pointer("pointerdown", 10, 10));
    pointTarget = second!;
    await fire(document, pointer("pointermove", 10, 140));
    await fire(document, pointer("pointerup", 10, 140));
    handle()?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    assert.equal(menu(), null);
    assert.deepEqual(editor.getJSON().content!.map((node) => node.content?.[0]?.text), ["Second", "First"]);
  } finally {
    pointTarget = null;
    await done();
  }
});

test("hovering a collapsible block's summary gives the handle for the whole block", async () => {
  const { editor, done } = await mount([p("Intro"), { type: "toggleBlock", content: [p("Summary"), p("Body")] }]);
  try {
    const [summary, body] = Array.from(editor.view.dom.querySelectorAll(".toggle-block-content > p"));
    await fire(summary!, pointer("pointermove"));
    const at = Number(handle()!.dataset.blockPosition);
    assert.equal(editor.state.doc.nodeAt(at)?.type.name, "toggleBlock");
    await fire(body!, pointer("pointermove"));
    assert.equal(editor.state.doc.nodeAt(Number(handle()!.dataset.blockPosition))?.textContent, "Body");
  } finally {
    await done();
  }
});
