import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TEMPLATE_CARDS, templateDeskLayout } from "@ensemble/shared-types/manifest";
import { api } from "@/lib/api";
import { sampleLive } from "../onboarding/sample";
import { ROLES } from "../onboarding/roles";
import { AddTileDialog } from "./add-tile";
import { PreviewTiles, specPool } from "./live-board";
import { deskRole, tileFitsRole } from "./tile-catalog";
import { byUrgency, datedItems, dayLabel, isLate, mockScores, ratio, taskSegments, timeSegments, weekAhead } from "./tile-data";
import { TileVisuals } from "./tile-visuals";

(globalThis as { React?: typeof React }).React = React;
const date = new Date("2026-10-11T09:00:00Z");

test("each profile has six distinct, role-relevant designs with static, truthful previews", () => {
  for (const role of ROLES) {
    const cards = TEMPLATE_CARDS.filter((c) => c.role === role.id);
    assert.ok(cards.length >= 5, role.id);
    assert.equal(new Set(cards.map((c) => JSON.stringify(c.tiles))).size, cards.length);
    assert.ok(new Set(cards.map((c) => c.tiles[0]![0])).size >= 5, `${role.id}: distinct leading tiles`);
    for (const c of cards) {
      for (const [key] of c.tiles) {
        assert.ok(specPool().has(key), `${c.id}: ${key}`);
        assert.ok(tileFitsRole(key, role.id), `${c.id}: irrelevant ${key}`);
      }
      const html = renderToStaticMarkup(<PreviewTiles deskId={c.desk} tiles={c.tiles} live={sampleLive(role.id, null, date)} />);
      assert.ok(!html.includes("NaN"), c.id);
      assert.ok(!/<button|<select|<a\s/.test(html), `${c.id}: thumbnail nested controls`);
      assert.ok((html.match(/data-visual=/g) ?? []).length >= 2, c.id);
    }
  }
});

test("profile filtering excludes foreign-domain tiles and keeps the account profile on a layout change", () => {
  for (const role of ["engineer", "vibe", "manager"] as const) {
    for (const key of ["hearings", "limitation", "periods", "marking"]) assert.equal(tileFitsRole(key, role), false, `${role}: ${key}`);
  }
  assert.equal(tileFitsRole("reviews", "lawyer"), false);
  assert.equal(tileFitsRole("hearings", "lawyer"), true);
  assert.equal(deskRole("chambers", "branch-desk"), "engineer");
  assert.equal(deskRole("literature", "thesis-year"), "student");
  for (const role of ROLES) for (const key of ["calendar", "progress", "due-week"]) assert.ok(tileFitsRole(key, role.id));
});

test("sample tasks and citations do not cross professional domains", () => {
  for (const role of ROLES.filter((r) => r.id !== "lawyer")) {
    const live = sampleLive(role.id, null, date);
    assert.ok(!live.tasks.some((t) => ["hearing", "matter", "filing", "draft"].includes(t.taskType!)));
    assert.doesNotMatch(JSON.stringify(live.tasks), /Shah v\.|Lease review|Donoghue/);
    assert.doesNotMatch(JSON.stringify(live.citations), /Lease|Clause/);
  }
});

test("charts use counts, real denominators, zero values and recorded time", () => {
  const live = sampleLive("student", null, date);
  live.tasks = live.tasks.slice(0, 5).map((t, i) => ({ ...t, taskType: "task", status: ["done", "in_progress", "todo", "blocked", "dropped"][i]! }));
  assert.deepEqual(taskSegments(live).map((s) => s.value), [1, 1, 1, 1]);
  assert.equal(ratio(0, 10), 0);
  assert.equal(ratio(24, 26), 24 / 26 * 100);
  assert.equal(ratio(10, 0), 0);
  const mock = { ...live.tasks[0]!, taskType: "mock", status: "done", measure: 0, weight: 200 };
  live.tasks.push(mock);
  assert.equal(mockScores(live)[0]!.value, 0);
  assert.equal(taskSegments(live)[0]!.value, 1, "a score log is not a completed work item");
  live.tasks = [{ ...mock, taskType: "time", title: "Calculus", measure: 90 }, { ...mock, id: "second", taskType: "time", title: "Calculus", measure: 30 }];
  assert.deepEqual(timeSegments(live).map((s) => [s.label, s.value]), [["Calculus", 2]]);
});

