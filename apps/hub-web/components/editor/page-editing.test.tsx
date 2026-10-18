/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import { PAGE_DRAG_TYPE } from "@/lib/page-drag";
import { editorExtensions } from "./extensions";
import { applyBlock, inTable } from "./editor-commands";
import { pastedPageHtml, plainTextOf } from "./clipboard";
import { HOVER_DELAY, LinkPopover, inAppPath } from "./link-popover";
import { insertAnswer } from "../comments/ensemble-view";

Object.defineProperty(globalThis, "self", { configurable: true, value: window });
setGlobal("DOMParser", window.DOMParser);
setGlobal("ClipboardEvent", window.Event);
(globalThis as { React?: typeof React }).React = React;

function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

type Json = Record<string, unknown>;
const p = (text = ""): Json => (text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" });
const make = (...content: Json[]) => {
  const editor = new Editor({ extensions: editorExtensions(() => [], "Type / for blocks"), content: { type: "doc", content: content.length ? content : [p()] } });
  document.body.appendChild(editor.view.dom);
  return editor;
};
const done = (editor: Editor) => {
  editor.view.dom.remove();
  editor.destroy();
};
const types = (editor: Editor) => editor.getJSON().content!.map((node) => node.type);
const press = (editor: Editor, key: string, shiftKey = false) =>
  editor.view.someProp("handleKeyDown", (handle) => handle(editor.view, new KeyboardEvent("keydown", { key, shiftKey, cancelable: true })));
function paste(editor: Editor, data: Record<string, string>) {
  const event = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => data[type] ?? "", types: Object.keys(data) } });
  editor.view.dom.dispatchEvent(event);
}
function cursorIn(editor: Editor, text: string, offset = 0) {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at >= 0 || !node.isTextblock || !node.textContent.includes(text)) return at < 0;
    at = pos + 1 + node.textContent.indexOf(text) + offset;
    return false;
  });
  assert.ok(at >= 0, `no line with "${text}"`);
  editor.commands.setTextSelection(at);
}

test("pasted plain-text Markdown becomes headings, lists, checklists, code, quotes, tables and marks", () => {
  const editor = make();
  try {
    editor.commands.setTextSelection(1);
    paste(editor, { "text/plain": "## Plan\n\nShip **Friday**, see [docs](https://example.com)\n\n- one\n- two\n\n- [x] done\n- [ ] open\n\n```\nlet x = 1;\n```\n\n> quoted\n\n| A | B |\n| - | - |\n| 1 | 2 |" });
    assert.deepEqual(types(editor), ["heading", "paragraph", "bulletList", "taskList", "codeBlock", "blockquote", "table"]);
    const line = editor.state.doc.child(1);
    assert.equal(line.textContent, "Ship Friday, see docs");
    assert.ok(line.child(1).marks.some((mark) => mark.type.name === "bold"));
    assert.equal(line.lastChild!.marks[0]!.attrs.href, "https://example.com");
    assert.equal(editor.state.doc.child(3).firstChild!.attrs.checked, true);
    assert.equal(editor.state.doc.child(4).textContent, "let x = 1;");
  } finally { done(editor); }
});

test("pasted lines that are not block syntax keep their line breaks instead of joining into one", () => {
  const editor = make();
  try {
    editor.commands.setTextSelection(1);
    paste(editor, { "text/plain": "# install deps\nnpm ci\nnpm run build\n\nError at `foo()`\n  at bar.js:10\n  at baz.js:20" });
    assert.deepEqual(types(editor), ["heading", "paragraph", "paragraph"]);
    const lines = (index: number) => {
      const out: string[] = [""];
      editor.state.doc.child(index).forEach((child) => {
        if (child.type.name === "hardBreak") out.push("");
        else out[out.length - 1] += child.text ?? "";
      });
      return out;
    };
    assert.deepEqual(lines(1), ["npm ci", "npm run build"]);
    assert.deepEqual(lines(2), ["Error at foo()", "  at bar.js:10", "  at baz.js:20"]);
  } finally { done(editor); }
});

