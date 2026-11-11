import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AssistantToolCallRecord } from "@/lib/api";
import { foldRuns, stepsLine, toolLabel, ToolProposals, ToolSteps } from "./tool-calls.js";

Object.defineProperty(globalThis, "self", { configurable: true, value: window });

const read = (id: string, summary: string): AssistantToolCallRecord => ({ id, name: "hub_list_tasks", state: "ok", isWrite: false, summary });

test("a tool name reads as a verb and what it acts on", () => {
  assert.equal(toolLabel("hub_list_tasks"), "List tasks");
  assert.equal(toolLabel("hub_create_project"), "Create project");
  assert.equal(toolLabel("calendar_create_event"), "Create Calendar event");
  assert.equal(toolLabel("docs_create"), "Create Google Doc");
  assert.equal(toolLabel("gmail_search"), "Search Gmail");
  assert.equal(toolLabel("hub_web_search"), "Search the web");
  assert.equal(toolLabel("mcp_linear_create_issue"), "Create issue · Linear");
});

test("runs of three or more finished reads fold into one line once a reply has more than four steps", () => {
  const few = [read("a", "A"), read("b", "B"), read("c", "C"), read("d", "D")];
  assert.deepEqual(foldRuns(few).map((row) => row.kind), ["call", "call", "call", "call"], "four steps stay as they are");
  const write: AssistantToolCallRecord = { id: "w", name: "hub_create_tasks", state: "ok", isWrite: true, summary: "Added 1 task." };
  const failed: AssistantToolCallRecord = { id: "f", name: "docs_create", state: "failed", isWrite: true, error: "Google Docs refused the request." };
  const rows = foldRuns([read("a", "A"), read("b", "B"), read("c", "C"), write, read("d", "D"), read("e", "E"), failed]);
  assert.deepEqual(rows.map((row) => (row.kind === "run" ? `run:${row.calls.length}` : row.call.id)), ["run:3", "w", "d", "e", "f"], "writes and failures keep their own line; a run of two is not folded");
  assert.equal(stepsLine([read("a", "A"), write, failed, { ...write, id: "u", state: "undone" }]), "4 steps · 1 change · 1 undone · 1 failed");
});

async function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const client = new QueryClient();
  await act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
  return {
    host,
    click: async (element: Element) => act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); }),
    done: async () => { await act(async () => root.unmount()); host.remove(); client.clear(); },
  };
}

test("proposals sit apart from finished steps and say nothing has changed yet", async () => {
  const calls: AssistantToolCallRecord[] = [
    read("r1", "Found 4 people on Launch."),
    { id: "p1", name: "hub_create_project", state: "awaiting_approval", isWrite: true, summary: "Create project “Launch”\n- lead: Mira Chen", input: { name: "Launch" } },
    { id: "p2", name: "calendar_create_event", state: "awaiting_approval", isWrite: true, summary: "Create event “Design review”", input: { title: "Design review" } },
  ];
  const view = await render(<><ToolSteps calls={calls} conversationId="conv" /><ToolProposals calls={calls} conversationId="conv" /></>);
  try {
    const card = view.host.querySelector(".tool-proposals")!;
    assert.match(card.textContent ?? "", /2 proposed changes/);
    assert.match(card.textContent ?? "", /Nothing changes until you apply/);
    assert.match(card.textContent ?? "", /lead:?Mira Chen/, "a proposal's fields show before Apply");
    const buttons = [...card.querySelectorAll("button")].map((button) => button.textContent);
    assert.deepEqual(buttons.filter((text) => /^Apply/.test(text ?? "")), ["Apply all", "Apply", "Apply"]);
    const steps = view.host.querySelector(".assistant-activity")!;
    assert.equal(steps.textContent?.includes("Create project"), false, "a proposal is not a finished step");
    assert.match(steps.querySelector("summary")?.textContent ?? "", /^1 step$/);
  } finally {
    await view.done();
  }
});

test("a failed step says what failed and why, opened; details name the tool but not raw ids", async () => {
  const id = "3f2a9c1e-7b44-4d2a-9a51-0c8f5e6d7b10";
  const calls: AssistantToolCallRecord[] = [
    read("a", "Found 6 results."),
    read("b", "Read “Launch plan”."),
    read("c", "Found 12 open tasks."),
    read("d", "Found 4 people."),
    { id: "w", name: "hub_update_task", state: "ok", isWrite: true, summary: "Updated “Draft brief”.", input: { id, status: "done" }, refs: [{ kind: "task", id, label: "Draft brief" }] },
    { id: "x", name: "hub_update_task", state: "ok", isWrite: true, summary: "Updated a task.", input: { taskId: "t-unknown", status: "open" } },
    { id: "f", name: "docs_create", state: "failed", isWrite: true, error: "Google Docs refused the request (HTTP 500): Backend error.", input: { title: "Brief" } },
  ];
  const view = await render(<ToolSteps calls={calls} conversationId="conv" />);
  try {
    const details = view.host.querySelector("details")!;
    assert.equal(details.open, true, "a reply with a failed step opens its steps");
    assert.match(details.querySelector("summary")?.textContent ?? "", /7 steps · 2 changes · 1 failed/);
    const failed = view.host.querySelector('[data-tool-state="failed"]')!;
    assert.match(failed.textContent ?? "", /Create Google Doc/);
    assert.match(failed.textContent ?? "", /Failed/);
    assert.match(failed.textContent ?? "", /Backend error/);
    const run = view.host.querySelector(".tool-run button")!;
    assert.match(run.textContent ?? "", /4 steps/);
    await view.click(run);
    assert.equal(view.host.querySelector(".tool-run"), null, "the folded run opens in place");
    assert.equal(view.host.querySelectorAll(".assistant-tool").length, 7);
    const update = [...view.host.querySelectorAll(".assistant-tool")].find((row) => /Updated “Draft brief”/.test(row.textContent ?? ""))!;
    const toggle = update.querySelector<HTMLButtonElement>("button.tool-main")!;
    assert.equal(update.querySelector<HTMLElement>(".tool-details")!.hidden, true);
    await view.click(toggle);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    const shown = update.querySelector<HTMLElement>(".tool-details")!;
    assert.equal(shown.hidden, false);
    assert.match(shown.textContent ?? "", /“Draft brief”/, "a known id shows as its title");
    assert.match(shown.textContent ?? "", /hub_update_task/);
    assert.equal(shown.textContent?.includes(id), false);
    const other = [...view.host.querySelectorAll(".assistant-tool")].find((row) => /Updated a task/.test(row.textContent ?? ""))!;
    assert.equal(other.textContent?.includes("t-unknown"), false, "an unknown id is left out");
  } finally {
    await view.done();
  }
});

test("a live turn shows its steps open, with the step in progress last", async () => {
  const view = await render(<ToolSteps live calls={[read("a", "Found 3 events on Friday.")]} conversationId="conv" running="Reading Calendar…" />);
  try {
    assert.equal(view.host.querySelector("details"), null);
    const rows = [...view.host.querySelectorAll(".tool-row")];
    assert.equal(rows.length, 2);
    assert.match(rows[1]!.textContent ?? "", /Reading Calendar…/);
    assert.equal(rows[1]!.getAttribute("data-tool-state"), "running");
  } finally {
    await view.done();
  }
});
