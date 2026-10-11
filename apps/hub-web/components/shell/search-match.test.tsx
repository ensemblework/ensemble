import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { AskBar } from "./ask-bar.js";
import { matchParts, searchHitHref } from "./search-match.js";

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "self", { configurable:true, value:window });

test("literal highlights are case-insensitive and preserve punctuation and URLs", () => {
  assert.deepEqual(matchParts("A+B and a+b", "a+b"), [{text:"A+B",matched:true},{text:" and ",matched:false},{text:"a+b",matched:true}]);
  assert.equal(searchHitHref("/meetings?session=abc#notes", "A+B"), "/meetings?session=abc&match=A%2BB#notes");
});

test("search shows one-line snippets with a matching highlight, preserves the destination and dismisses stale results", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry:false, gcTime: Infinity } } });
  const original = api.searchWorkspace;
  const seen: string[] = [];
  api.searchWorkspace = async (q) => { seen.push(q); return { query:q, results: [{id:"p1",kind:"page",label:"Release notes",excerpt:`A process was ${q} yesterday.`,path:"/pages/p1"}] }; };
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AskBar /></QueryClientProvider>));
    const input = host.querySelector("input")!;
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, "established"); input.dispatchEvent(new Event("input", {bubbles:true})); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 240)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    assert.deepEqual(seen, ["established"]);
    const link = document.querySelector<HTMLAnchorElement>('#workspace-link-0')!;
    assert.equal(link.getAttribute("href"), "/pages/p1?match=established");
    assert.equal(link.querySelector("mark")!.textContent, "established");
    assert.ok(!document.body.textContent?.includes("closest match"));
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true})));
    assert.equal(document.querySelector('#workspace-link-0'), null);
  } finally { await act(async () => root.unmount()); host.remove(); client.clear(); api.searchWorkspace=original; }
});