test("Markdown in the middle of a line pastes inline; HTML on the clipboard and code blocks keep the text as it is", () => {
  const editor = make(p("Hello "), { type: "codeBlock", content: [{ type: "text", text: "x" }] });
  try {
    cursorIn(editor, "Hello", 6);
    paste(editor, { "text/plain": "a **bold** word" });
    assert.equal(editor.state.doc.firstChild!.textContent, "Hello a bold word");
    assert.ok(editor.state.doc.firstChild!.child(1).marks.some((mark) => mark.type.name === "bold"));
    paste(editor, { "text/plain": "# not a heading", "text/html": "<p># not a heading</p>" });
    assert.match(editor.state.doc.firstChild!.textContent, /# not a heading/);
    cursorIn(editor, "x", 1);
    paste(editor, { "text/plain": "- [ ] stays\n**raw**" });
    assert.equal(editor.state.doc.lastChild!.textContent, "x- [ ] stays\n**raw**");
    assert.deepEqual(types(editor), ["paragraph", "codeBlock"]);
  } finally { done(editor); }
});

test("an Ensemble answer goes on the page as blocks, not as ## and ** text", () => {
  const editor = make(p("Intro"));
  try {
    assert.ok(insertAnswer(editor as never, editor.state.doc.content.size, "### Summary\n\n- **Ship** it\n- [ ] Test it\n\n1. one"));
    assert.deepEqual(types(editor), ["paragraph", "heading", "bulletList", "taskList", "orderedList"]);
    assert.equal(editor.state.doc.child(1).textContent, "Summary");
    assert.equal(JSON.stringify(editor.getJSON()).includes("**"), false);
  } finally { done(editor); }
});

test("copied blocks read as plain text with one blank line between blocks and their markers kept", () => {
  const editor = make(
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Plan" }] },
    { type: "bulletList", content: [{ type: "listItem", content: [p("one"), { type: "bulletList", content: [{ type: "listItem", content: [p("nested")] }] }] }, { type: "listItem", content: [p("two")] }] },
    { type: "orderedList", attrs: { start: 3 }, content: [{ type: "listItem", content: [p("third")] }] },
    { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [p("done")] }, { type: "taskItem", attrs: { checked: false }, content: [p("open")] }] },
    { type: "horizontalRule" },
    { type: "blockquote", content: [p("quoted")] },
    p("end"),
  );
  try {
    const text = plainTextOf(editor.state.doc.slice(0, editor.state.doc.content.size));
    assert.equal(text, "Plan\n\n- one\n  - nested\n- two\n\n3. third\n\n- [x] done\n- [ ] open\n\n---\n\n> quoted\n\nend");
    cursorIn(editor, "nested");
    const { from } = editor.state.selection;
    assert.equal(plainTextOf(editor.state.doc.slice(from, from + 4)), "nest", "part of one line is just its text");
  } finally { done(editor); }
});

test("a page row dropped or pasted from the Pages browser becomes a link-to-page block with an in-app address", () => {
  const id = "0f0e0d0c-0b0a-4908-8706-050403020100";
  const origin = window.location.origin;
  const block = pastedPageHtml(`<meta charset="utf-8"><a class="nav-link row-tile flex" href="${origin}/pages/${id}" title="Roadmap"><svg></svg><span class="truncate">Roadmap</span></a>`, origin);
  assert.match(block, /data-type="pageLink"/);
  assert.match(pastedPageHtml(`<p>See <a href="${origin}/pages/${id}">this</a> and more</p>`, origin), new RegExp(`href="/pages/${id}"`));
  assert.equal(pastedPageHtml(`<p>See <a href="https://example.com/pages/${id}">this</a></p>`, origin).includes("https://example.com"), true);

  const editor = make(p("Before"), p());
  try {
    cursorIn(editor, "", 0);
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    paste(editor, { "text/plain": `${origin}/pages/${id}`, "text/html": `<a href="${origin}/pages/${id}" title="Roadmap"><span>Roadmap</span></a>` });
    const link = editor.getJSON().content!.find((node) => node.type === "pageLink");
    assert.deepEqual({ ...link?.attrs }, { pageId: id, externalPageId: null, label: "Roadmap" });

    let prevented = false;
    const drop = { dataTransfer: { getData: (type: string) => (type === PAGE_DRAG_TYPE ? JSON.stringify({ id, title: "Notes" }) : "") }, clientX: 0, clientY: 0, preventDefault: () => { prevented = true; } };
    editor.commands.setTextSelection(1);
    assert.ok(editor.view.someProp("handleDrop", (handle) => handle(editor.view, drop as unknown as DragEvent, Slice.empty, false)));
    assert.ok(prevented);
    assert.equal(editor.getJSON().content!.filter((node) => node.type === "pageLink" && node.attrs?.label === "Notes").length, 1);
  } finally { done(editor); }
});

