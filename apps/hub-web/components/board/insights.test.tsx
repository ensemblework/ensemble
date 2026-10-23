import "../ui-test-dom.js";
import React, { act, useState } from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, type TaskRecord } from "@/lib/api";
import { BoardInsights, InsightGallery, insightSamples } from "./insights";
import { completedDays, DEFAULT_INSIGHTS, INSIGHT_IDS, INSIGHTS_KEY, matchesFocus, MAX_INSIGHTS, ownerBucket, readInsightLayout, type InsightLayout } from "./insight-data";
import { InsightTile } from "./insight-tile";
import { BoardWidgets } from "./board-widgets";
import type { BoardPage, PageBoardRecord, PageBoardTile } from "@ensemble/shared-types";

(globalThis as { React?: typeof React }).React = React;
const now = new Date(2026, 9, 11, 12).getTime();
const who = { me: "member", ownerId: "owner" };
const base = insightSamples("engineer", new Date(now))[0]!;
const task = (extra: Partial<TaskRecord> = {}): TaskRecord => ({ ...base, id: "one", status: "todo", owner: "me", assigneeAccountId: null, updatedAt: new Date(now).toISOString(), ...extra });

test("custom board charts use that board's column names and counts, and tile changes are explicit", async () => {
  const board: PageBoardRecord = {
    id: "research", title: "Research", description: "", revision: 1, pageCount: 2, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    columns: [{ id: "experiment", name: "On-going experiments", color: "blue" }, { id: "results", name: "Results", color: "green" }], tiles: ["distribution", "flow"],
  };
  const pages: BoardPage[] = ["a", "b"].map((id) => ({ id, title: `Experiment ${id}`, kind: "page", columnId: "experiment", boardOrder: 0, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }));
  const changes: PageBoardTile[][] = [];
  const view = await mount(<BoardWidgets board={board} pages={pages} editable pending={false} onChange={(tiles) => changes.push(tiles)} />);
  try {
    assert.ok(view.host.querySelector('[role="img"][aria-label="On-going experiments: 2, Results: 0"]'));
    assert.equal(view.host.textContent?.includes("In progress"), false);
    await click(view.host.querySelector('[aria-label="Remove By column tile"]'));
    assert.deepEqual(changes, [["flow"]]);
  } finally { await view.done(); }
});

test("Me follows the viewer and assignment, including legacy shared tasks", () => {
  assert.equal(ownerBucket(task(), who), "team");
  assert.equal(ownerBucket(task({ assigneeAccountId: "member" }), who), "me");
  assert.equal(ownerBucket(task({ owner: "agent", assigneeAccountId: "member" }), who), "agent");
  assert.equal(ownerBucket(task({ owner: "unassigned" }), who), "unassigned");
  assert.equal(ownerBucket(task(), { me: null, ownerId: null }), "team");
  assert.equal(matchesFocus(task({ status: "done", assigneeAccountId: "member" }), { kind: "owner", value: "me" }, who, now), false);
});

test("stale, proposed, waiting and due views use actual task state", () => {
  const old = task({ status: "in_progress", updatedAt: new Date(now - 8 * 86400000).toISOString() });
  assert.ok(matchesFocus(old, { kind: "stale" }, who, now));
  assert.ok(!matchesFocus({ ...old, status: "done" }, { kind: "stale" }, who, now));
  assert.ok(!matchesFocus(task(), { kind: "stale" }, who, now));
  assert.ok(matchesFocus(task({ status: "proposed" }), { kind: "ideas" }, who, now));
  assert.ok(matchesFocus(task({ status: "waiting_approval" }), { kind: "status", value: "waiting" }, who, now));
  assert.ok(matchesFocus(task({ due: "2026-10-01" }), { kind: "deadlines" }, who, now));
  assert.ok(!matchesFocus(task({ due: "2026-10-18" }), { kind: "deadlines" }, who, now));
  assert.ok(!matchesFocus(task({ status: "done", due: "2026-10-01" }), { kind: "deadlines" }, who, now));
});

test("completion total and daily chart cover the same seven calendar days", () => {
  const rows = [task({ id: "a", status: "done", completedAt: new Date(2026, 9, 5, 1).toISOString() }), task({ id: "b", status: "done", completedAt: new Date(2026, 9, 4, 23).toISOString() }), task({ id: "c", status: "done", completedAt: new Date(2026, 9, 11, 9).toISOString() }), task({ id: "d", status: "done", completedAt: new Date(2026, 9, 12, 9).toISOString() })];
  assert.equal(rows.filter((t) => matchesFocus(t, { kind: "done" }, who, now)).length, 2);
  assert.equal(completedDays(rows, now).reduce((sum, d) => sum + d.count, 0), 2);
});

test("layouts are bounded and every role has useful defaults", () => {
  for (const ids of Object.values(DEFAULT_INSIGHTS)) { assert.equal(ids.length, 3); assert.equal(new Set(ids).size, 3); assert.ok(ids.every((id) => INSIGHT_IDS.includes(id))); }
  assert.deepEqual(readInsightLayout({ v: 1, tiles: ["flow", "flow", "bad", "agent"], collapsed: true }, []), { v: 1, tiles: ["flow", "agent"], collapsed: true });
  assert.equal(readInsightLayout({ v: 1, tiles: INSIGHT_IDS }, []).tiles.length, MAX_INSIGHTS);
  assert.deepEqual(readInsightLayout({ v: 1, tiles: [] }, ["flow"]).tiles, []);
  assert.equal(readInsightLayout({ v: 1, tiles: [], wipCap: -10 }, []).wipCap, 1);
  assert.equal(readInsightLayout({ v: 1, tiles: [], wipCap: 999 }, []).wipCap, 50);
});

