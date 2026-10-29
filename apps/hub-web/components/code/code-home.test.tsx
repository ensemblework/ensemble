import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CodeHome } from "./code-home.js";

// next/link schedules its prefetch with self.requestIdleCallback.
Object.defineProperty(globalThis, "self", { configurable: true, value: window });
(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });

const RUN = "/home/me/ensemble-workspace/runs/082db2b5-7f47-467a-ae2a-d3c265595b70";

function server(answers: Record<string, unknown>) {
  const asked: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    asked.push(url);
    const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;
    const answer = answers[path] ?? (path === "/api/settings" ? { settings: { ideTheme: { activeId: "builtin:ensemble-default", favourites: [] } } } : {});
    return new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { asked, restore: () => void (globalThis.fetch = real) };
}

async function mount(shell?: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The Hub's frame has loaded the shell before a page opens.
  if (shell) client.setQueryData(["shell"], shell);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <CodeHome jobId={null} file={null} onCloseRun={() => undefined} />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 12; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
      window.localStorage.clear();
    },
  };
}

test("on this computer the Welcome lists the change to review, repositories by name (never a run's folder id) and recent code runs", async () => {
  const fake = server({
    "/api/shell": { hostCode: true },
    "/api/version": { version: "0.4.23" },
    "/api/code/reviews": { reviews: [{ id: "r1", title: "Tidy the widgets", taskId: "t1", repoPath: RUN, branch: "ensemble/tidy", delivery: "local", model: "claude-sonnet", createdAt: "2026-10-28T07:00:00Z", completedAt: null, expiresAt: "2026-11-10T00:00:00Z", decisions: 0, files: 3, added: 12, removed: 4, reachable: true }], ttlDays: 14 },
    "/api/code/repos": { repos: ["/home/me/codes/widgets", RUN], roots: ["/home/me/ensemble-workspace"] },
    "/api/workspace": { root: "/home/me/ensemble-workspace", running: [], waiting: [], queued: [], stopped: [], completed: [{ id: "j1", kind: "code", status: "succeeded", title: "Fix the login form", runId: "run1", folder: "", folderLabel: "widgets", repoUrl: null, createdAt: "2026-10-28T06:00:00Z", startedAt: null, finishedAt: "2026-10-28T06:30:00Z", files: [] }] },
  });
  const view = await mount();
  try {
    const welcome = view.host.querySelector('[data-testid="code-welcome"]')!;
    assert.ok(welcome, "the Welcome tab");
    const review = welcome.querySelector('a[href="/code/review?review=r1"]');
    assert.match(review?.textContent ?? "", /Tidy the widgets/);
    assert.match(review?.textContent ?? "", /run checkout/);
    assert.ok(welcome.querySelector(`a[href="/code/review?repo=${encodeURIComponent("/home/me/codes/widgets")}"]`), "a recent repository opens in the editor");
    assert.ok(view.host.querySelector('a[href="/runs?run=run1"]')?.textContent?.includes("Fix the login form"), "a recent code run");
    assert.doesNotMatch(view.host.textContent ?? "", /082db2b5/, "no folder id anywhere");
    const status = view.host.querySelector('[data-testid="ide-statusbar"]')?.textContent ?? "";
    assert.match(status, /1 to review/);
    assert.match(status, /v0\.4\.23/);
  } finally {
    await view.done();
    fake.restore();
  }
});

test("on Ensemble on the web with no paired computer the Welcome says so in one line and offers to pair one, asking nothing of this server's folders", async () => {
  const fake = server({ "/api/shell": { hostCode: false }, "/api/devices": { serverRunner: false, devices: [] } });
  const view = await mount({ hostCode: false });
  try {
    const welcome = view.host.querySelector('[data-testid="code-welcome"]')!;
    assert.match(welcome.textContent ?? "", /Code works on your own computers/);
    assert.equal(welcome.querySelector('a[href="/settings#devices"]')?.textContent?.trim(), "Pair a computer");
    assert.equal(fake.asked.some((url) => url.includes("/api/code/")), false);
  } finally {
    await view.done();
    fake.restore();
  }
});