test("Tab and Shift+Tab indent and outdent inside a code block; Tab still nests list items", () => {
  const editor = make({ type: "codeBlock", content: [{ type: "text", text: "a\nb" }] }, { type: "bulletList", content: [{ type: "listItem", content: [p("one")] }, { type: "listItem", content: [p("two")] }] });
  try {
    cursorIn(editor, "a");
    assert.ok(press(editor, "Tab"));
    assert.equal(editor.state.doc.firstChild!.textContent, "  a\nb");
    const start = 1;
    editor.commands.setTextSelection({ from: start, to: start + editor.state.doc.firstChild!.content.size });
    assert.ok(press(editor, "Tab"));
    assert.equal(editor.state.doc.firstChild!.textContent, "    a\n  b");
    assert.ok(press(editor, "Tab", true));
    assert.equal(editor.state.doc.firstChild!.textContent, "  a\nb");
    assert.ok(press(editor, "Tab", true));
    assert.ok(press(editor, "Tab", true), "Shift+Tab with nothing to outdent still keeps focus in the code");
    assert.equal(editor.state.doc.firstChild!.textContent, "a\nb");
    cursorIn(editor, "two");
    assert.ok(press(editor, "Tab"));
    assert.equal(editor.state.doc.lastChild!.childCount, 1, "the second item nested under the first");
  } finally { done(editor); }
});

test("a table cannot be put inside a table cell, and an empty table shows no page placeholder", () => {
  const editor = make(p("/table"));
  try {
    applyBlock(editor, { from: 1, to: 7 }, "table");
    assert.equal(editor.state.doc.firstChild!.type.name, "table");
    assert.ok(inTable(editor.state.selection.$from));
    const { from } = editor.state.selection;
    editor.commands.insertContent("/table");
    applyBlock(editor, { from, to: from + 6 }, "table");
    assert.equal(JSON.stringify(editor.getJSON()).match(/"type":"table"/g)?.length, 1);
    editor.commands.deleteRange({ from, to: from + 6 });
    const marked = Array.from(editor.view.dom.querySelectorAll<HTMLElement>("[data-placeholder]")).filter((node) => node.getAttribute("data-placeholder"));
    assert.deepEqual(marked.map((node) => node.tagName), [], "no line placeholder while the cursor is in a table");
  } finally { done(editor); }
  const empty = make();
  try {
    empty.commands.setTextSelection(1);
    assert.equal(empty.view.dom.querySelector("p")?.getAttribute("data-placeholder"), "Type / for blocks");
  } finally { done(empty); }
});

test("checklist checkboxes are named by their own line, and the name follows edits", () => {
  const editor = make({ type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [p("parent"), { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [p("child")] }] }] }, { type: "taskItem", attrs: { checked: false }, content: [p()] }] });
  try {
    const labels = () => Array.from(editor.view.dom.querySelectorAll("input[type='checkbox']")).map((box) => box.getAttribute("aria-label"));
    assert.deepEqual(labels(), ["parent", "child", "Empty checklist item"]);
    editor.commands.setTextSelection(editor.state.doc.content.size - 3);
    editor.commands.insertContent("milk");
    assert.equal(labels()[2], "milk");
  } finally { done(editor); }
});

test("text lines take their direction from their own text; code stays left to right", () => {
  const editor = make({ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "مرحبا" }] }, p("שלום"), { type: "codeBlock", content: [{ type: "text", text: "x" }] });
  try {
    assert.equal(editor.view.dom.querySelector("h1")?.getAttribute("dir"), "auto");
    assert.equal(editor.view.dom.querySelector("p")?.getAttribute("dir"), "auto");
    assert.equal(editor.view.dom.querySelector("pre")?.getAttribute("dir"), null);
    assert.equal(JSON.stringify(editor.getJSON()).includes("dir"), false, "direction is not saved with the page");
  } finally { done(editor); }
});

