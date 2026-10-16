/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { getSchema, type Editor } from "@tiptap/core";
import { Step } from "@tiptap/pm/transform";
import { editorExtensions } from "../editor/extensions";
import { ToastProvider } from "../toast";
import { NotePage } from "./note-page.js";

Object.defineProperty(globalThis, "self", { configurable: true, value: window });
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: window.sessionStorage });
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

/** The server's document after `steps`, applied with the editor's schema. */
function applySteps(doc: unknown, steps: unknown[]): unknown {
  const schema = getSchema(editorExtensions(() => [], ""));
  let node = schema.nodeFromJSON(doc);
  for (const json of steps) node = Step.fromJSON(schema, json).apply(node).doc ?? node;
  return node.toJSON();
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

/** This tab's drafts of page p1 (`ensemble.draft:page:p1:<client id>`, one per editor; any older naming counts too). */
function drafts(storage: Storage = sessionStorage): string[] {
  const keys: string[] = [];
  for (let at = 0; at < storage.length; at += 1) {
    const key = storage.key(at);
    if (key?.startsWith("ensemble.draft:") && key.includes(":p1")) keys.push(key);
  }
  return keys;
}

/** The page's API: join, and steps answered as `answer()` says. `trashed()`: the page is in Trash. Editors' ids start with `account()`. */
function serve(answer: () => Answer, trashed: () => boolean = () => false, account: () => string = () => "me") {
  const posted: Array<{ version: number; steps: unknown[] }> = [];
  const log: unknown[] = [];
  const ids: string[] = [];
  let version = 0;
  let current: unknown = DOC;
  let joins = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/deleted/restore") return json({ restored: 1 });
    if (path === "/api/pages/p1" && trashed()) return json({ error: "This page is in Trash.", code: "PAGE_IN_TRASH" }, 404);
    if (path === "/api/pages/p1") return json(PAGE);
    if (path === "/api/entities") return json({ entities: [] });
    if (path === "/api/pages/p1/collab" && init?.method === "POST") {
      const mode = answer();
      if (mode === "offline") throw new TypeError("Failed to fetch");
      if (mode === "signed-out") return json({ error: "Sign in again." }, 401);
      const body = JSON.parse(String(init.body)) as { version: number; steps: unknown[]; clientID: string };
      posted.push(body);
      const from = body.version;
      if (from !== version) return json({ error: "behind", code: "COLLAB_BEHIND", epoch: "e1", from, version, steps: log.slice(from), clientIDs: ids.slice(from), saved: version }, 409);
      version += body.steps.length;
      log.push(...body.steps);
      ids.push(...body.steps.map(() => body.clientID));
      current = applySteps(current, body.steps);
      // Written back at once, as if the write-back came right after.
      return json({ epoch: "e1", from, version, steps: body.steps, clientIDs: body.steps.map(() => body.clientID), revision: 2, saved: version });
    }
    const since = new URL(String(input), "http://localhost").searchParams.get("version");
    if (path === "/api/pages/p1/collab" && since !== null) {
      const from = Number(since);
      return json({ epoch: "e1", from, version, steps: log.slice(from), clientIDs: ids.slice(from), saved: version });
    }
    if (path === "/api/pages/p1/collab") joins += 1;
    if (path === "/api/pages/p1/collab") {
      const clientID = `${account()}/${Math.random().toString(36).slice(2, 6)}`;
      return json({ epoch: "e1", version, doc: current, revision: 1, saved: version, clientID, token: `t-${clientID}` });
    }
    return json({ error: "not mocked" }, 404);
  }) as typeof fetch;
  return { posted, joins: () => joins, restore: () => (globalThis.fetch = realFetch) };
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

async function mount(waitForEditor = true, shell?: unknown) {
  // No garbage-collection timers (a mutation's is five minutes) to keep the test process alive.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  if (shell) client.setQueryData(["shell"], shell);
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
  if (waitForEditor) await waitFor(() => Boolean(document.querySelector(".ProseMirror")), "the editor");
  return {
    get editor() {
      return (document.querySelector(".ProseMirror") as HTMLElement & { editor: Editor }).editor;
    },
    status: () => document.body.textContent ?? "",
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
    },
  };
}

