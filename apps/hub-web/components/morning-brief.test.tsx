/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "./ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { DEFAULT_SETTINGS } from "@ensemble/shared-types";
import { MorningBrief } from "./widgets/glances";
import { RoutinesPage } from "./routines/routines-page";
import { NotificationsTab } from "./settings/tab-notifications";
import { ToastProvider } from "./toast";
import type { Routine } from "@/lib/api";

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "self", { configurable: true, value: window });
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value() {} });
const routine: Routine = { id: "brief-1", builtInKey: "morning-brief", title: "Morning brief", instruction: "Focus on my classes.", cron: "30 7 * * *", timezone: "UTC", when: "Every day at 07:30", status: "active", nextRunAt: null, lastRunAt: null, lastStatus: null, lastSummary: null, conversationId: null, runCount: 0, createdAt: new Date().toISOString() };

async function mount(node: React.ReactNode, data: { routine: Routine | null; enabled: boolean; brief: string | null }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  client.setQueryData(["morning-brief"], data);
  client.setQueryData(["routines"], { routines: data.routine ? [data.routine] : [], enabled: data.enabled, timezone: "UTC" });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<SearchParamsContext.Provider value={new URLSearchParams("routine=morning-brief")}><QueryClientProvider client={client}><ToastProvider>{node}</ToastProvider></QueryClientProvider></SearchParamsContext.Provider>));
  return { host, done: async () => { await act(async () => root.unmount()); host.remove(); client.clear(); } };
}

test("Today shows the full routine result independently of the unread bell", async () => {
  const body = "Your classes and priorities. ".repeat(30);
  const view = await mount(<MorningBrief size="m" />, { routine, enabled: true, brief: body });
  try {
    assert.match(view.host.textContent ?? "", /Your classes and priorities/);
    assert.equal(view.host.querySelector("p")?.textContent, body);
    assert.equal(view.host.querySelector("a")?.getAttribute("href"), "/routines?routine=brief-1");
    assert.equal(view.host.querySelector('[role="dialog"]'), null);
  } finally { await view.done(); }
});

test("Today explains paused, not-run, disabled and deleted briefs and points to routines", async () => {
  for (const [data, line] of [
    [{ routine: { ...routine, status: "paused" as const }, enabled: true, brief: "Older brief" }, "Morning brief is paused."],
    [{ routine, enabled: true, brief: null }, "Your first brief has not run yet."],
    [{ routine: { ...routine, lastStatus: "failed" as const }, enabled: true, brief: null }, "Your last brief did not finish."],
    [{ routine, enabled: false, brief: "Older brief" }, "Routines are off."],
    [{ routine: null, enabled: true, brief: null }, "Morning brief was deleted."],
  ] as const) {
    const view = await mount(<MorningBrief size="s" />, data);
    try {
      assert.ok(view.host.textContent?.includes(line));
      assert.doesNotMatch(view.host.textContent ?? "", /Older brief/);
      assert.ok(view.host.querySelector("a")?.getAttribute("href")?.startsWith("/routines"));
    } finally { await view.done(); }
  }
});

test("a brief deep link focuses its normal editable routine; Settings has no separate brief controls or routine model picker", async () => {
  const view = await mount(<><RoutinesPage /><NotificationsTab settings={DEFAULT_SETTINGS} patch={() => {}} /></>, { routine, enabled: true, brief: null });
  try {
    assert.equal(view.host.querySelector('[data-focused="true"] h3')?.textContent, "Morning brief");
    assert.equal(view.host.querySelector('[aria-label="Morning brief time"]'), null);
    assert.equal(view.host.querySelector('[aria-label="Morning brief"]'), null);
    const edit = [...view.host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Edit");
    assert.ok(edit);
    await act(async () => edit.click());
    assert.equal(view.host.querySelector<HTMLTextAreaElement>("textarea")?.value, routine.instruction);
    assert.equal(view.host.querySelector('[aria-label="Time"]') !== null, true);
    assert.equal(view.host.querySelector('[aria-label*="model" i]'), null);
    assert.equal(view.host.querySelector('[aria-label*="provider" i]'), null);
  } finally { await view.done(); }
});
