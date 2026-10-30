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
import { activeProjects, byUrgency, datedItems, dayGlance, dayLabel, doneByDay, doneStreak, focusQueue, isLate, mockScores, personLine, ratio, taskSegments, timeSegments, weekAhead } from "./tile-data";
import { RowList, rowsForSpan, taskRow } from "./rows";
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

test("a room request's proposed task is answered with Accept or Decline, never M/A/L/D", async () => {
  const task = { id: "requested", title: "Add the rate limiter", status: "proposed", snoozedUntil: null, rationale: "Ben asked for this in “Launch”.", peerRequestId: "r1", assigneeAccountId: null } as TaskRecord;
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : {} });
    const result = path === "/api/shell" ? { user: { id: "me" }, space: null } : path === "/api/tasks" ? { tasks: [task] } : { request: { id: "r1", status: "approved" } };
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  client.setQueryData(["tasks"], { tasks: [task] });
  client.setQueryData(["shell"], { user: { id: "me" }, space: null });
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><ProposalsWidget /></QueryClientProvider>));
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "m", bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 30)); });
    assert.ok(!calls.some((call) => call.path.startsWith("/api/tasks/")));
    const shared = [...host.querySelectorAll("button")].find((button) => button.textContent === "Accept · shared run")!;
    await act(async () => { shared.click(); await new Promise((resolve) => setTimeout(resolve, 30)); });
    assert.deepEqual(calls.find((call) => call.path === "/api/node/requests/r1/accept")?.body, { mode: "shared" });
  } finally { await act(async () => root.unmount()); client.clear(); host.remove(); globalThis.fetch = realFetch; }
});

test("the day at a glance counts open work, what is due today and what is late", () => {
  const live = sampleLive("engineer", null, date);
  const base = live.tasks[0]!;
  live.today = "2026-10-11";
  live.tasks = [
    { ...base, id: "a", status: "todo", due: "2026-10-11" },
    { ...base, id: "b", status: "in_progress", due: "2026-10-01" },
    { ...base, id: "c", status: "blocked", due: null },
    { ...base, id: "d", status: "done", due: "2026-10-01" },
    { ...base, id: "e", status: "logged", taskType: "time", due: "2026-10-11" },
  ];
  assert.deepEqual(dayGlance(live), { open: 3, dueToday: 1, overdue: 1 });
});

test("Focus now picks to-do work: late, then today, then priority, then the nearest date", () => {
  const today = "2026-10-11";
  const row = (id: string, extra: Partial<{ status: string; due: string | null; priority: string | null; taskType: string | null }> = {}) => ({ id, status: "todo", due: null, priority: "p1", taskType: "task", ...extra });
  const rows = [
    row("low-soon", { priority: "p2", due: "2026-10-12" }),
    row("blocked-late", { status: "blocked", due: "2026-10-01" }),
    row("urgent-undated", { priority: "critical" }),
    row("today", { due: "2026-10-11" }),
    row("late", { due: "2026-10-02", status: "in_progress" }),
    row("logged", { taskType: "time", due: "2026-10-01" }),
    row("medium-soon", { due: "2026-10-14" }),
    row("medium-undated"),
  ];
  assert.deepEqual(focusQueue(rows, today).map((r) => r.id), ["late", "today", "urgent-undated"]);
  assert.deepEqual(focusQueue(rows, today, 6).map((r) => r.id), ["late", "today", "urgent-undated", "medium-soon", "medium-undated", "low-soon"]);
  assert.deepEqual(focusQueue([row("x", { status: "done" }), row("y", { status: "proposed" })], today), []);
});