async function mount(node: React.ReactNode) {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(node));
  return { host, done: async () => { await act(async () => root.unmount()); host.remove(); } };
}
const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
async function click(node: Element | null) { assert.ok(node); await act(async () => (node as HTMLElement).click()); }

test("chart controls select a matching filter and toggle it off", async () => {
  const focuses: unknown[] = [];
  function Harness() { const [focus, setFocus] = useState<Parameters<typeof InsightTile>[0]["focus"]>(null); return <InsightTile id="flow" role="student" tasks={[task({ status: "done" }), task({ id: "b" })]} who={who} now={now} cap={3} focus={focus} onFocus={(f) => { focuses.push(f); setFocus(f); }} />; }
  const view = await mount(<Harness />);
  try { await click(button("Done1")); await click(button("Done1")); assert.deepEqual(focuses, [{ kind: "status", value: "done" }, null]); } finally { await view.done(); }
});

test("flow, WIP and the in-progress focus include blocked and approval work in the merged column", async () => {
  const rows = ["in_progress", "blocked", "waiting_approval", "done"].map((status, index) => task({ id: String(index), status: status as TaskRecord["status"] }));
  const view = await mount(<><InsightTile id="flow" role="engineer" tasks={rows} who={who} now={now} cap={3} onFocus={() => {}} /><InsightTile id="capacity" role="engineer" tasks={rows} who={who} now={now} cap={3} onFocus={() => {}} /></>);
  try {
    assert.ok(view.host.querySelector('[role="img"][aria-label="Planned: 0, In progress: 3, Done: 1"]'));
    assert.match(view.host.textContent ?? "", /25%/);
    assert.match(view.host.textContent ?? "", /3 \/ 3/);
    assert.deepEqual(rows.filter((row) => matchesFocus(row, { kind: "status", value: "in_progress" }, who, now)).map((row) => row.status), ["in_progress", "blocked", "waiting_approval"]);
  } finally { await view.done(); }
});

test("gallery previews never change layout and the four-tile limit is enforced", async () => {
  const changes: InsightLayout["tiles"][] = [];
  const view = await mount(<InsightGallery role="engineer" layout={{ v: 1, tiles: ["flow", "stale", "deadlines", "done"], collapsed: false }} cap={3} editable pending={false} error="" onChange={(tiles) => changes.push(tiles)} onReset={() => {}} onClose={() => {}} />);
  try {
    await click(document.querySelector('[data-insight-option="agent"]'));
    assert.equal(button("Add to board").disabled, true);
    await click(button("Focus this work")); assert.equal(changes.length, 0);
    await click(document.querySelector('[data-insight-option="flow"]')); await click(button("Remove tile"));
    assert.deepEqual(changes, [["stale", "deadlines", "done"]]);
  } finally { await view.done(); }
});

test("a shared viewer gets task insights without reading or writing private preferences", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  client.setQueryData(["shell"], { user: { id: "member" }, activeTemplateId: "mkt.branch-desk", space: { shared: { role: "viewer", owner: { name: "Owner" } } } });
  const oldPrefs = api.preferences, oldPut = api.putPreference; let reads = 0, writes = 0;
  api.preferences = async () => { reads++; return { preferences: [] }; };
  api.putPreference = async () => { writes++; throw new Error("not allowed"); };
  const view = await mount(<QueryClientProvider client={client}><BoardInsights tasks={[task()]} who={who} editing onEditingChange={() => {}} onOpen={() => {}} focus={null} onFocus={() => {}} /></QueryClientProvider>);
  try { assert.equal(reads, 0); assert.equal(button("Remove tile").disabled, true); await click(button("Board overview")); assert.equal(writes, 0); }
  finally { await view.done(); client.clear(); api.preferences = oldPrefs; api.putPreference = oldPut; }
});

test("failed overview saves keep the current layout, and retry succeeds", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  client.setQueryData(["shell"], { user: { id: "member" }, activeTemplateId: "mkt.branch-desk" });
  client.setQueryData(["preferences"], { preferences: [] });
  const oldPut = api.putPreference; let fail = true; const writes: unknown[] = [];
  api.putPreference = async (key, value) => { writes.push(value); if (fail) throw new Error("Save failed"); return { preference: { id: key, key, value, source: "explicit", evidence: [], confidence: 1 } }; };
  const view = await mount(<QueryClientProvider client={client}><BoardInsights tasks={[task()]} who={who} editing={false} onEditingChange={() => {}} onOpen={() => {}} focus={null} onFocus={() => {}} /></QueryClientProvider>);
  try {
    await click(button("Board overview"));
    assert.ok(document.querySelector('[data-board-insight="flow"]'));
    fail = false; await click(button("Board overview"));
    assert.equal(document.querySelector('[data-board-insight="flow"]'), null);
    assert.equal(writes.length, 2);
  } finally { await view.done(); client.clear(); api.putPreference = oldPut; }
});
