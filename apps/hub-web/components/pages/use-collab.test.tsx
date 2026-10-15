/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { Editor } from "@tiptap/core";
import { ToastProvider } from "../toast";
import { NotePage } from "./note-page.js";

Object.defineProperty(globalThis, "self", { configurable: true, value: window });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });
(globalThis as { React?: typeof React }).React = React;
class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: Observer });
Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: Observer });

const router = { push() {}, replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {} };
const DOC = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Agenda" }] }] };
const PAGE = { id: "p1", title: "Plan", taskId: null, revision: 1, content: DOC, notes: "", updatedAt: "2026-10-16T09:00:00.000Z" };

type Answer = "ok" | "offline" | "signed-out";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

/** The page's API: join, and steps answered as `answer()` says. */
function serve(answer: () => Answer) {
  const posted: Array<{ version: number; steps: unknown[] }> = [];
  let version = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/pages/p1") return json(PAGE);
    if (path === "/api/entities") return json({ entities: [] });
    if (path === "/api/pages/p1/collab" && init?.method === "POST") {
      const mode = answer();
      if (mode === "offline") throw new TypeError("Failed to fetch");
      if (mode === "signed-out") return json({ error: "Sign in again." }, 401);
      const body = JSON.parse(String(init.body)) as { version: number; steps: unknown[]; clientID: string };
      posted.push(body);
      const from = body.version;
      version += body.steps.length;
      return json({ epoch: "e1", from, version, steps: body.steps, clientIDs: body.steps.map(() => body.clientID), revision: 2 });
    }
    if (path === "/api/pages/p1/collab") return json({ epoch: "e1", version, doc: DOC, revision: 1 });
    return json({ error: "not mocked" }, 404);
  }) as typeof fetch;
  return { posted, restore: () => (globalThis.fetch = realFetch) };
}

async function waitFor(check: () => boolean, label: string, timeout = 8000) {
  const until = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${label}; page says: ${(document.body.textContent ?? "").slice(0, 300)}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <AppRouterContext.Provider value={router as never}>
        <QueryClientProvider client={client}>
          <ToastProvider>
            <NotePage pageId="p1" />
          </ToastProvider>
        </QueryClientProvider>
      </AppRouterContext.Provider>,
    );
  });
  await waitFor(() => Boolean(document.querySelector(".ProseMirror")), "the editor");
  const editor = (document.querySelector(".ProseMirror") as HTMLElement & { editor: Editor }).editor;
  return {
    editor,
    status: () => document.body.textContent ?? "",
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
    },
  };
}

test("offline typing stays, says so, and is sent when the connection is back", async () => {
  localStorage.clear();
  let mode: Answer = "offline";
  const server = serve(() => mode);
  const page = await mount();
  try {
    await act(async () => {
      page.editor.chain().setTextSelection(7).insertContent(" for Friday").run();
    });
    await waitFor(() => page.status().includes("Offline — your changes will sync when you're back"), "the offline line");
    assert.ok(localStorage.getItem("ensemble.draft:me:page:p1"), "the typing is kept as a draft");
    mode = "ok";
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => page.status().includes("All changes saved"), "saved");
    assert.equal(server.posted.length, 1);
    assert.match(JSON.stringify(server.posted[0]!.steps), /for Friday/);
    assert.equal(localStorage.getItem("ensemble.draft:me:page:p1"), null, "the draft goes once saved");
  } finally {
    await page.done();
    server.restore();
  }
});

test("a session that expires mid-edit keeps the typing, and it comes back after signing in", async () => {
  localStorage.clear();
  let mode: Answer = "signed-out";
  const server = serve(() => mode);
  let page = await mount();
  try {
    await act(async () => {
      page.editor.chain().setTextSelection(7).insertContent(" and budget").run();
    });
    await waitFor(() => Boolean(localStorage.getItem("ensemble.draft:me:page:p1")), "the draft");
    await page.done();

    mode = "ok";
    page = await mount();
    await waitFor(() => page.editor.getText().includes("Agenda and budget"), "the restored typing");
    await waitFor(() => page.status().includes("back on the page"), "the toast saying so");
    await waitFor(() => server.posted.length === 1 && page.status().includes("All changes saved"), "the restored typing saved");
    assert.equal(localStorage.getItem("ensemble.draft:me:page:p1"), null);
  } finally {
    await page.done();
    server.restore();
  }
});
