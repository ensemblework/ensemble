import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { deviceCodeApi } from "@/lib/code-target";
import { ComputersCode } from "./computers-code.js";

// next/link schedules its prefetch with self.requestIdleCallback.
Object.defineProperty(globalThis, "self", { configurable: true, value: window });
(globalThis as { React?: typeof React }).React = React;

type Sent = { url: string; body: { method?: string; path?: string; query?: Record<string, string>; body?: unknown } | null };

function fakeServer(): { sent: Sent[]; restore: () => void } {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body ? (JSON.parse(String(init.body)) as Sent["body"]) : null;
    sent.push({ url, body });
    let answer: unknown = { error: "unexpected" };
    if (url.endsWith("/api/devices")) {
      answer = {
        serverRunner: false,
        devices: [
          { id: "d1", name: "Studio Mac", platform: "darwin", appVersion: "0.3.8", capabilities: { code: true, browseFiles: true }, folders: [], lastSeenAt: null, createdAt: "2026-10-14T00:00:00Z", online: true },
          { id: "d2", name: "Old Laptop", platform: "darwin", appVersion: "0.3.7", capabilities: { browseFiles: true }, folders: [], lastSeenAt: null, createdAt: "2026-10-14T00:00:00Z", online: true },
        ],
      };
    } else if (url.endsWith("/api/devices/d1/code") && body?.path === "/api/code/reviews") {
      answer = { reviews: [{ id: "5f1c2a7c-5b3c-4f4e-9a21-3d1c2b4a5e6f", title: "Clone rea and write usage", repoPath: "/Users/a/codes/run", branch: "ensemble/job-1", added: 40, removed: 0, completedAt: null, createdAt: "2026-10-14T07:00:00Z" }], ttlDays: 14 };
    } else if (url.endsWith("/api/devices/d1/code") && body?.path === "/api/code/repos") {
      answer = { repos: ["/Users/a/codes/rea"], roots: ["/Users/a/codes"] };
    }
    return new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { sent, restore: () => void (globalThis.fetch = real) };
}

test("each computer's reviews and repositories open in the editor through that computer; an older one is asked to update", async () => {
  const server = fakeServer();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ComputersCode />
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 8; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    const review = host.querySelector('a[href^="/code/review?device=d1&review="]');
    assert.ok(review, "a review opens through the computer");
    assert.match(review.textContent ?? "", /Clone rea and write usage/);
    assert.ok(host.querySelector(`a[href="/code/review?device=d1&repo=${encodeURIComponent("/Users/a/codes/rea")}"]`), "a repository opens through the computer");
    assert.ok(host.querySelector('[data-testid="computer-code-d1"] button[title^="The terminal"]'), "the computer's terminal");
    assert.match(host.querySelector('[data-testid="computer-code-d2"]')?.textContent ?? "", /Update Ensemble there/);
    const relayed = server.sent.filter((row) => row.url.endsWith("/api/devices/d1/code"));
    assert.deepEqual(relayed.map((row) => [row.body?.method, row.body?.path]).sort(), [["GET", "/api/code/repos"], ["GET", "/api/code/reviews"]]);
    assert.equal(server.sent.some((row) => row.url.includes("/api/devices/d2/code")), false, "nothing is asked of a computer that cannot answer");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    server.restore();
  }
});

test("the Code calls for a computer go through Ensemble on the web with their method, path and query", async () => {
  const server = fakeServer();
  try {
    const code = deviceCodeApi("d1");
    await code.codeDiff({ review: "r1" }, "src/a.ts", false).catch(() => undefined);
    await code.saveCodeFile({ repo: "/r" }, "src/a.ts", "text").catch(() => undefined);
    await code.commit("/r", "message").catch(() => undefined);
    assert.deepEqual(server.sent.map((row) => row.body), [
      { method: "GET", path: "/api/code/diff", query: { review: "r1", path: "src/a.ts", untracked: "false" } },
      { method: "PUT", path: "/api/code/file", query: {}, body: { repo: "/r", path: "src/a.ts", content: "text" } },
      { method: "POST", path: "/api/code/scm/commit", query: {}, body: { repo: "/r", message: "message", all: false } },
    ]);
    assert.ok(server.sent.every((row) => row.url.endsWith("/api/devices/d1/code")));
  } finally {
    server.restore();
  }
});
