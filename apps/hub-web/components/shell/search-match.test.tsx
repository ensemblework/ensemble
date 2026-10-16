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
