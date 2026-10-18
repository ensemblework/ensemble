import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LensTile } from "./lenses.js";

// lenses.tsx is compiled with the classic JSX runtime under tsx, so it needs React in scope here.
(globalThis as { React?: typeof React }).React = React;
// next/link schedules its viewport prefetch through `self`, which jsdom leaves off the global scope.
(globalThis as { self?: unknown }).self ??= window;

async function reviewTile(shell: Record<string, unknown>): Promise<{ text: string; calls: string[] }> {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const body = url.includes("/api/code/reviews") ? { reviews: [{ id: "r1", repoPath: "/work/site" }], ttlDays: 14 } : {};
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["shell"], shell);
  client.setQueryData(["widget-feed"], {});
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><LensTile type="review-queue" /></QueryClientProvider>));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    return { text: host.textContent ?? "", calls };
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    globalThis.fetch = realFetch;
  }
}

test("the Reviews tile reads this server's reviews only for an account that may, and points the rest to Code", async () => {
  const web = await reviewTile({ hostCode: false });
  assert.deepEqual(web.calls.filter((url) => url.includes("/api/code/")), [], "no 403 from /api/code on Ensemble on the web");
  assert.match(web.text, /reviewed in Code/);
  const operator = await reviewTile({ hostCode: true });
  assert.ok(operator.calls.some((url) => url.includes("/api/code/reviews")));
  assert.match(operator.text, /site/);
});
