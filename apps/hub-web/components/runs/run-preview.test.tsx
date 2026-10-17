import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RunDetail, RunJob } from "@/lib/api";
import { RunPreview } from "./run-preview.js";

// next/link schedules its prefetch with self.requestIdleCallback.
Object.defineProperty(globalThis, "self", { configurable: true, value: window });

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 14, 10, 0, seconds)).toISOString();

const run: RunDetail = {
  id: "run-1",
  taskId: "task-1",
  worker: "workspace",
  outcome: "success",
  result: "## Summary\n\n| Part | What |\n| --- | --- |\n| tracer | hooks fetch |",
  error: null,
  startedAt: at(0),
  endedAt: at(20),
  plannerModel: null,
  requestedModel: "mai-code-1.1-flash",
  task: { id: "task-1", title: "Summarise the rea repo" },
  steps: [
    { id: "s0", index: 0, title: "Thinking", status: "done", output: null, error: null, reasoning: "Clone it first.", model: null, credits: null, toolCalls: [], startedAt: at(1), endedAt: at(1) },
    {
      id: "s1",
      index: 1,
      title: "$ git clone https://github.com/morluto/rea",
      status: "done",
      output: "Cloning…",
      error: null,
      model: null,
      credits: null,
      toolCalls: [{ id: "t1", name: "Bash", args: '{"command":"git clone https://github.com/morluto/rea"}', output: "Done: Ensemble cloned it into rea/.", ok: true, ms: 3200, engine: "claude-code" }],
      startedAt: at(2),
      endedAt: at(6),
    },
    { id: "s2", index: 2, title: "Result", status: "done", output: "Wrote REA_SUMMARY.md", error: null, model: "gemini-2.5-flash", credits: null, toolCalls: [], startedAt: at(19), endedAt: at(19) },
  ],
};

const job: RunJob = {
  id: "job-1",
  kind: "code",
  status: "succeeded",
  engine: "ensemble",
  engineName: "Ensemble agent",
  provider: "copilot",
  model: "mai-code-1.1-flash",
  modelUsed: "gemini-2.5-flash",
  reasoningEffort: null,
  where: "device",
  deviceName: "Akash's MacBook",
  runnerAccountId: null,
  sandbox: true,
  networkAccess: true,
  delivery: "local",
  accessMode: "read-write",
  unattended: false,
  folder: "rea-run",
  repoUrl: null,
  branch: null,
  turns: 4,
  toolCalls: 1,
  tokensIn: 1200,
  tokensOut: 300,
  limits: { turns: 40, toolCalls: 80, minutes: 60 },
  costUsd: 0.0123,
  files: [{ path: "REA_SUMMARY.md", added: 40, removed: 0 }],
  results: [],
  createdAt: at(0),
  startedAt: at(0),
  finishedAt: at(20),
};

test("a run opens on Results with three tabs: facts, timeline with tool timings, result as Markdown, and the task one click away", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity }, mutations: {gcTime:Infinity} } });
  client.setQueryData(["run", "run-1"], { run, job });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let closed = 0;
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <RunPreview runId="run-1" onClose={() => (closed += 1)} />
      </QueryClientProvider>,
    );
  });
  const sheet = document.querySelector('[role="dialog"]') as HTMLElement;
  assert.ok(sheet, "the preview opens as a dialog");
  const tabs = [...sheet.querySelectorAll('[role="tab"]')];
  assert.deepEqual(tabs.map(tab => tab.textContent?.replace(/\d+$/,"")),["Results","Files","Traces"]);
  assert.ok(sheet.querySelector("table"), "Results is open by default");
  await act(async () => (tabs[2] as HTMLButtonElement).click());
  const text = sheet.textContent ?? "";
  assert.match(text, /Summarise the rea repo/);
  assert.match(text, /Ensemble agent/);
  assert.match(text, /copilot/);
  assert.match(text, /mai-code-1\.1-flash/);
  assert.match(text, /gemini-2\.5-flash/, "the model that answered is shown");
  assert.ok(sheet.querySelector(".text-warn"), "an answer from another model than the one asked for is flagged");
  assert.match(text, /Bash/);
  assert.match(text, /3\.2s/, "each tool call shows its time");
  assert.match(text, /\$0\.012/);
  const open = [...sheet.querySelectorAll("a")].find((link) => /Open task/.test(link.textContent ?? ""));
  assert.equal(open?.getAttribute("href"), "/tasks/task-1");

  const resultTab = [...sheet.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "Results") as HTMLButtonElement;
  await act(async () => resultTab.click());
  assert.ok(sheet.querySelector("table"), "the result renders its Markdown table");

  const close = sheet.querySelector('[aria-label="Close"]') as HTMLButtonElement;
  await act(async () => close.click());
  assert.equal(closed, 1);
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});
