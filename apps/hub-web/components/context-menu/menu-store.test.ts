import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import { armBrowserMenu, passesThrough, plainField, rememberPick, setMenusEnabled, withRecent } from "./menu-store.js";

const click = (target: Element, init: MouseEventInit = {}) => {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "target", { value: target });
  return event;
};

test("form fields, Shift, the armed Browser menu and the setting keep the browser's own menu", () => {
  const input = document.createElement("input");
  const editor = document.createElement("div");
  editor.className = "ProseMirror";
  editor.setAttribute("contenteditable", "true");
  const code = document.createElement("div");
  code.setAttribute("contenteditable", "true");
  const text = document.createElement("p");
  editor.appendChild(text);
  assert.equal(plainField(input), true);
  assert.equal(plainField(code), true, "a code editor keeps its own");
  assert.equal(plainField(text), false, "the page editor is Ensemble's");
  assert.equal(passesThrough(click(text)), false);
  assert.equal(passesThrough(click(text, { shiftKey: true })), true);
  armBrowserMenu();
  const once = click(text);
  assert.equal(passesThrough(once), true);
  assert.equal(passesThrough(once), true, "the same event is answered the same");
  assert.equal(passesThrough(click(text)), false, "only the next right-click");
  setMenusEnabled(false);
  assert.equal(passesThrough(click(text)), true);
  setMenusEnabled(true);
});

test("a long pick list puts the recent picks first", () => {
  const kept = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value) } });
  const items = Array.from({ length: 8 }, (_, index) => ({ id: `p${index}`, label: `Person ${index}` }));
  rememberPick("test-assign", "p5");
  rememberPick("test-assign", "p2");
  const sections = withRecent("test-assign", items, (item) => ({ id: item.id, label: item.label }));
  assert.deepEqual(sections.map((section) => section.label), ["Recent", "All"]);
  assert.deepEqual(sections[0]!.items.map((item) => ("label" in item ? item.label : "")), ["Person 2", "Person 5"]);
  assert.equal(sections[1]!.items.length, 6);
});
