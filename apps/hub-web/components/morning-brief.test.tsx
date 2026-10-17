/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "./ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MorningBriefPrompt } from "./morning-brief";
(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "self", { configurable: true, value: window });

test("closing and remounting the first-brief dialog cannot reopen it, even with a stale eligible response", async () => {
  const original = globalThis.fetch;
  let claimed = false, shows = 0;
  const actions: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
    if (path.endsWith("/api/brief/prompt")) {
      const { action } = JSON.parse(String(init?.body)); actions.push(action);
      const show = action === "show" && !claimed; claimed = true; if (show) shows++;
      return reply({ show });
    }
    return reply({ skill: { id: "s1", body: "Brief" }, notification: { body: "A day ahead" }, customize: true });
  }) as typeof fetch;
  const host = document.createElement("div"); document.body.appendChild(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  client.setQueryData(["shell"], { space: {} });
  const root = createRoot(host);
  const render = async (node: React.ReactNode) => act(async () => { root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>); });
  const wait = async () => { for (let i = 0; i < 10; i++) await act(async () => new Promise(resolve => setTimeout(resolve, 10))); };
  try {
    await render(<MorningBriefPrompt />); await wait();
    assert.ok(document.querySelector('[role="dialog"]'));
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
    await render(null);
    client.removeQueries({ queryKey: ["morning-brief-skill"] });
    await render(<MorningBriefPrompt />); await wait();
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(shows, 1); assert.ok(actions.includes("dismiss"));
  } finally { await act(async () => root.unmount()); host.remove(); client.clear(); globalThis.fetch = original; }
});