test("offline typing stays, says so, and is sent when the connection is back", async () => {
  sessionStorage.clear();
  let mode: Answer = "offline";
  const server = serve(() => mode);
  const page = await mount();
  try {
    await act(async () => {
      page.editor.chain().setTextSelection(7).insertContent(" for Friday").run();
    });
    await waitFor(() => page.status().includes("Offline — your changes will sync when you're back"), "the offline line");
    assert.equal(drafts().length, 1, "the typing is kept as a draft");
    const leaving = () => {
      const event = new window.Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    assert.equal(leaving(), true, "closing the tab asks first: the draft would go with it");
    assert.equal(drafts(window.localStorage).length, 0, "in this tab only: another tab never puts it back");
    mode = "ok";
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => page.status().includes("All changes saved"), "saved");
    assert.equal(server.posted.length, 1);
    assert.match(JSON.stringify(server.posted[0]!.steps), /for Friday/);
    assert.equal(drafts().length, 0, "the draft goes once saved");
    assert.equal(leaving(), false, "nothing to lose once saved");
  } finally {
    await page.done();
    server.restore();
  }
});

test("a session that expires mid-edit keeps the typing, and it comes back after signing in", async () => {
  sessionStorage.clear();
  let mode: Answer = "signed-out";
  const server = serve(() => mode);
  let page = await mount();
  try {
    await act(async () => {
      page.editor.chain().setTextSelection(7).insertContent(" and budget").run();
    });
    await waitFor(() => drafts().length === 1, "the draft");
    await page.done();

    mode = "ok";
    page = await mount();
    await waitFor(() => page.editor.getText().includes("Agenda and budget"), "the restored typing");
    await waitFor(() => page.status().includes("back on the page"), "the toast saying so");
    await waitFor(() => server.posted.length === 1 && page.status().includes("All changes saved"), "the restored typing saved");
    assert.equal(drafts().length, 0);
  } finally {
    await page.done();
    server.restore();
  }
});

test("a page in Trash is not joined; restored, it opens for editing at once", async () => {
  sessionStorage.clear();
  let binned = true;
  const server = serve(() => "ok", () => binned);
  const page = await mount(false);
  try {
    await waitFor(() => page.status().includes("This page is in Trash"), "the Trash banner");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    assert.equal(server.joins(), 0, "no live editing for a page in Trash");
    binned = false;
    const started = Date.now();
    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-trashed] button")!.click();
    });
    await waitFor(() => Boolean(document.querySelector(".ProseMirror")), "the editor after Restore", 3000);
    assert.ok(Date.now() - started < 3000, "not after a join retry's backoff");
    assert.equal(server.joins(), 1);
  } finally {
    await page.done();
    server.restore();
  }
});

test("a draft is found after a reload whether or not the app's shell loaded first, and only by its account", async () => {
  sessionStorage.clear();
  let mode: Answer = "signed-out";
  let account = "u-123";
  const server = serve(() => mode, () => false, () => account);
  // Before the reload the shell had not loaded; after it, it has.
  let page = await mount();
  try {
    await act(async () => {
      page.editor.chain().setTextSelection(7).insertContent(" and goals").run();
    });
    await waitFor(() => drafts().length === 1, "the draft");
    await page.done();

    mode = "ok";
    account = "someone-else";
    page = await mount(true, { user: { id: "someone-else" } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    assert.ok(!page.editor.getText().includes("and goals"), "another account does not get the draft");
    assert.equal(drafts().length, 1, "it stays for its account");
    await page.done();

    account = "u-123";
    page = await mount(true, { user: { id: "u-123" } });
    await waitFor(() => page.editor.getText().includes("Agenda and goals"), "the restored typing");
    await waitFor(() => server.posted.length === 1 && page.status().includes("All changes saved"), "saved");
    assert.equal(drafts().length, 0);
  } finally {
    await page.done();
    server.restore();
  }
});
