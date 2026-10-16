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

async function mount(content: object[], comment = false) {
  const editor = new Editor({ extensions: [StarterKit, ToggleBlock], content: { type: "doc", content } });
  document.body.appendChild(editor.view.dom);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<BlockControls editor={editor} comment={comment} />));
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

test("the gaps between blocks keep the controls where they were, and no block means no visible controls", async () => {
  const { editor, done } = await mount([p("First"), p("Second")]);
  const controls = () => document.querySelector<HTMLElement>(".block-controls")!;
  try {
    assert.equal(controls().hasAttribute("data-idle"), true, "nothing hovered yet");
    await fire(editor.view.dom, pointer("pointermove"));
    assert.equal(controls().hasAttribute("data-idle"), true, "the editor's own padding is not a block");
    await fire(editor.view.dom.querySelectorAll("p")[1]!, pointer("pointermove"));
    const at = handle()!.dataset.blockPosition;
    await fire(editor.view.dom, pointer("pointermove"));
    assert.equal(handle()!.dataset.blockPosition, at);
    assert.equal(controls().hasAttribute("data-idle"), false);
  } finally {
    await done();
  }
});

test("after a scroll the controls stand for the block now under the pointer", async () => {
  const { editor, done } = await mount([p("First"), p("Second")]);
  try {
    const [first, second] = Array.from(editor.view.dom.querySelectorAll("p"));
    await fire(first!, pointer("pointermove", 5, 5));
    await fire(document, pointer("pointermove", 5, 5));
    assert.equal(editor.state.doc.nodeAt(Number(handle()!.dataset.blockPosition))?.textContent, "First");
    pointTarget = second!;
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    assert.equal(editor.state.doc.nodeAt(Number(handle()!.dataset.blockPosition))?.textContent, "Second");
  } finally {
    pointTarget = null;
    await done();
  }
});

test("the comment button stands for the same block as the handle, and only for blocks with text", async () => {
  const { editor, done } = await mount([p("First"), { type: "horizontalRule" }, { type: "bulletList", content: [{ type: "listItem", content: [p("Item")] }] }], true);
  const button = () => document.querySelector<HTMLButtonElement>(".block-comment-action");
  const asked: Array<{ from: number; to: number }> = [];
  const listen = (event: Event) => asked.push((event as CustomEvent<{ from: number; to: number }>).detail);
  editor.view.dom.addEventListener("ensemble:comment-block", listen);
  try {
    await fire(editor.view.dom.querySelector("hr")!, pointer("pointermove"));
    assert.ok(handle());
    assert.equal(button(), null);
    await fire(editor.view.dom.querySelector("li p")!, pointer("pointermove"));
    assert.ok(button());
    assert.equal(button()!.style.top, document.querySelector<HTMLElement>(".block-controls")!.style.top);
    await fire(button()!, new MouseEvent("click", { bubbles: true }));
    const item = Number(handle()!.dataset.blockPosition);
    assert.equal(editor.state.doc.nodeAt(item)?.type.name, "listItem");
    assert.deepEqual(asked, [{ from: item + 1, to: item + editor.state.doc.nodeAt(item)!.nodeSize - 1 }]);
    assert.equal(editor.state.doc.textBetween(asked[0]!.from, asked[0]!.to), "Item");
  } finally {
    editor.view.dom.removeEventListener("ensemble:comment-block", listen);
    await done();
  }
});