test("calendar deduplicates a countdown of an existing task, sorts dates and omits completed work", () => {
  const live = sampleLive("engineer", null, date);
  live.tasks = [{ ...live.tasks[0]!, id: "a", title: "Release", due: "2026-10-14", status: "todo" }, { ...live.tasks[0]!, id: "b", title: "Finished", due: "2026-10-12", status: "done" }];
  live.countdowns = [{ id: "a", title: "Release", due: "2026-10-14", days: 3 }];
  live.deliverables = []; live.reminders = [];
  assert.deepEqual(datedItems(live).map((r) => r.title), ["Release"]);
});

test("Today counts overdue work, dates it with a year when needed, and marks it overdue", () => {
  const live = sampleLive("student", null, date);
  live.today = "2026-10-11";
  const base = live.tasks[0]!;
  live.tasks = [
    { ...base, id: "late", title: "Essay draft", status: "todo", taskType: "task", due: "2026-01-01" },
    { ...base, id: "old", title: "Lab write-up", status: "in_progress", taskType: "task", due: "2025-12-01" },
    { ...base, id: "soon", title: "Problem set", status: "todo", taskType: "task", due: "2026-10-13" },
    { ...base, id: "done", title: "Finished", status: "done", taskType: "task", due: "2026-01-02" },
    { ...base, id: "loose", title: "Undated", status: "todo", taskType: "task", due: null },
  ];
  live.deliverables = []; live.reminders = []; live.countdowns = [];
  const week = weekAhead(live);
  assert.equal(week.overdue, 2);
  assert.equal(week.days.reduce((sum, day) => sum + day.value, 0), 1);
  assert.equal(dayLabel("2026-01-01", live.today), "1 Jan");
  assert.equal(dayLabel("2025-12-01", live.today), "1 Dec 2025");
  assert.equal(isLate(live.tasks[0]!, live.today), true);
  assert.equal(isLate(live.tasks[3]!, live.today), false, "done work is not overdue");
  assert.deepEqual(byUrgency(live.tasks).map((task) => task.id), ["old", "late", "done", "soon", "loose"]);
  const weekHtml = renderToStaticMarkup(<TileVisuals spec={specPool().get("due-week")!} live={live} />);
  assert.match(weekHtml, /due or overdue/);
  assert.match(weekHtml, /2 overdue/);
  const plan = specPool().get("plan")!;
  const planHtml = renderToStaticMarkup(<TileVisuals spec={plan} live={live} />);
  assert.match(planHtml, /1 Dec 2025/);
  assert.match(planHtml, /Overdue/);
  assert.match(planHtml, /title="Lab write-up"/, "long titles have a full-title hover");
  live.tasks = [{ ...base, id: "read", title: "Pneumonoultramicroscopicsilicovolcanoconiosis", status: "todo", taskType: "reading", due: "2026-10-20" }];
  const readingHtml = renderToStaticMarkup(<TileVisuals spec={specPool().get("reading")!} live={live} />);
  assert.match(readingHtml, /20 Oct/, "the reading card shows its date");
});

