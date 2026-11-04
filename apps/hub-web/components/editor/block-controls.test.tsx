/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import { ToggleBlock } from "./toggle-block";
import { ChecklistItem } from "./check-item";
import { BlockControls } from "./block-controls";
import { moveBlockTo } from "./block-move";
import { BlockEscape, BlockSelection, BlockSelectionExtension, duplicateBlocks, selectedBlocks } from "./block-selection";

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

const li = (text: string, nested?: object) => ({ type: "listItem", content: [p(text), ...(nested ? [nested] : [])] });
const bullets = (...items: object[]) => ({ type: "bulletList", content: items });
const numbered = (...items: object[]) => ({ type: "orderedList", content: items });
/** The page as nested arrays of each block's own text, lists as their items. */
const outline = (editor: Editor): unknown[] => {
  const walk = (node: import("@tiptap/pm/model").Node): unknown => {
    if (node.type.name === "bulletList" || node.type.name === "orderedList" || node.type.name === "taskList") return { [node.type.name]: node.content.content.map(walk) };
    if (node.type.name === "listItem" || node.type.name === "taskItem") {
      const [first, ...rest] = node.content.content;
      return rest.length ? [first!.textContent, ...rest.map(walk)] : first!.textContent;
    }
    return node.textContent;
  };
  return editor.state.doc.content.content.map(walk);
};
/** The position of the block whose own first line is `text`. */
const at = (editor: Editor, text: string): number => {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if ((node.type.name === "listItem" || node.type.name === "taskItem") && node.firstChild?.textContent === text) found = pos;
    else if (node.type.name === "paragraph" && node.textContent === text && editor.state.doc.resolve(pos).parent.type.name !== "listItem") found = pos;
    return true;
  });
  assert.ok(found >= 0, text);
  return found;
};
const moveTo = (editor: Editor, block: string, target: string, after: boolean) => {
  const moved = moveBlockTo(editor.state, at(editor, block), at(editor, target), after);
  assert.ok(moved, `${block} → ${after ? "after" : "before"} ${target}`);
  editor.view.dispatch(moved.tr);
};

test("an item moves within its list, into another list and out of lists; numbers stay with their places", () => {
  const editor = new Editor({ extensions: [StarterKit, TaskList, ChecklistItem.configure({ nested: true })], content: { type: "doc", content: [
    p("Intro"),
    numbered(li("One"), li("Two"), li("Three", bullets(li("Three a"), li("Three b")))),
    p("Middle"),
    bullets(li("Apple"), li("Pear")),
  ] } });
  try {
    moveTo(editor, "One", "Three", true);
    assert.deepEqual(outline(editor)[1], { orderedList: ["Two", ["Three", { bulletList: ["Three a", "Three b"] }], "One"] });
    assert.equal(editor.state.doc.child(1).attrs.start, 1, "the list still counts from 1: the text moved, not the numbers");
    // Into a nested list: it becomes that list's kind of item.
    moveTo(editor, "Pear", "Three a", true);
    assert.deepEqual(outline(editor)[1], { orderedList: ["Two", ["Three", { bulletList: ["Three a", "Pear", "Three b"] }], "One"] });
    // Out of lists: a list of its own kind, beside the page's blocks.
    moveTo(editor, "Two", "Intro", false);
    assert.deepEqual(outline(editor).slice(0, 2), [{ orderedList: ["Two"] }, "Intro"]);
    // Next to a list of its kind it joins it.
    moveTo(editor, "Apple", "Middle", false);
    assert.deepEqual(outline(editor).slice(2), [{ orderedList: [["Three", { bulletList: ["Three a", "Pear", "Three b"] }], "One"] }, { bulletList: ["Apple"] }, "Middle"]);
    moveTo(editor, "One", "Two", true);
    assert.deepEqual(outline(editor)[0], { orderedList: ["Two", "One"] });
    // An item with nested items takes them along, and cannot go inside itself.
    assert.equal(moveBlockTo(editor.state, at(editor, "Three"), at(editor, "Three b"), true), null);
    assert.equal(moveBlockTo(editor.state, at(editor, "Three"), at(editor, "Intro"), true), null, "out of its list to just after Intro is where it is");
    moveTo(editor, "Three", "Intro", false);
    assert.deepEqual(outline(editor).slice(0, 2), [{ orderedList: ["Two", "One", ["Three", { bulletList: ["Three a", "Pear", "Three b"] }]] }, "Intro"]);
  } finally {
    editor.destroy();
  }
});

