/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import DiagramsPage from "@/app/(hub)/diagrams/page";

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "self", { configurable: true, value: window });

type Call = { method: string; path: string };

const DIAGRAM = { id: "d1", title: "Fieldnote sync", updatedAt: "2026-10-15T09:00:00.000Z", version: 1 };

async function mount(handle: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const pushed: string[] = [];
  const router = { push: (href: string) => void pushed.push(href), replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {} };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", path: new URL(String(input), "http://localhost").pathname };
    calls.push(call);
    return handle(call);
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <AppRouterContext.Provider value={router as never}>
        <QueryClientProvider client={client}>
          <DiagramsPage />
        </QueryClientProvider>
      </AppRouterContext.Provider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  return {
    calls,
    pushed,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
      globalThis.fetch = realFetch;
    },
  };
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const text = () => document.body.textContent ?? "";

function button(label: RegExp): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find((node) => label.test((node.textContent ?? "").trim()));
  assert.ok(found, `Missing button ${label}; page says: ${text().slice(0, 300)}`);
  return found as HTMLButtonElement;
}

async function settle(ms = 40) {
  await act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
}

test("a failed diagram list shows an error with Retry, not the empty state", async () => {
  let fail = true;
  const view = await mount((call) => (call.path === "/api/diagrams" ? (fail ? json({ error: "Database unavailable" }, 500) : json({ diagrams: [DIAGRAM] })) : json({}, 404)));
  try {
    await settle();
    assert.ok(document.querySelector("[data-load-error]"), text());
    assert.match(text(), /Couldn't load your diagrams/);
    assert.doesNotMatch(text(), /No diagrams yet/);
    fail = false;
    await act(async () => button(/^Retry$/).click());
    await settle(80);
    assert.equal(document.querySelector("[data-load-error]"), null);
    assert.match(text(), /Fieldnote sync/);
  } finally {
    await view.done();
  }
});

test("double-clicking a template in New diagram makes one diagram", async () => {
  let created = 0;
  const view = await mount(async (call) => {
    if (call.path === "/api/diagrams" && call.method === "POST") {
      created += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return json({ diagram: { ...DIAGRAM, id: `new-${created}`, source: "" } }, 201);
    }
    if (call.path === "/api/diagrams") return json({ diagrams: [] });
    return json({}, 404);
  });
  try {
    await settle();
    assert.match(text(), /No diagrams yet/);
    await act(async () => button(/^New diagram$/).click());
    const blank = button(/^BlankAn empty canvas$/);
    await act(async () => {
      blank.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      blank.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    });
    await settle(80);
    assert.equal(created, 1);
    assert.deepEqual(view.pushed, ["/diagrams/new-1"]);
  } finally {
    await view.done();
  }
});