test("the gallery previews without writes, adds once, and keeps failures recoverable", async () => {
  const oldPut = api.putPreference;
  const oldPrefs = api.preferences;
  const writes: Array<{ key: string; value: unknown }> = [];
  let fail = false;
  api.putPreference = async (key, value) => {
    writes.push({ key, value });
    if (fail) throw new Error("Save failed. Try again.");
    return { preference: { id: key, key, value, source: "explicit", confidence: 1, evidence: [] } } as Awaited<ReturnType<typeof api.putPreference>>;
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity }, mutations: { gcTime: Infinity } } });
  client.setQueryData(["shell"], { onboardingTemplateId: "branch-desk", modules: "all" });
  const baseline = templateDeskLayout("branch-desk")!;
  client.setQueryData(["preferences"], { preferences: [{ key: baseline.key, value: baseline.value }] });
  api.preferences = async () => client.getQueryData<Awaited<ReturnType<typeof api.preferences>>>(["preferences"])!;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const click = async (node: Element | null) => { assert.ok(node); await act(async () => { (node as HTMLElement).click(); }); };
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AddTileDialog deskId="branch" onClose={() => {}} /></QueryClientProvider>));
    assert.equal(document.querySelector('[data-gallery-tile="hearings"]'), null);
    await click(document.querySelector('[data-gallery-tile="calendar"]'));
    assert.ok(document.querySelector('[data-visual="calendar"]'));
    await click(document.querySelector('[aria-label="Next month"]'));
    assert.equal(writes.length, 0, "preview actions never write sample data");
    const add = () => [...document.querySelectorAll("button")].find((b) => /Add to Today/.test(b.textContent || ""))!;
    await click(add());
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.key, baseline.key);
    assert.ok((writes[0]!.value as { tiles: Array<{ key: string }> }).tiles.some((t) => t.key === "calendar"));
    assert.match(document.querySelector('[role="status"]')!.textContent!, /Calendar added/);
    assert.equal([...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "On Today")?.disabled, true);
    await click(document.querySelector('[data-gallery-tile="time-split"]'));
    fail = true;
    await click(add());
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /Save failed/);
    assert.equal(add().disabled, false);
  } finally {
    await act(async () => root.unmount()); host.remove(); client.clear(); api.putPreference = oldPut; api.preferences = oldPrefs;
  }
});

import { ProposalsWidget } from "../today/proposals-widget";
import { Settings } from "@ensemble/shared-types";
import type { TaskRecord } from "@/lib/api";

test("the live Today proposal inbox handles M/A/L/D and uses the saved default profile", async () => {
  const task = { id: "proposal", title: "Review the proposed roadmap", status: "proposed", snoozedUntil: null, rationale: "A review was requested." } as TaskRecord;
  const settings = Settings.parse({ runProfiles: [{ id: "writing", name: "Writing", kind: "research", engine: "ensemble", model: "anthropic::claude-sonnet-5-5", network: false }], defaultRunProfileId: "writing" });
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ path, body });
    const result = path === "/api/settings" ? { settings } : path === "/api/devices" ? { devices: [], serverRunner: true } : path === "/api/tasks" ? { tasks: [task] } : { jobId: "job", undoEntryId: "undo-proposal" };
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  client.setQueryData(["tasks"], { tasks: [task] });
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  const press = async (key: string) => { await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 30)); }); };
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><ProposalsWidget /></QueryClientProvider>));
    await press("m");
    assert.ok(calls.some((call) => call.path === "/api/tasks/proposal" && call.body.owner === "me" && call.body.status === "todo"));
    await press("l");
    const later = calls.find((call) => call.path === "/api/tasks/proposal" && call.body.snoozedUntil)?.body.snoozedUntil;
    assert.ok(typeof later === "string" && new Date(later).getTime() > Date.now());
    await press("d");
    assert.ok(calls.some((call) => call.body.status === "dropped"));
    await press("a");
    const assigned = calls.find((call) => call.path === "/api/agent/assign")?.body;
    assert.equal(assigned?.model, "claude-sonnet-5-5");
    assert.equal(assigned?.provider, "anthropic");
    assert.equal(assigned?.network, false);
    const modal = document.createElement("div"); modal.dataset.modalLayer = "test"; document.body.appendChild(modal);
    const count = calls.length; await press("m"); assert.equal(calls.length, count); modal.remove();
  } finally { await act(async () => root.unmount()); client.clear(); host.remove(); globalThis.fetch = realFetch; }
});
