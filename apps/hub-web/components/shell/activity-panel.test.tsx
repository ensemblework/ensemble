import "../ui-test-dom.js";
import React, { act } from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ActivityControls } from "./activity-panel";
(globalThis as { React?: typeof React }).React = React;
// next/link schedules its prefetch with self.requestIdleCallback; the panel links to Runs.
Object.defineProperty(globalThis, "self", { configurable: true, value: window });
// next/link schedules its prefetch with self.requestIdleCallback; the panel links to Runs.
Object.defineProperty(globalThis, "self", { configurable: true, value: window });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const wait = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

test("one Stop everything control: it stops work and holds new runs, then the pill reads Paused and the same button resumes", async () => {
  const state = { paused: false, calls: [{ id: "a1", kind: "assistant", label: "Plan my day", model: "m", detail: null, startedAt: new Date().toISOString() }], running: [], waiting: [], queued: [] };
  const posts: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts.push(url.replace(/^.*\/api\//, "/api/"));
      if (url.endsWith("/api/agent/pause")) { state.paused = true; state.calls = []; return json({ stopped: 1, cancelled: 0 }); }
      if (url.endsWith("/api/agent/resume")) { state.paused = false; return json({ ok: true }); }
      return json({});
    }
    if (url.includes("/api/agent/state")) return json(state);
    if (url.includes("/api/shell")) return json({ user: { id: "u1" }, modules: "runs,workspace", space: null });
    return json({});
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><ActivityControls /></QueryClientProvider>));
    for (let i = 0; i < 20 && !/Working/.test(host.textContent ?? ""); i++) await wait();
    const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")];
    assert.equal(buttons().length, 1, "the pill alone: no separate pause button beside it");
    await act(async () => buttons()[0]!.click());
    const panel = host.querySelector("[data-activity-panel]")!;
    assert.ok(panel);
    assert.doesNotMatch(panel.textContent ?? "", /kill switch|Pause/i);
    const foot = () => [...panel.querySelectorAll<HTMLButtonElement>(".activity-foot button")].filter((button) => !button.getAttribute("aria-label")?.startsWith("About"));
    assert.deepEqual(foot().map((button) => button.textContent?.trim()), ["Stop everything"]);
    await act(async () => foot()[0]!.click());
    for (let i = 0; i < 20 && !/Paused/.test(host.querySelector(".activity-pill")?.textContent ?? ""); i++) await wait();
    assert.deepEqual(posts, ["/api/agent/pause"], "stops running work and holds new runs, as the kill switch did");
    assert.match(host.querySelector(".activity-pill")?.textContent ?? "", /Paused/);
    assert.deepEqual(foot().map((button) => button.textContent?.trim()), ["Resume"]);
    await act(async () => foot()[0]!.click());
    for (let i = 0; i < 20 && posts.length < 2; i++) await wait();
    assert.deepEqual(posts, ["/api/agent/pause", "/api/agent/resume"]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    globalThis.fetch = original;
  }
});