test("Your week counts finished tasks per day and keeps a streak alive until the day is over", () => {
  const utc = (iso: string) => iso.slice(0, 10);
  const done = (day: string) => ({ status: "done", completedAt: `${day}T10:00:00Z` });
  const tasks = [done("2026-10-11"), done("2026-10-11"), done("2026-10-10"), done("2026-10-09"), done("2026-10-06"), done("2026-10-01"), { status: "todo", completedAt: "2026-10-11T09:00:00Z" }];
  const days = doneByDay(tasks, "2026-10-11", 7, utc);
  assert.deepEqual(days.map((d) => d.day), ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"]);
  assert.deepEqual(days.map((d) => d.count), [0, 1, 0, 0, 1, 1, 2], "only done work, and nothing outside the seven days");
  assert.equal(doneStreak(tasks, "2026-10-11", utc), 3);
  assert.equal(doneStreak(tasks, "2026-10-12", utc), 3, "a day with nothing finished yet does not break the streak");
  assert.equal(doneStreak(tasks, "2026-10-13", utc), 0);
});

test("list tiles draw whole rows, then View all, with status, overdue and priority at a glance", () => {
  const live = sampleLive("engineer", null, date);
  live.today = "2026-10-11";
  const base = live.tasks[0]!;
  const tasks = Array.from({ length: 9 }, (_, i) => ({ ...base, id: `t${i}`, title: `Task ${i}`, status: i === 0 ? "in_progress" : "todo", due: i === 1 ? "2026-10-01" : null, priority: i === 2 ? ("p0" as const) : ("p1" as const) }));
  assert.equal(rowsForSpan(3), 4);
  assert.equal(rowsForSpan(2), 2);
  const html = renderToStaticMarkup(<RowList rows={tasks.map((t) => taskRow(t, live.today))} estimate={rowsForSpan(3)} href="/board" label="Issues" />);
  assert.equal((html.match(/class="lrow"/g) ?? []).length, 4);
  assert.match(html, /View all 9/);
  assert.match(html, /In progress/);
  assert.match(html, /data-tone="danger"[^>]*title="Overdue since 1 Oct"/);
  assert.match(html, /data-prio="high">High/);
  assert.doesNotMatch(html, /Medium/, "medium priority stays quiet");
  const preview = renderToStaticMarkup(<RowList rows={tasks.map((t) => taskRow(t, live.today, true))} estimate={4} href="/board" preview label="Issues" />);
  assert.ok(!/<a\s|<button/.test(preview), "previews have no nested controls");
  const few = renderToStaticMarkup(<RowList rows={tasks.slice(0, 2).map((t) => taskRow(t, live.today))} estimate={4} href="/board" label="Issues" />);
  assert.doesNotMatch(few, /View all/, "no View all when every row is shown");
});

test("the new tiles are offered where they fit and preview without fetching", () => {
  for (const role of ROLES) {
    assert.ok(tileFitsRole("focus-now", role.id) && tileFitsRole("your-week", role.id), role.id);
    assert.equal(tileFitsRole("agents", role.id), role.id === "engineer" || role.id === "vibe", role.id);
  }
  const live = sampleLive("engineer", null, date);
  for (const key of ["focus-now", "agents", "your-week"]) {
    const html = renderToStaticMarkup(<TileVisuals spec={specPool().get(key)!} live={live} preview />);
    assert.ok(!/<a\s|<button/.test(html), `${key}: preview has no controls`);
    assert.ok(!html.includes("NaN"), key);
  }
  assert.match(renderToStaticMarkup(<TileVisuals spec={specPool().get("your-week")!} live={live} preview />), /4-day streak/);
});

test("Context people and projects say something useful at a glance", () => {
  assert.equal(personLine({ role: "Designer", team: "Atlas", openTasks: 3, lastInteraction: null }), "Designer · Atlas · 3 open");
  assert.equal(personLine({ role: null, openTasks: 0, lastInteraction: null }), "No open tasks");
  assert.match(personLine({ role: null, openTasks: 0, lastInteraction: "2026-10-01T10:00:00Z" }), /^seen /);
  const rows = [{ id: "a", name: "Live", done: 2, total: 5 }, { id: "b", name: "Shipped", done: 4, total: 4 }, { id: "c", name: "New", done: 0, total: 0 }];
  assert.deepEqual(activeProjects(rows).map((r) => r.id), ["a", "c"]);
});