test("a block dropped between items splits their list around it; the list it left closes up", () => {
  const editor = new Editor({ extensions: [StarterKit], content: { type: "doc", content: [
    bullets(li("A"), li("B"), li("C")),
    p("Note"),
    bullets(li("D")),
    p("End"),
  ] } });
  try {
    moveTo(editor, "Note", "B", true);
    assert.deepEqual(outline(editor), [{ bulletList: ["A", "B"] }, "Note", { bulletList: ["C", "D"] }, "End"], "the lists it stood between are one again");
    moveTo(editor, "End", "A", false);
    assert.deepEqual(outline(editor), ["End", { bulletList: ["A", "B"] }, "Note", { bulletList: ["C", "D"] }]);
    moveTo(editor, "Note", "D", true);
    assert.deepEqual(outline(editor), ["End", { bulletList: ["A", "B", "C", "D"] }, "Note"]);
    assert.equal(moveBlockTo(editor.state, at(editor, "B"), at(editor, "C"), false), null, "where it already is: nothing to do");
  } finally {
    editor.destroy();
  }
});

/** Gives each element the box a browser would draw: jsdom draws none. */
function boxes(rows: Array<[Element, number, number, number?]>) {
  for (const [element, top, height, left = 40] of rows) {
    Object.defineProperty(element, "getBoundingClientRect", { configurable: true, value: () => ({ top, bottom: top + height, left, right: 800, width: 800 - left, height, x: left, y: top, toJSON: () => ({}) }) });
  }
}

test("over a list's bullets the handle is the item at that height, never the whole list, nested items included", async () => {
  const { editor, done } = await mount([p("Intro"), bullets(li("One"), li("Two", bullets(li("Two a"))), li("Three"))]);
  try {
    const items = Array.from(editor.view.dom.querySelectorAll("li"));
    const lists = Array.from(editor.view.dom.querySelectorAll("ul"));
    boxes([[editor.view.dom, 0, 400, 0], [editor.view.dom.querySelector("p")!, 0, 26, 0], [lists[0]!, 30, 140, 0], [items[0]!, 30, 26], [items[1]!, 60, 60], [lists[1]!, 90, 30, 40], [items[2]!, 90, 26, 64], [items[3]!, 124, 26]]);
    const handleFor = () => editor.state.doc.nodeAt(Number(handle()!.dataset.blockPosition))!.firstChild!.textContent;
    await fire(lists[0]!, pointer("pointermove", 10, 70));
    assert.equal(handleFor(), "Two", "the bullet gutter beside Two");
    await fire(lists[0]!, pointer("pointermove", 10, 100));
    assert.equal(handleFor(), "Two a", "beside the nested item");
    await fire(items[1]!, pointer("pointermove", 50, 100));
    assert.equal(handleFor(), "Two a", "over Two's indent before its nested list");
    await fire(lists[0]!, pointer("pointermove", 10, 130));
    assert.equal(handleFor(), "Three");
    await fire(items[3]!.querySelector("p")!, pointer("pointermove", 80, 130));
    assert.equal(handleFor(), "Three", "an item's own text is that item");
    await fire(handle()!, pointer("pointermove", 0, 400));
    assert.equal(handleFor(), "Three", "on the way to the handle it stays put");
  } finally {
    await done();
  }
});

test("dragging an item's handle reorders the items of its list", async () => {
  const { editor, done } = await mount([numbered(li("One"), li("Two"), li("Three"))]);
  try {
    const [, , three] = Array.from(editor.view.dom.querySelectorAll("li"));
    await fire(three!.querySelector("p")!, pointer("pointermove"));
    assert.equal(editor.state.doc.nodeAt(Number(handle()!.dataset.blockPosition))?.type.name, "listItem");
    await fire(handle()!, pointer("pointerdown", 10, 10));
    pointTarget = three!;
    await fire(document, pointer("pointermove", 10, -140));
    await fire(document, pointer("pointerup", 10, -140));
    assert.deepEqual(outline(editor), [{ orderedList: ["Three", "One", "Two"] }]);
  } finally {
    pointTarget = null;
    await done();
  }
});

/** An editor with block selection, its view in the page so keys and clicks reach it. */
function selectable(content: object[]) {
  const editor = new Editor({ extensions: [StarterKit, BlockSelectionExtension, BlockEscape], content: { type: "doc", content } });
  document.body.appendChild(editor.view.dom);
  return editor;
}
const press = (editor: Editor, key: string, init: KeyboardEventInit = {}) => editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
const picked = (editor: Editor) => {
  const selection = editor.state.selection;
  return selection instanceof BlockSelection ? selectedBlocks(editor.state.doc, selection.from, selection.to).map((block) => block.node.firstChild?.isTextblock ? block.node.firstChild.textContent : block.node.textContent) : null;
};

