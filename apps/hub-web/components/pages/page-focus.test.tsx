/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { bindToast } from "@/lib/toast-bus";
import { NotePage } from "./note-page.js";

Object.defineProperty(globalThis, "self", { configurable: true, value: window });
// Some components on the page use the classic JSX runtime.
(globalThis as { React?: typeof React }).React = React;
class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: Observer });
Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: Observer });

const router = { push() {}, replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {} };

const PAGE = {
  id: "p1",
  title: "Field plan",
  taskId: null,
  revision: 1,
  content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Plant the beans after the last frost." }] }] },
  notes: "",
  updatedAt: "2026-10-12T09:00:00.000Z",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

async function mount(shared?: { role: "view" | "edit" }) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/pages/p1") return json(PAGE);
    if (path === "/api/pages/p1/collab" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { version: number; steps: unknown[]; clientID: string };
      return json({ epoch: "e1", from: body.version, version: body.version + body.steps.length, steps: body.steps, clientIDs: body.steps.map(() => body.clientID), saved: body.version + body.steps.length });
    }
    if (path === "/api/pages/p1/collab") return json({ epoch: "e1", version: 0, doc: PAGE.content, revision: PAGE.revision, saved: 0, clientID: "me/tab" });
    if (path === "/api/entities") return json({ entities: [] });
    return json({ error: "not mocked" }, 404);
  }) as typeof fetch;
  bindToast(() => undefined);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  // Stands in for the sidebar and top bar: the rest of the app the page covers in focus mode.
  const chrome = document.createElement("nav");
  document.body.appendChild(chrome);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <AppRouterContext.Provider value={router as never}>
        <QueryClientProvider client={client}>
          <NotePage pageId="p1" shared={shared} />
        </QueryClientProvider>
      </AppRouterContext.Provider>,
    );
  });
  await waitFor(() => Boolean(document.querySelector(".ProseMirror")), "the editor");
  return {
    chrome,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      chrome.remove();
      client.clear();
      globalThis.fetch = realFetch;
      bindToast(null);
    },
  };
}

async function waitFor(check: () => boolean, label: string, timeout = 8000) {
  const until = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${label}; page says: ${(document.body.textContent ?? "").slice(0, 400)}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  }
}

async function fire(node: EventTarget, event: Event) {
  await act(async () => {
    node.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

const editor = () => document.querySelector<HTMLElement>(".ProseMirror")!;
const layer = () => document.querySelector<HTMLElement>('[data-page-focus="true"]');
const focusButton = () => document.querySelector<HTMLButtonElement>("[data-page-focus-button]")!;
const kept = (node: Element | null) => Boolean(node?.closest("[data-focus-keep]"));
const press = (node: EventTarget, key: string, extra: KeyboardEventInit = {}) => fire(node, new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }));
// Option+Shift+Z types "¸" on a Mac; the shortcut matches the physical key.
const chord = (node: EventTarget) => press(node, "¸", { code: "KeyZ", altKey: true, shiftKey: true });

test("Focus mode shows only the title and the page over the app, and Esc puts the page back", async () => {
  const view = await mount();
  try {
    const body = editor();
    assert.equal(body.getAttribute("contenteditable"), "true");
    assert.match(focusButton().title, /Focus mode.*Alt\+Shift\+Z/);
    await fire(focusButton(), new MouseEvent("click", { bubbles: true, cancelable: true }));
    const page = layer();
    assert.ok(page, "the page is in focus mode");
    assert.match(page!.className, /page-focus fixed inset-0/);
    assert.ok(kept(document.querySelector('textarea[aria-label="Page title"]')), "the title stays");
    assert.ok(kept(body), "the page body stays");
    assert.ok(!kept(document.querySelector('[aria-label="Delete page"]')), "page actions hide");
    assert.ok(!kept(Array.from(page!.querySelectorAll("span")).find((node) => node.textContent === "Page content") ?? null), "the section line hides");
    assert.match(page!.querySelector("[data-focus-keep]")?.textContent ?? "", /All changes saved.*Exit focus mode/);
    assert.equal(view.chrome.inert, true, "the rest of the app is inert");
    assert.equal(editor(), body, "the same editor, still mounted");
    assert.equal(body.getAttribute("contenteditable"), "true", "still editable");
    assert.equal(document.activeElement, body, "the cursor goes to the page body");

    await press(body, "Escape");
    assert.equal(layer(), null, "Esc leaves focus mode");
    assert.equal(editor(), body);
    assert.equal(view.chrome.inert, false);
  } finally {
    await view.done();
  }
});

test("Esc that an open editor menu takes keeps focus mode; Alt+Shift+Z toggles it; the browser's fullscreen ends with it", async () => {
  let fullscreen: Element | null = null;
  const calls: string[] = [];
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreen });
  Object.defineProperty(document.documentElement, "requestFullscreen", {
    configurable: true,
    value: async function (this: Element) {
      calls.push("request");
      fullscreen = this;
      document.dispatchEvent(new Event("fullscreenchange"));
    },
  });
  Object.defineProperty(document, "exitFullscreen", {
    configurable: true,
    value: async () => {
      calls.push("exit");
      fullscreen = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    },
  });
  const view = await mount();
  try {
    await chord(editor());
    assert.ok(layer(), "the shortcut opens focus mode");
    assert.deepEqual(calls, ["request"], "and asks for the browser's fullscreen on the whole document");
    assert.equal(fullscreen, document.documentElement);

    // A slash or mention menu handles Esc inside the editor first (ProseMirror marks it handled).
    editor().addEventListener("keydown", (event) => event.preventDefault(), { once: true });
    await press(editor(), "Escape");
    assert.ok(layer(), "Esc closed the menu, not focus mode");
    await press(editor(), "Escape");
    assert.equal(layer(), null);
    assert.deepEqual(calls, ["request", "exit"], "leaving focus mode leaves the browser's fullscreen");

    await chord(editor());
    assert.ok(layer());
    // The browser's own Esc or controls leave fullscreen: focus mode ends with it.
    await act(async () => {
      fullscreen = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    assert.equal(layer(), null);

    await chord(editor());
    await chord(editor());
    assert.equal(layer(), null, "the shortcut also closes it");
  } finally {
    await view.done();
    delete (document as { fullscreenElement?: unknown }).fullscreenElement;
    delete (document.documentElement as { requestFullscreen?: unknown }).requestFullscreen;
    delete (document as { exitFullscreen?: unknown }).exitFullscreen;
  }
});

test("a view-only page stays read-only in focus mode, and focus returns to the button", async () => {
  const view = await mount({ role: "view" });
  try {
    assert.equal(editor().getAttribute("contenteditable"), "false");
    const button = focusButton();
    await fire(button, new MouseEvent("click", { bubbles: true, cancelable: true }));
    assert.ok(layer());
    assert.equal(editor().getAttribute("contenteditable"), "false", "focus mode does not make it editable");
    assert.equal(document.activeElement, layer(), "focus moves into the page");
    await press(document.activeElement!, "Escape");
    assert.equal(layer(), null);
    assert.equal(document.activeElement, button, "focus is back on the button");
  } finally {
    await view.done();
  }
});
