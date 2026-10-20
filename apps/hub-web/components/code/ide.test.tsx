import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CodeIde } from "./ide.js";

// next/link schedules its prefetch with self.requestIdleCallback.
Object.defineProperty(globalThis, "self", { configurable: true, value: window });
(globalThis as { React?: typeof React }).React = React;

const REVIEW = "5f1c2a7c-5b3c-4f4e-9a21-3d1c2b4a5e6f";
const START = ["export const name = 'old';", "export const kept = true;", "// end", ""].join("\n");
const AGENT = ["export const name = 'new';", "export const kept = true;", "// end", ""].join("\n");

type Call = { method: string; url: string; body: Record<string, unknown> | null };

function server(options: { conflictOnce?: boolean; notes?: number } = {}) {
  const calls: Call[] = [];
  let conflict = options.conflictOnce ?? false;
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, url, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    const path = url.split("?")[0]!;
    if (path.endsWith("/api/code/source")) {
      return json({ kind: "review", review: { id: REVIEW, completedAt: null, outside: false, runBranch: true, canPush: false }, repo: "/work/app", branch: "ensemble/job-1", title: "Rename the export", taskId: null, model: "claude-sonnet", createdAt: "2026-10-14T07:00:00Z", files: [{ path: "src/name.ts", status: "M", added: 1, removed: 1, binary: false }], unreviewable: [], planted: [], decisions: [] });
    }
    if (path.endsWith("/api/code/progress")) return json({ files: [{ path: "src/name.ts", total: 1, pending: 1, yours: 0 }], total: 1, pending: 1, filesLeft: 1 });
    if (path.endsWith("/api/code/versions")) {
      return json({ path: "src/name.ts", kind: "review", start: START, agent: AGENT, original: START, current: AGENT, exists: { start: true, agent: true, current: true }, binary: false, tooLarge: false, eol: "lf", bom: false, hash: "h1" });
    }
    if (path.endsWith("/api/code/tree")) {
      const notes = Array.from({ length: options.notes ?? 0 }, (_, index) => ({ name: `note-${index}.md`, kind: "file", size: 10 }));
      return json({ path: "", entries: [{ name: "src", kind: "dir", size: null }, { name: "README.md", kind: "file", size: 10 }, ...notes], truncated: false });
    }
    if (path.endsWith("/api/code/scm")) return json({ repo: "/work/app", name: "app", branch: "ensemble/job-1", upstream: null, ahead: 2, behind: 0, staged: [], unstaged: [], untracked: [], log: [], remote: "", github: null });
    if (path.endsWith("/api/code/file") && method === "PUT") {
      if (conflict) {
        conflict = false;
        return json({ error: "The file changed on disk since you opened it.", conflict: true, hash: "h9" }, 409);
      }
      return json({ ok: true, hash: "h2" });
    }
    if (path.endsWith("/api/settings")) return json({ settings: { ideTheme: { activeId: "builtin:ensemble-default", favourites: [] } } });
    return json({});
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
  }
}

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
  const host = document.createElement("div");
  host.style.height = "700px";
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <CodeIde source={{ review: REVIEW }} />
      </QueryClientProvider>,
    );
  });
  await settle(20);
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
    },
  };
}

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window) {
  return act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });
}

test("the IDE opens the run's first changed file in the editor, with the explorer, the folder, progress and the status bar", async () => {
  const fake = server();
  const view = await mount();
  try {
    assert.match(view.host.querySelector('[data-testid="ide-titlebar"]')?.textContent ?? "", /Rename the export/);
    assert.ok(view.host.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.includes("name.ts"));
    assert.ok(view.host.querySelector('[data-testid="review-editor"]'), "the editor");
    assert.ok(view.host.querySelector(".cm-chunkBar-agent"), "the agent's change, with its actions");
    assert.ok(view.host.textContent?.includes("README.md"), "the folder, from the computer");
    assert.match(view.host.querySelector('[data-testid="ide-progress"]')?.textContent ?? "", /0 \/ 1 — 1 file left/);
    assert.match(view.host.querySelector('[data-testid="ide-statusbar"]')?.textContent ?? "", /ensemble\/job-1/);
    assert.ok(fake.calls.some((call) => call.url.includes("/api/code/versions") && call.url.includes("path=src%2Fname.ts")));
  } finally {
    await view.done();
    fake.restore();
  }
});

