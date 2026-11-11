import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { CommandPalette } from "./command-palette.js";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { matchParts, searchHitHref } from "./search-match.js";
import { RECENT_KEY, RECENT_LIMIT, addRecent, destinationIcon, hitKind, readRecents, rememberRecent, shortcutKeys } from "./palette-items.js";
import { SHORTCUTS } from "@ensemble/shared-types";
import { CalendarDays, Plug, Settings } from "lucide-react";

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "self", { configurable:true, value:window });

test("literal highlights are case-insensitive and preserve punctuation and URLs", () => {
  assert.deepEqual(matchParts("A+B and a+b", "a+b"), [{text:"A+B",matched:true},{text:" and ",matched:false},{text:"a+b",matched:true}]);
  assert.equal(searchHitHref("/meetings?session=abc#notes", "A+B"), "/meetings?session=abc&match=A%2BB#notes");
});

async function mountSearch(opened: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const router = { push: (path: string) => opened.push(path), replace() {}, prefetch: async () => {}, back() {}, forward() {}, refresh() {} };
  function Search() {
    const [open, setOpen] = React.useState(true);
    return <CommandPalette open={open} onClose={() => setOpen(false)} />;
  }
  client.setQueryData(["shell"], { modules: "" }); client.setQueryData(["spaces"], { spaces: [] });
  await act(async () => root.render(<QueryClientProvider client={client}><AppRouterContext.Provider value={router}><Search /></AppRouterContext.Provider></QueryClientProvider>));
  const input = host.querySelector("input")!;
  return { input, done: async () => { await act(async () => root.unmount()); host.remove(); client.clear(); } };
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

test("combined search shows matching snippets, preserves destinations and dismisses stale results", async () => {
  const original = api.searchWorkspace; const seen: string[] = []; const opened: string[] = [];
  api.searchWorkspace = async q => { seen.push(q); return { query: q, results: [{ id: "p1", kind: "page", label: "Release notes", excerpt: `A process was ${q} yesterday.`, path: "/pages/p1" }] }; };
  const view = await mountSearch(opened);
  try {
    await type(view.input, "established");
    await act(async () => new Promise(resolve => setTimeout(resolve, 240)));
    await act(async () => new Promise(resolve => setTimeout(resolve, 30)));
    assert.deepEqual(seen, ["established"]);
    assert.equal(document.querySelector("mark")!.textContent, "established");
    await act(async () => view.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    assert.deepEqual(opened, ["/pages/p1?match=established"]);
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally { await view.done(); api.searchWorkspace = original; }
});

test("Enter waits for the unique combined result and Escape cancels pending navigation", async () => {
  for (const cancel of [false, true]) {
    const original = api.searchWorkspace; let started = false; let finish: (value: Awaited<ReturnType<typeof api.searchWorkspace>>) => void = () => {};
    api.searchWorkspace = () => new Promise(resolve => { started = true; finish = resolve; });
    const opened: string[] = []; const view = await mountSearch(opened);
    try {
      await type(view.input, "Unique classifier");
      await act(async () => view.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
      for (let attempt = 0; attempt < 50 && !started; attempt++) await act(async () => new Promise(resolve => setTimeout(resolve, 20)));
      assert.equal(started, true, "the request has started before it resolves");
      if (cancel) await act(async () => view.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      await act(async () => { finish({ query: "Unique classifier", results: [{ id: "d1", kind: "diagram", label: "Unique classifier", excerpt: "Unique classifier", path: "/diagrams/d1" }] }); await new Promise(resolve => setTimeout(resolve, 30)); });
      if (!cancel) for (let attempt = 0; attempt < 50 && !opened.length; attempt++) await act(async () => new Promise(resolve => setTimeout(resolve, 20)));
      assert.deepEqual(opened, cancel ? [] : ["/diagrams/d1?match=Unique+classifier"]);
    } finally { await view.done(); api.searchWorkspace = original; }
  }
});

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), data };
}

test("recents are per space, newest first, unique by path, capped, and only in-app paths", () => {
  const store = memoryStorage();
  for (let i = 0; i < RECENT_LIMIT + 2; i++) rememberRecent(store, "s1", { label: `Page ${i}`, hint: "", href: `/pages/${i}`, kind: "page" });
  rememberRecent(store, "s1", { label: "Page 3 again", hint: "", href: "/pages/3", kind: "page" });
  rememberRecent(store, "s1", { label: "Evil", hint: "", href: "https://example.invalid" });
  rememberRecent(store, "s1", { label: "Evil", hint: "", href: "//example.invalid" });
  const rows = readRecents(store, "s1");
  assert.equal(rows.length, RECENT_LIMIT);
  assert.deepEqual(rows.slice(0, 2).map((row) => row.label), ["Page 3 again", "Page 6"]);
  assert.equal(new Set(rows.map((row) => row.href)).size, rows.length);
  assert.deepEqual(readRecents(store, "s2"), []);
  store.setItem(RECENT_KEY, "not json");
  assert.deepEqual(readRecents(store, "s1"), []);
  assert.deepEqual(addRecent([{ label: "A", hint: "", href: "/a" }], { label: "A2", hint: "", href: "/a" }).map((row) => row.label), ["A2"]);
});

test("rows get the sidebar's icons, a kind label and their own shortcut", () => {
  assert.equal(destinationIcon("/today"), CalendarDays);
  assert.equal(destinationIcon("/settings?tab=connections&connector=github"), Plug);
  assert.equal(destinationIcon("/settings?tab=appearance#theme"), Settings);
  assert.equal(hitKind("meeting_note").label, "Meeting note");
  assert.equal(hitKind("brand_new_kind").label, "Brand new kind");
  assert.deepEqual(shortcutKeys("/today", SHORTCUTS, true), ["G", "T"]);
  assert.deepEqual(shortcutKeys("act-help", SHORTCUTS, false), ["?"]);
  assert.deepEqual(shortcutKeys("/runs", SHORTCUTS, true), []);
});

test("results are grouped under labelled headings and moving the pointer selects a row", async () => {
  const original = api.searchWorkspace;
  api.searchWorkspace = async q => ({ query: q, results: [{ id: "p1", kind: "page", label: "Board notes", excerpt: "On the board", path: "/pages/p1" }] });
  const view = await mountSearch([]);
  try {
    await type(view.input, "board");
    await act(async () => new Promise(resolve => setTimeout(resolve, 240)));
    await act(async () => new Promise(resolve => setTimeout(resolve, 30)));
    const headings = [...document.querySelectorAll(".cmdk-heading")].map((node) => node.textContent);
    assert.deepEqual(headings.slice(0, 2), ["Your work", "Go to"]);
    const groups = [...document.querySelectorAll('[role="listbox"] [role="group"]')];
    assert.ok(groups.every((group) => group.getAttribute("aria-labelledby") && group.querySelector('[role="option"]')));
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    assert.equal(options[0]!.getAttribute("aria-selected"), "true");
    await act(async () => options[1]!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })));
    assert.equal(options[1]!.getAttribute("aria-selected"), "true");
    assert.equal(view.input.getAttribute("aria-activedescendant"), options[1]!.id);
  } finally { await view.done(); api.searchWorkspace = original; }
});

