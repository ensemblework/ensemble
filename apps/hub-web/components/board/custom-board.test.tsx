/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import type { BoardPage, PageBoardRecord } from "@ensemble/shared-types";
import { PeekProvider } from "../shell/peek";
import { ToastProvider } from "../toast";

createRequire(import.meta.url).extensions[".css"] = () => undefined;

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "self", { configurable: true, value: window });
Object.defineProperty(globalThis, "CustomEvent", { configurable: true, value: window.CustomEvent });
class Observer { observe() {} unobserve() {} disconnect() {} }
Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: Observer });
// No editor warm-up in tests.
Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true } });
const date = "2026-10-28T10:00:00.000Z";
const board: PageBoardRecord = {
  id: "research", title: "Research", description: "Experiments", revision: 1, pageCount: 2,
  createdAt: date, updatedAt: date, tiles: [],
  columns: [{ id: "ideas", name: "Ideas", color: "blue" }, { id: "testing", name: "Testing", color: "violet" }],
};
const pages: BoardPage[] = [
  { id: "note1", kind: "page", title: "Lab notes", columnId: "ideas", boardOrder: 0, createdAt: date, updatedAt: date },
  { id: "task1", kind: "task", title: "Run experiment", columnId: "testing", boardOrder: 1, createdAt: date, updatedAt: date },
];

async function mount({ viewer = false } = {}) {
  const { CustomBoard } = await import("./custom-board");
  const pushes: string[] = [], requests: string[] = [];
  let rows = [...pages];
  const realFetch = globalThis.fetch;
  const shell = { user: { id: "u1" }, space: { id: "s1", shared: viewer ? { role: "viewer", owner: { name: "Owner" } } : null } };
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const method = init?.method ?? "GET";
    requests.push(`${method} ${path}`);
    let data: unknown = {};
    if (path === "/api/boards/research") data = { board, pages: rows };
    else if (path === "/api/pages" || path === "/api/tasks") data = { pages: [], tasks: [] };
    else if (path === "/api/shell") data = shell;
    else if (path === "/api/pages/note1" && method === "DELETE") { rows = rows.filter((page) => page.id !== "note1"); return new Response(null, { status: 204 }); }
    else throw new Error(`Unexpected request: ${method} ${path}`);
    return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  client.setQueryData(["boards", "research"], { board, pages: rows });
  client.setQueryData(["pages", "directory"], { pages: [] });
  client.setQueryData(["shell"], shell);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const router = { push: (href: string) => pushes.push(href), replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {} };
  await act(async () => root.render(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value="/board">
        <SearchParamsContext.Provider value={new URLSearchParams("board=research")}>
          <QueryClientProvider client={client}><ToastProvider><PeekProvider><CustomBoard id="research" /></PeekProvider></ToastProvider></QueryClientProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  ));
  return {
    host, pushes, requests,
    card: (title: string) => [...host.querySelectorAll<HTMLElement>("[data-bdg-card]")].find((node) => node.textContent?.includes(title)),
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
      globalThis.fetch = realFetch;
    },
  };
}

test("custom boards draw the Ensemble board's cards and columns, and a card opens in the side peek", async () => {
  const board = await mount();
  try {
    assert.equal(board.host.querySelectorAll(".board-column").length, 2, "the shared column");
    const note = board.card("Lab notes")!;
    assert.ok(note.querySelector(".board-card"), "the shared card");
    assert.equal(note.querySelector("a"), null, "no link to the Pages tab");
    assert.equal(board.host.querySelector("[aria-label^='Move ']"), null, "no separate drag handle");
    assert.ok(note.querySelector("button[aria-label='Delete Lab notes']"), "the hover trash button");
    await act(async () => note.click());
    assert.deepEqual(board.pushes.at(-1), "/board?board=research&peek=note1&kind=page");
    await act(async () => board.card("Run experiment")!.click());
    assert.deepEqual(board.pushes.at(-1), "/board?board=research&peek=task1");
  } finally { await board.done(); }
});

test("the trash button moves a page to Trash with Undo; viewers have none", async () => {
  const board = await mount();
  try {
    const button = board.card("Lab notes")!.querySelector<HTMLButtonElement>("button[aria-label='Delete Lab notes']")!;
    await act(async () => { button.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.ok(board.requests.includes("DELETE /api/pages/note1"));
    assert.equal(board.card("Lab notes"), undefined, "gone from the board at once");
    assert.match(document.body.textContent ?? "", /Moved to Trash\./);
    assert.ok([...document.body.querySelectorAll("button")].some((node) => node.textContent === "Undo"));
  } finally { await board.done(); }
  const viewer = await mount({ viewer: true });
  try {
    assert.equal(viewer.host.querySelector("button[aria-label^='Delete ']"), null);
  } finally { await viewer.done(); }
});
