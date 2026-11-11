/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "./ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import PagesPage from "@/app/(hub)/pages/page";

createRequire(import.meta.url).extensions[".css"] = () => undefined;
(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "self", { configurable: true, value: window });
window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;

const router = { push() {}, replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {} };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function waitFor(check: () => boolean) {
  for (let count = 0; count < 100; count++) {
    if (check()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  assert.ok(check(), document.body.textContent ?? "condition was not met");
}

for (const failing of ["/api/preferences", "/api/desk/live"]) {
  test(`Today replaces a failed ${failing} read with Retry instead of permanent skeletons`, async () => {
    const { DeskView } = await import("./desk/view");
    const original = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = async (input) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === failing) { attempts++; return json({ error: "The server could not load this." }, 500); }
      if (path === "/api/preferences") return json({ preferences: [] });
      if (path === "/api/shell") return json({ modules: "", user: { name: "Mira" } });
      return json({});
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<AppRouterContext.Provider value={router as never}><QueryClientProvider client={client}><DeskView deskId="default" /></QueryClientProvider></AppRouterContext.Provider>));
      await waitFor(() => Boolean(host.querySelector("[data-load-error]")));
      assert.equal(host.querySelector('[data-widget-grid="desk"] [data-motion-slot="content.skeleton"]'), null);
      assert.notEqual(host.querySelector('[data-widget-grid="desk"]')?.getAttribute("aria-busy"), "true");
      assert.match(host.textContent ?? "", /Couldn't load your desk/);
      const before = attempts;
      await act(async () => host.querySelector<HTMLButtonElement>("[data-load-error] button")!.click());
      await waitFor(() => attempts > before);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
      globalThis.fetch = original;
    }
  });
}

test("a failed background refresh leaves cached pages readable", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => json({ error: "The server could not refresh this." }, 500);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
  client.setQueryData(["pages", "directory"], { pages: [{ id: "p1", title: "Field notes", kind: "page", parentPageId: null, board: null, updatedAt: "2026-10-12T09:00:00.000Z" }] });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<AppRouterContext.Provider value={router as never}><QueryClientProvider client={client}><PagesPage /></QueryClientProvider></AppRouterContext.Provider>));
    assert.match(host.textContent ?? "", /Field notes/);
    await act(async () => { await client.invalidateQueries({ queryKey: ["pages", "directory"] }); });
    await waitFor(() => Boolean(host.querySelector('[role="alert"]')));
    assert.match(host.textContent ?? "", /Couldn't refresh your pages/);
    assert.equal(host.querySelector('a[href="/pages/p1"]')?.textContent?.includes("Field notes"), true);
    assert.equal(host.querySelector('[data-motion-slot="content.skeleton"]'), null);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    globalThis.fetch = original;
  }
});