test("Enter while still searching opens the row that was selected once the search settles", async () => {
  const original = api.searchWorkspace; let finish: (value: Awaited<ReturnType<typeof api.searchWorkspace>>) => void = () => {}; let started = false;
  api.searchWorkspace = () => new Promise(resolve => { started = true; finish = resolve; });
  const opened: string[] = []; const view = await mountSearch(opened);
  try {
    await type(view.input, "board");
    const selected = document.querySelector('[role="option"][aria-selected="true"]');
    assert.ok(selected, "views are listed while the search runs");
    await act(async () => view.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    for (let attempt = 0; attempt < 50 && !started; attempt++) await act(async () => new Promise(resolve => setTimeout(resolve, 20)));
    assert.deepEqual(opened, []);
    await act(async () => { finish({ query: "board", results: [{ id: "p1", kind: "page", label: "Board notes", excerpt: "", path: "/pages/p1" }, { id: "p2", kind: "page", label: "Board ideas", excerpt: "", path: "/pages/p2" }] }); await new Promise(resolve => setTimeout(resolve, 30)); });
    for (let attempt = 0; attempt < 50 && !opened.length; attempt++) await act(async () => new Promise(resolve => setTimeout(resolve, 20)));
    assert.deepEqual(opened, ["/board"]);
  } finally { await view.done(); api.searchWorkspace = original; }
});
