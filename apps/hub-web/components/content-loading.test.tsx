/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "./ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import PagesPage from "@/app/(hub)/pages/page";
import SkillsPage from "@/app/(hub)/skills/page";
import NeedsMePage from "@/app/(hub)/needs-me/page";
import { ToastProvider } from "./toast";

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

test("Today pins stay in a horizontally scrollable row and long titles truncate inside their tiles", async () => {
  const { DeskView } = await import("./desk/view");
  const { sampleLive } = await import("./onboarding/sample");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
  client.setQueryData(["preferences"], { preferences: [] });
  client.setQueryData(["shell"], { modules: "", user: { name: "Mira" } });
  const title = "Averylongunbrokentasktitle".repeat(20);
  client.setQueryData(["desk-live"], { ...sampleLive("engineer"), pinnedTasks: [{ id: "p1", title }, { id: "p2", title: "Release checklist" }] });
  const style = document.createElement("style");
  style.textContent = readFileSync(new URL("./desk/desk.css", import.meta.url), "utf8");
  document.head.append(style);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<AppRouterContext.Provider value={router as never}><QueryClientProvider client={client}><DeskView deskId="branch" /></QueryClientProvider></AppRouterContext.Provider>));
    const pins = host.querySelector<HTMLElement>("[data-today-pins] > div")!;
    const links = pins.querySelectorAll("a");
    assert.equal(links.length, 2);
    assert.equal(links[0]!.textContent, title);
    assert.equal(links[0]!.getAttribute("href"), "/tasks/p1");
    assert.equal(getComputedStyle(pins).overflowX, "auto");
    assert.notEqual(getComputedStyle(pins).flexWrap, "wrap");
    assert.equal(getComputedStyle(links[0]!.firstElementChild!).textOverflow, "ellipsis");
    assert.ok(host.querySelector("[data-today-pins]")!.compareDocumentPosition(host.querySelector(".bento")!) & Node.DOCUMENT_POSITION_FOLLOWING);
  } finally { await act(async () => root.unmount()); host.remove(); style.remove(); client.clear(); }
});

test("a skill can be deleted in place without confirmation, while a failed delete keeps it editable", async () => {
  const original = globalThis.fetch;
  const skills = ["First", "Second"].map((name, index) => ({ id: `s${index}`, name, body: "Instructions", enabled: true, version: 1, versions: [], evidence: [], confidence: 1, provenance: "declared" }));
  let saved = [...skills];
  let fail = true;
  const deletes: string[] = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/skills") return json({ skills: saved });
    if (path.startsWith("/api/skills/") && init?.method === "DELETE") {
      deletes.push(path);
      if (fail) return json({ error: "Could not delete the skill. Try again." }, 500);
      saved = saved.filter(skill => path !== `/api/skills/${skill.id}`);
      return new Response(null, { status: 204 });
    }
    return json({ shares: [] });
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const replaced: string[] = [];
  try {
    await act(async () => root.render(<AppRouterContext.Provider value={{ ...router, replace: (href: string) => replaced.push(href) } as never}><SearchParamsContext.Provider value={new URLSearchParams("skill=s0")}><QueryClientProvider client={client}><ToastProvider><SkillsPage /></ToastProvider></QueryClientProvider></SearchParamsContext.Provider></AppRouterContext.Provider>));
    await waitFor(() => Boolean(host.querySelector('[aria-label="Delete First permanently"]')));
    const remove = () => host.querySelector<HTMLButtonElement>('[aria-label="Delete First permanently"]')!;
    await act(async () => remove().click());
    await waitFor(() => Boolean(host.querySelector('[role="status"]')));
    assert.match(host.textContent ?? "", /Could not delete the skill/);
    assert.ok(remove());
    assert.ok(host.querySelector("textarea"), "a failed deletion retains the editor");
    assert.equal(document.querySelector('[role="dialog"]'), null);
    fail = false;
    await act(async () => remove().click());
    await waitFor(() => !host.querySelector('[aria-label="Delete First permanently"]'));
    assert.deepEqual(deletes, ["/api/skills/s0", "/api/skills/s0"]);
    assert.deepEqual(replaced, ["/skills"]);
    assert.ok(host.querySelector('[aria-label="Delete Second permanently"]'));
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally { await act(async () => root.unmount()); host.remove(); client.clear(); globalThis.fetch = original; }
});

test("removing a waiting task only dismisses its Needs me tile, and Undo restores it", async () => {
  const original = globalThis.fetch;
  const task = { id: "blocked", title: "Review completed by hand", status: "blocked", updatedAt: "2026-11-01T10:00:00Z" };
  const writes: Array<{ path: string; method: string; body: unknown }> = [];
  let dismissed = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/tasks") { assert.equal(url.searchParams.get("needsMe"), "true"); return json({ tasks: dismissed ? [] : [task] }); }
    if (url.pathname.startsWith("/api/preferences/") && init?.method) {
      writes.push({ path: url.pathname, method: init.method, body: init.body ? JSON.parse(String(init.body)) : null });
      dismissed = init.method === "PUT";
      return init.method === "PUT" ? json({ preference: {} }) : new Response(null, { status: 204 });
    }
    if (url.pathname === "/api/shell") return json({ user: { id: "owner" }, modules: "all" });
    if (url.pathname === "/api/decisions") return json({ decisions: [] });
    return json({ approvals: [] });
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><ToastProvider><NeedsMePage /></ToastProvider></QueryClientProvider>));
    await waitFor(() => host.querySelector<HTMLButtonElement>('[aria-label="Remove Review completed by hand from Needs me"]')?.disabled === false);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Remove Review completed by hand from Needs me"]')!.click());
    await waitFor(() => !host.querySelector(".waiting-card"));
    assert.deepEqual(writes, [{ path: "/api/preferences/desk.needs-me.dismissed.blocked", method: "PUT", body: { value: task.updatedAt } }]);
    const undo = [...host.querySelectorAll("button")].find(button => button.textContent === "Undo");
    assert.ok(undo);
    await act(async () => undo.click());
    await waitFor(() => Boolean(host.querySelector(".waiting-card")));
    assert.equal(writes[1]?.method, "DELETE");
    assert.equal(writes.length, 2, "no task status or tool decision is changed");
  } finally { await act(async () => root.unmount()); host.remove(); client.clear(); globalThis.fetch = original; }
});
