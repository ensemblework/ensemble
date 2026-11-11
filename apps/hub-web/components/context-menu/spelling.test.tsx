import "../ui-test-dom.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import nspell from "nspell";
import { editorMenu } from "../editor/editor-menu.js";
import { PageTitleField } from "../pages/title-field.js";
import { closeMenu, isRow, menuStore, setHostMounted, type MenuAction, type MenuSection } from "./menu-store.js";
import { PageMenuContext } from "./page-menu.js";
import { checkable, ignoreSpelling, setSpellChecker, spellingDictionary, suggestionsFor, wordAt } from "./spelling.js";

// The editor's menu checks for tables under the pointer.
Object.defineProperty(globalThis, "HTMLTableElement", { configurable: true, writable: true, value: window.HTMLTableElement });

const dictionary = (name: string) => readFileSync(new URL(`../../public/spelling/${name}`, import.meta.url), "utf8");
setSpellChecker(nspell(dictionary("en-us.aff"), dictionary("en-us.dic")));

const actions = (sections: MenuSection[]) => sections.flatMap((section) => section.items.filter((entry): entry is MenuAction => !isRow(entry)));

test("the dictionary follows the browser's language: US, British, or none", () => {
  assert.equal(spellingDictionary(["en-US", "fr"]), "en-us");
  assert.equal(spellingDictionary(["en"]), "en-us");
  assert.equal(spellingDictionary(["en-CA"]), "en-us");
  assert.equal(spellingDictionary(["en-GB"]), "en-gb");
  assert.equal(spellingDictionary(["en-IN"]), "en-gb");
  assert.equal(spellingDictionary(["de-DE", "en-US"]), null);
  assert.equal(spellingDictionary([]), null);
});

test("a word is found around the caret, without quotes, and addresses, paths and code-like names are skipped", () => {
  assert.deepEqual(wordAt("A Landscaoe view", 5), { start: 2, end: 11, word: "Landscaoe" });
  assert.deepEqual(wordAt("A Landscaoe view", 11), { start: 2, end: 11, word: "Landscaoe" });
  assert.deepEqual(wordAt("say “recieve”.", 7), { start: 5, end: 12, word: "recieve" });
  assert.deepEqual(wordAt("'quoted' text", 3), { start: 1, end: 7, word: "quoted" });
  assert.equal(wordAt("don't", 2)?.word, "don't");
  assert.equal(wordAt("see https://exmaple.com now", 10), null);
  assert.equal(wordAt("mail akash@exmaple.com", 12), null);
  assert.equal(wordAt("open src/compnents/x.ts", 8), null);
  assert.equal(wordAt("call snake_casse here", 7), null);
  assert.equal(wordAt("version v2beta", 10), null);
  assert.equal(wordAt("a b", 0), null);
  assert.equal(wordAt("two  spaces", 4), null);
});

test("names with capitals inside are left alone", () => {
  assert.equal(checkable("Landscaoe"), true);
  assert.equal(checkable("iPhone"), false);
  assert.equal(checkable("APIs"), false);
  assert.equal(checkable("x"), false);
});

test("a misspelled word gets the dictionary's suggestions; a right one and an ignored one get none", () => {
  assert.ok(suggestionsFor("Landscaoe")?.includes("Landscape"));
  assert.ok(suggestionsFor("recieve")?.includes("receive"));
  assert.equal(suggestionsFor("receive"), null);
  assert.equal(suggestionsFor("don’t"), null);
  assert.ok(suggestionsFor("Zorblax") !== null);
  ignoreSpelling("Zorblax");
  assert.equal(suggestionsFor("Zorblax"), null);
});

test("right-clicking a title opens Ensemble's menu: spelling first, the clipboard, Select all, then the page's own menu", async () => {
  setHostMounted(true);
  const saves: string[] = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const value = { label: "Page", title: () => "Landscaoe notes", sections: () => [{ items: [{ id: "page-rename", label: "Rename" }] }] };
  await act(async () => root.render(<PageMenuContext.Provider value={value}><PageTitleField value="Landscaoe notes" onSave={(title) => saves.push(title)} /></PageMenuContext.Provider>));
  try {
    const field = document.querySelector<HTMLTextAreaElement>("[data-page-title]")!;
    field.focus();
    // macOS picks the word under the pointer on a right-click.
    field.setSelectionRange(0, 9);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 20, button: 2 });
    await act(async () => void field.dispatchEvent(event));
    assert.equal(event.defaultPrevented, true, "the browser's menu stays shut");
    const menu = menuStore.get();
    assert.ok(menu);
    assert.equal(menu.spec.sections[0]!.label, "Spelling");
    const items = actions(menu.spec.sections);
    const fix = items.find((item) => item.label === "Landscape");
    assert.ok(fix, "suggests Landscape");
    assert.ok(items.some((item) => item.id === "spelling-ignore"));
    assert.ok(items.some((item) => item.id === "select-all"));
    assert.ok(items.some((item) => item.id === "page-menu" && item.submenu));
    const row = menu.spec.sections.flatMap((section) => section.items).find(isRow);
    assert.deepEqual(row?.row.map((part) => part.id), ["cut", "copy", "paste"]);
    await act(async () => void fix.run!());
    assert.equal(field.value, "Landscape notes");
    await act(async () => field.blur());
    assert.deepEqual(saves, ["Landscape notes"]);
  } finally {
    closeMenu();
    await act(async () => root.unmount());
    host.remove();
  }
});

test("Shift+right-click on a title still gives the browser's menu", async () => {
  setHostMounted(true);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<PageTitleField value="Plan" onSave={() => undefined} />));
  try {
    const field = document.querySelector<HTMLTextAreaElement>("[data-page-title]")!;
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 2, shiftKey: true });
    await act(async () => void field.dispatchEvent(event));
    assert.equal(event.defaultPrevented, false);
    assert.equal(menuStore.get(), null);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("the page editor's menu puts suggestions for the word at the caret on top, and picking one replaces it", () => {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new Editor({ element, extensions: [StarterKit], content: "<p>A Landscaoe view</p>" });
  try {
    editor.commands.setTextSelection(5);
    const paragraph = element.querySelector("p")!;
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 0, clientY: 0 });
    Object.defineProperty(event, "target", { value: paragraph });
    const base = { title: () => "Notes", commentable: false, pickedByClick: false, openMention: () => undefined, navigate: () => undefined, toast: () => undefined };
    const spec = editorMenu(editor, event, { ...base, editable: true });
    assert.equal(spec?.sections[0]?.label, "Spelling");
    const fix = actions(spec!.sections).find((item) => item.label === "Landscape");
    assert.ok(fix);
    fix.run!();
    assert.equal(editor.getText(), "A Landscape view");
    // Read-only pages get no suggestions.
    editor.commands.setContent("<p>A Landscaoe view</p>");
    editor.commands.setTextSelection(5);
    const readOnly = editorMenu(editor, event, { ...base, editable: false });
    assert.notEqual(readOnly?.sections[0]?.label, "Spelling");
  } finally {
    editor.destroy();
    element.remove();
  }
});
