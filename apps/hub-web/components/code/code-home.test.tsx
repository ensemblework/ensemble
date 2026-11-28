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

test("on this computer the Welcome offers two ways to start, then the change to review and repositories by name (never a run's folder id), one line each", async () => {
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
    assert.deepEqual([...welcome.querySelectorAll(".code-start > span")].map((node) => node.textContent), ["Open a folder", "Code with an agent"], "two ways to start");
    assert.equal(welcome.querySelector('a[href="/runs?run=run1"]'), null, "runs stay in Runs");
    assert.doesNotMatch(view.host.textContent ?? "", /082db2b5/, "no folder id anywhere");
    const status = view.host.querySelector('[data-testid="ide-statusbar"]')?.textContent ?? "";
    assert.match(status, /1 to review/);
    assert.match(status, /v0\.4\.23/);
  } finally {
    await view.done();
    fake.restore();
  }
});

test("the status bar's text size scales the Welcome and the threads, as in a repository's window", async () => {
  const fake = server({ "/api/shell": { hostCode: true }, "/api/code/reviews": { reviews: [], ttlDays: 14 }, "/api/code/repos": { repos: [], roots: [] } });
  const view = await mount();
  try {
    const scaled = () => view.host.querySelector<HTMLElement>('[data-testid="code-welcome"]')?.closest<HTMLElement>('[style*="--code-zoom"]')?.style.getPropertyValue("--code-zoom");
    assert.equal(scaled(), "1");
    for (let i = 0; i < 2; i += 1) {
      await act(async () => view.host.querySelector<HTMLButtonElement>('button[aria-label="Bigger text"]')!.click());
    }
    assert.match(view.host.querySelector('[role="group"][aria-label="Text size"]')?.textContent ?? "", /15px/);
    assert.equal(scaled(), "1.15");
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

test("Code with an agent needs no repository: the thread starts with No folder, and the folders are there to pick", async () => {
  const thread = { id: "6d1c2a7c-5b3c-4f4e-9a21-3d1c2b4a5e6f", title: "Make a page that plans next week", createdAt: "2026-10-28T07:00:00Z", updatedAt: "2026-10-28T07:00:00Z", turns: 0, last: null, place: { deviceId: null, deviceName: null, folder: null, workdir: null } };
  const fake = server({
    "/api/shell": { hostCode: true },
    "/api/code/reviews": { reviews: [], ttlDays: 14 },
    "/api/code/repos": { repos: ["/home/me/codes/widgets"], roots: ["/home/me/ensemble-workspace"] },
    "/api/workspace": { root: "/home/me/ensemble-workspace", running: [], waiting: [], queued: [], stopped: [], completed: [] },
    "/api/agent/threads": { threads: [], thread },
    [`/api/agent/threads/${thread.id}`]: { thread: { id: thread.id, title: thread.title, place: thread.place }, turns: [] },
    "/api/agent/assign": { jobId: "j9" },
    "/api/subscriptions": { computers: [{ id: "c1", name: "This Mac", local: true, online: true, agents: [{ id: "claude-code", via: "cli", version: "1", signedIn: true, models: [{ id: "sonnet", label: "Sonnet", isDefault: true }], checkedAt: "2026-10-28T07:00:00Z" }] }] },
  });
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const answer = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (init?.method === "POST") sent.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return answer(input, init);
  }) as typeof fetch;
  const view = await mount();
  const wait = async () => {
    for (let i = 0; i < 8; i += 1) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 10))));
  };
  try {
    await act(async () => {
      [...view.host.querySelectorAll<HTMLButtonElement>('[data-testid="code-welcome"] button')].find((button) => button.textContent?.includes("Code with an agent"))!.click();
    });
    await wait();
    const agent = view.host.querySelector('[data-testid="agent-view"]')!;
    assert.ok(agent, "the agent, without opening a repository");
    assert.match(agent.querySelector('[data-testid="agent-placebar"]')?.textContent ?? "", /No folder/);
    assert.match(agent.querySelector('[data-testid="agent-empty"]')?.textContent ?? "", /No folder needed/);
    assert.ok(view.host.querySelector('[data-testid="agent-sessions"]'), "its sessions in the side panel");

    const box = agent.querySelector<HTMLTextAreaElement>('[data-testid="agent-composer"] textarea')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      box.focus();
      setter.call(box, "Make a page that plans next week");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await wait();
    const made = sent.find((row) => row.url.endsWith("/api/agent/threads"));
    assert.equal(made?.body.folder, null, "a thread with no folder");
    const turn = sent.find((row) => row.url.endsWith("/api/agent/assign"))!.body;
    assert.equal(turn.folder, undefined, "the agent works in a new workspace folder");
    assert.deepEqual({ taskId: turn.taskId, chat: turn.chat, surface: turn.surface, engine: turn.engine }, { taskId: thread.id, chat: true, surface: "code", engine: "claude-code" });
  } finally {
    globalThis.fetch = answer;
    await view.done();
    fake.restore();
  }
});