test("an image that cannot load keeps a visible placeholder naming it", () => {
  const editor = make({ type: "image", attrs: { src: "https://example.com/gone.png", alt: "Chart" } });
  try {
    const image = editor.view.dom.querySelector<HTMLImageElement>(".page-image-frame img");
    assert.ok(image);
    image.dispatchEvent(new window.Event("error"));
    const note = editor.view.dom.querySelector(".page-image-broken");
    assert.match(note?.textContent ?? "", /Image couldn't load: Chart/);
    assert.equal(note?.querySelector("a")?.getAttribute("href"), "https://example.com/gone.png");
  } finally { done(editor); }
});

test("a click opens a link: other sites in a new tab, app pages in place; Cmd/Ctrl+click always uses a new tab", async () => {
  const editor = make({
    type: "paragraph",
    content: [
      { type: "text", text: "Read " },
      { type: "text", text: "the docs", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
      { type: "text", text: " or " },
      { type: "text", text: "the board", marks: [{ type: "link", attrs: { href: "/board" } }] },
    ],
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const opened: string[] = [];
  const realOpen = window.open;
  window.open = ((url: string) => { opened.push(url); return null; }) as typeof window.open;
  const navigated: string[] = [];
  try {
    await act(async () => root.render(<LinkPopover editor={editor} navigate={(path) => navigated.push(path)} />));
    const [docs, board] = [...editor.view.dom.querySelectorAll("a")];
    const click = (anchor: Element, init: MouseEventInit = {}) => act(async () => { anchor.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, ...init })); });
    await click(docs!);
    assert.deepEqual(opened, ["https://example.com"]);
    assert.equal(document.querySelector("[role='dialog']"), null, "a click opens the link, not the card");
    await click(board!);
    assert.deepEqual(navigated, ["/board"]);
    await click(board!, { ctrlKey: true });
    assert.deepEqual(opened, ["https://example.com", "/board"]);
    assert.equal(inAppPath("ensemble://task/task-1"), "/tasks/task-1");
    assert.equal(inAppPath("//evil.example"), null);
  } finally {
    window.open = realOpen;
    await act(async () => root.unmount());
    host.remove();
    done(editor);
  }
});

test("resting on a link offers Open, Edit and Remove, and Alt+Enter in a link reaches the same card from the keyboard", async () => {
  const editor = make({ type: "paragraph", content: [{ type: "text", text: "Read " }, { type: "text", text: "the docs", marks: [{ type: "link", attrs: { href: "https://example.com" } }] }] });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const settle = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  try {
    await act(async () => root.render(<LinkPopover editor={editor} navigate={() => undefined} />));
    const anchor = () => editor.view.dom.querySelector("a")!;
    const hover = async () => {
      await act(async () => { anchor().dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true })); });
      assert.equal(document.querySelector("[role='dialog']"), null, "the card waits for the pointer to rest");
      await settle(HOVER_DELAY + 60);
    };
    await hover();
    const card = document.querySelector<HTMLElement>("[role='dialog']");
    assert.ok(card);
    assert.match(card.textContent ?? "", /https:\/\/example\.com/);
    const button = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")).find((item) => item.textContent?.includes(label))!;
    await act(async () => button("Edit").click());
    const field = document.querySelector<HTMLInputElement>("[aria-label='Link address']")!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(field, "https://example.org/new"); field.dispatchEvent(new window.Event("input", { bubbles: true })); });
    await act(async () => { field.form!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
    assert.equal(anchor().getAttribute("href"), "https://example.org/new");
    assert.equal(anchor().textContent, "the docs");
    assert.equal(document.querySelector("[role='dialog']"), null);

    await hover();
    await act(async () => { anchor().dispatchEvent(new window.MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })); });
    await settle(320);
    assert.equal(document.querySelector("[role='dialog']"), null, "the card leaves with the pointer");

    cursorIn(editor, "the docs", 3);
    await act(async () => { editor.view.dom.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true })); });
    assert.ok(document.querySelector("[role='dialog']"), "Alt+Enter with the caret in a link shows its card");
    assert.equal(document.activeElement, button("Open"), "and moves focus into it");
    await act(async () => button("Remove").click());
    assert.equal(editor.view.dom.querySelector("a"), null);
    assert.equal(editor.state.doc.textContent, "Read the docs");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    done(editor);
  }
});