test("Reject puts the old line back and saves it, naming the version it read; a file changed on disk asks Keep mine or Use the version on disk", async () => {
  const fake = server({ conflictOnce: true });
  const view = await mount();
  try {
    const reject = view.host.querySelector(".cm-chunkBar-agent .cm-chunkBar-reject") as HTMLElement;
    await act(async () => {
      reject.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    assert.match(view.host.querySelector('[data-testid="ide-save-state"]')?.textContent ?? "", /Unsaved/);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
    });
    await settle();
    const first = fake.calls.find((call) => call.method === "PUT");
    assert.ok(first, "saved by itself after typing stops");
    assert.equal(first.body?.expectedHash, "h1", "the save names the version it read");
    assert.match(String(first.body?.content), /name = 'old'/);
    const bar = view.host.querySelector('[data-testid="ide-conflict"]');
    assert.ok(bar, "the conflict bar");
    const keep = [...bar.querySelectorAll("button")].find((button) => button.textContent?.includes("Keep mine")) as HTMLElement;
    await act(async () => keep.click());
    await settle();
    const second = fake.calls.filter((call) => call.method === "PUT")[1];
    assert.ok(second, "Keep mine saves again");
    assert.equal("expectedHash" in (second.body ?? {}), false, "and overwrites what is on disk");
    assert.match(view.host.querySelector('[data-testid="ide-save-state"]')?.textContent ?? "", /Saved/);
  } finally {
    await view.done();
    fake.restore();
  }
});

test("F4 shows the whole file, Ctrl+B hides the explorer, ? lists the shortcuts, and full screen fills the window", async () => {
  const fake = server();
  const view = await mount();
  try {
    await press("F4");
    assert.equal(view.host.querySelector('[data-testid="review-editor"]')?.getAttribute("data-mode"), "file");
    assert.ok(view.host.querySelector('aside[aria-label="Side panel"]'));
    await press("b", { ctrlKey: true });
    assert.equal(view.host.querySelector('aside[aria-label="Side panel"]'), null);
    await press("?");
    const sheet = document.querySelector('[role="dialog"][aria-label="Keyboard shortcuts"]');
    assert.ok(sheet);
    assert.match(sheet.textContent ?? "", /Alt\+Y/);
    assert.match(sheet.textContent ?? "", /bare letter/);
    await press("?");
    const fullButton = view.host.querySelector('button[aria-label="Full screen"]') as HTMLElement;
    await act(async () => fullButton.click());
    assert.ok(view.host.firstElementChild?.className.includes("fixed inset-0") || view.host.querySelector(".fixed.inset-0"), "full screen");
    await press("Escape");
    assert.ok(view.host.querySelector('button[aria-label="Full screen"]'), "Esc leaves full screen");
  } finally {
    await view.done();
    fake.restore();
  }
});

test("at most ten files stay open: the eleventh closes the oldest saved one", async () => {
  // An earlier test hid the explorer (Ctrl+B), which the IDE remembers.
  window.localStorage.clear();
  const fake = server({ notes: 10 });
  const view = await mount();
  try {
    for (let index = 0; index < 10; index += 1) {
      let entry = view.host.querySelector<HTMLButtonElement>(`button[title="note-${index}.md"]`);
      for (let round = 0; !entry && round < 40; round += 1) {
        await settle(1);
        entry = view.host.querySelector<HTMLButtonElement>(`button[title="note-${index}.md"]`);
      }
      assert.ok(entry, `note-${index}.md in the explorer`);
      await act(async () => entry.click());
      await settle(2);
    }
    const tabs = [...view.host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent ?? "");
    assert.equal(tabs.length, 10);
    assert.ok(!tabs.some((tab) => tab.includes("name.ts")), "the run's file, opened first and saved, was closed");
    assert.ok(tabs.at(-1)?.includes("note-9.md"));
  } finally {
    await view.done();
    fake.restore();
  }
});
