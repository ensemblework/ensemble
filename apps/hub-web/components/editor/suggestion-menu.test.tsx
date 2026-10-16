/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { SuggestionMenu, type MenuHandle, type MenuItem } from "./suggestion-menu";

Object.defineProperty(globalThis, "self", { configurable: true, value: window });
(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => undefined });

type MenuProps = Omit<React.ComponentProps<typeof SuggestionMenu>, "ref">;

const items: MenuItem[] = [
  { type: "block", id: "h1", label: "Heading 1", detail: "Large section heading", symbol: "H1" },
  { type: "block", id: "list", label: "Numbered list", detail: "An ordered list", symbol: "1." },
];

test("the slash and @ menus are a listbox the editor points at, with the active option announced", async () => {
  const editor = new Editor({ extensions: [StarterKit], content: "<p>/</p>" });
  document.body.appendChild(editor.view.dom);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const ref = createRef<MenuHandle>();
  const picked: string[] = [];
  const props: MenuProps = { editor, items, title: "Blocks", query: "", text: "/", range: { from: 1, to: 2 }, clientRect: null, decorationNode: null, command: (item: MenuItem) => { picked.push(item.label); } } as unknown as MenuProps;
  try {
    await act(async () => root.render(<SuggestionMenu ref={ref} {...props} />));
    const list = document.querySelector("[role='listbox']")!;
    const options = Array.from(list.querySelectorAll("[role='option']"));
    const dom = editor.view.dom;
    assert.equal(list.getAttribute("aria-label"), "Blocks");
    assert.equal(options.length, 2);
    assert.equal(dom.getAttribute("aria-controls"), list.id);
    assert.equal(dom.getAttribute("aria-autocomplete"), "list");
    assert.equal(dom.getAttribute("aria-activedescendant"), options[0]!.id);
    assert.equal(options[0]!.getAttribute("aria-selected"), "true");
    assert.equal(options[0]!.getAttribute("tabindex"), "-1");
    await act(async () => { ref.current!.onKeyDown(new KeyboardEvent("keydown", { key: "ArrowDown" })); });
    assert.equal(dom.getAttribute("aria-activedescendant"), options[1]!.id);
    assert.equal(options[1]!.getAttribute("aria-selected"), "true");
    assert.equal(options[0]!.getAttribute("aria-selected"), "false");
    await act(async () => { ref.current!.onKeyDown(new KeyboardEvent("keydown", { key: "Enter" })); });
    assert.deepEqual(picked, ["Numbered list"]);
    await act(async () => root.render(<SuggestionMenu ref={ref} {...props} hidden />));
    assert.equal(dom.getAttribute("aria-activedescendant"), null, "a hidden menu is not announced");
    await act(async () => root.render(<SuggestionMenu ref={ref} {...props} />));
    await act(async () => root.unmount());
    for (const name of ["aria-controls", "aria-activedescendant", "aria-autocomplete", "aria-haspopup"]) assert.equal(dom.getAttribute(name), null, name);
  } finally {
    host.remove();
    editor.view.dom.remove();
    editor.destroy();
  }
});