test("selected blocks are whole blocks: nested items go with their item, Delete removes them in one step and Undo brings them back", () => {
  const editor = selectable([p("Intro"), bullets(li("One"), li("Two", bullets(li("Two a"))), li("Three")), p("After")]);
  try {
    const selection = BlockSelection.create(editor.state.doc, at(editor, "Two"), at(editor, "After"))!;
    editor.view.dispatch(editor.state.tr.setSelection(selection));
    assert.deepEqual(picked(editor), ["Two", "Three", "After"], "Two a is inside Two");
    assert.equal(editor.state.selection.content().openStart, 1, "copying takes the items inside their list");
    press(editor, "x");
    assert.deepEqual(outline(editor), ["Intro", { bulletList: ["One", ["Two", { bulletList: ["Two a"] }], "Three"] }, "After"], "typing does not write over them");
    press(editor, "Backspace");
    assert.deepEqual(outline(editor), ["Intro", { bulletList: ["One"] }]);
    editor.commands.undo();
    assert.deepEqual(outline(editor), ["Intro", { bulletList: ["One", ["Two", { bulletList: ["Two a"] }], "Three"] }, "After"]);
    assert.deepEqual(picked(editor), ["Two", "Three", "After"], "and selects them again");
  } finally {
    editor.destroy();
  }
});

test("Esc selects the block the caret is in; arrows move, Shift extends, Mod+D copies, Enter writes, Esc lets go", () => {
  const editor = selectable([p("First"), p("Second"), bullets(li("Item")), p("Last")]);
  try {
    editor.commands.setTextSelection(at(editor, "Second") + 3);
    press(editor, "Escape");
    assert.deepEqual(picked(editor), ["Second"]);
    press(editor, "ArrowDown");
    assert.deepEqual(picked(editor), ["Item"]);
    press(editor, "ArrowUp", { shiftKey: true });
    assert.deepEqual(picked(editor), ["Second", "Item"]);
    press(editor, "ArrowUp");
    assert.deepEqual(picked(editor), ["First"]);
    press(editor, "ArrowDown", { shiftKey: true });
    const tr = duplicateBlocks(editor.state);
    assert.ok(tr);
    editor.view.dispatch(tr);
    assert.deepEqual(outline(editor), ["First", "Second", "First", "Second", { bulletList: ["Item"] }, "Last"]);
    assert.deepEqual(picked(editor), ["First", "Second"], "the copies are selected");
    press(editor, "Enter");
    assert.equal(editor.state.selection instanceof BlockSelection, false);
    assert.equal(editor.state.selection.$head.parent.textContent, "Second");
    press(editor, "Escape");
    press(editor, "Escape");
    assert.equal(editor.state.selection instanceof BlockSelection, false, "the second Esc lets go");
  } finally {
    editor.destroy();
  }
});

test("Mod+A selects the line's text, then every block", () => {
  const editor = selectable([p("First"), bullets(li("Item")), p("Last")]);
  try {
    editor.commands.setTextSelection(at(editor, "Last") + 2);
    press(editor, "a", { ctrlKey: true });
    assert.equal(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to), "Last");
    press(editor, "a", { ctrlKey: true });
    assert.deepEqual(picked(editor), ["First", "Item", "Last"]);
  } finally {
    editor.destroy();
  }
});

test("one click and a drag through text that reaches another block ends as those blocks; a double-click drag stays text", async () => {
  const editor = selectable([p("Alpha"), p("Beta"), p("Gamma")]);
  try {
    const across = () => editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at(editor, "Alpha") + 3, at(editor, "Beta") + 3)));
    editor.view.dom.querySelector("p")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1 }));
    across();
    assert.ok(editor.view.dom.querySelectorAll(".block-selected").length === 2, "marked as blocks while dragging");
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(picked(editor), ["Alpha", "Beta"]);
    editor.view.dom.querySelector("p")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 2 }));
    across();
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(picked(editor), null);
    assert.equal(editor.view.dom.querySelectorAll(".block-selected").length, 0);
  } finally {
    editor.destroy();
  }
});

test("a page inside a bordered card keeps its controls inside the card: the + goes where the card leaves no room for it", async () => {
  const rect = (left: number, right: number) => ({ left, right, top: 0, bottom: 400, width: right - left, height: 400, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
  for (const [inset, gutter] of [[22, "tight"], [58, ""]] as const) {
    const editor = new Editor({ extensions: [StarterKit], content: { type: "doc", content: [p("Notes")] } });
    const card = document.createElement("div");
    card.style.border = "1px solid black";
    const body = document.createElement("div");
    card.appendChild(body);
    document.body.appendChild(card);
    card.getBoundingClientRect = () => rect(300, 1000);
    body.getBoundingClientRect = () => rect(300 + inset, 960);
    const root = createRoot(body);
    try {
      await act(async () => root.render(<BlockControls editor={editor} />));
      assert.equal(body.dataset.gutterLeft ?? "", gutter, `${inset}px from the card's border`);
      assert.equal(body.dataset.gutterRight ?? "", "");
    } finally {
      await act(async () => root.unmount());
      card.remove();
      editor.destroy();
    }
  }
});
