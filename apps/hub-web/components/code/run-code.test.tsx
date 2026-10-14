import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentJob } from "@/lib/api";
import { RunCode } from "./run-code.js";

// next/link schedules its prefetch with self.requestIdleCallback.
Object.defineProperty(globalThis, "self", { configurable: true, value: window });

const job = {
  id: "job-1",
  taskId: "task-1",
  title: "Clone and summarise rea",
  kind: "code",
  status: "succeeded",
  deviceId: "device-1",
  deviceName: "Studio Mac",
  folderLabel: "codes",
  branch: "ensemble/job-1",
  runId: "run-1",
  finishedAt: new Date().toISOString(),
} as unknown as AgentJob;

test("a run's code: the agent's files first with their text, the folder from the computer when opened, full screen on demand", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["job-files", "job-1"], {
    files: [
      { path: "usage.md", status: "added", added: 40, removed: 0, binary: false, stored: true, truncated: false, skipped: null },
      { path: "rea/README.md", status: "modified", added: 2, removed: 1, binary: false, stored: true, truncated: false, skipped: null },
      { path: "old.txt", status: "deleted", added: 0, removed: 3, binary: false, stored: false, truncated: false, skipped: null },
    ],
    live: { available: true, reason: null },
    where: "device",
  });
  client.setQueryData(["job-file", "job-1", "usage.md", false], { source: "stored", file: { path: "usage.md", size: 20, content: "# Usage\nnpx rea-agents setup\n", binary: false, truncated: false } });
  client.setQueryData(["job-tree", "job-1", ""], { listing: { path: "", entries: [{ name: "rea", kind: "dir", size: null }, { name: "usage.md", kind: "file", size: 20 }], truncated: false, hidden: 2 } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <RunCode job={job} />
      </QueryClientProvider>,
    );
  });
  const view = host.querySelector('[data-testid="run-code"]') as HTMLElement;
  const text = view.textContent ?? "";
  assert.match(text, /Changed by the agent · 3/);
  assert.match(text, /usage\.md/);
  assert.match(text, /README\.md\s*rea/, "a file inside the clone shows with its folder");
  assert.match(text, /npx rea-agents setup/, "the first changed file opens by itself, with its text");
  assert.match(text, /as the run left it/);
  assert.match(text, /Studio Mac · codes · ensemble\/job-1/);
  assert.doesNotMatch(text, /hidden \(git/, "the folder is not read until it is opened");

  const folderToggle = [...view.querySelectorAll("button")].find((button) => /Folder on Studio Mac/.test(button.textContent ?? "")) as HTMLButtonElement;
  await act(async () => folderToggle.click());
  assert.match(view.textContent ?? "", /rea/);
  assert.match(view.textContent ?? "", /2 hidden \(git's own files, secrets files\)/);

  const fullButton = view.querySelector('[aria-label="Full screen"]') as HTMLButtonElement;
  await act(async () => fullButton.click());
  assert.match(view.className, /fixed inset-0/);
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  });
  assert.doesNotMatch(view.className, /fixed inset-0/, "Esc leaves full screen");
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});
